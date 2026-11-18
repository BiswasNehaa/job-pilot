// "Is this job still open?" — deadline parsing, closed-page phrases, and the
// discovery-time filter. Uses a local HTTP server; nothing leaves the machine.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { statedDeadline, deadlinePassed, filterOpenJobs, DEAD_PATTERNS, visibleText } = require('../server/verify');

const NOW = Date.UTC(2026, 10, 18); // 18 Nov 2026

test('reads unambiguous deadlines and ignores vague ones', () => {
  assert.strictEqual(statedDeadline('Application deadline: 16 Nov 2026 23:59 CET').toISOString().slice(0, 10), '2026-11-16');
  assert.strictEqual(statedDeadline('Apply by November 30, 2026.').toISOString().slice(0, 10), '2026-11-30');
  assert.strictEqual(statedDeadline('Closing date: 2026-12-01').toISOString().slice(0, 10), '2026-12-01');
  assert.strictEqual(statedDeadline('Closing date: Friday 5th December 2026').toISOString().slice(0, 10), '2026-12-05');
  // Real live advert: "no deadline, rolling basis" must not be read as a date.
  assert.strictEqual(statedDeadline('There is no deadline for this role, as we recruit on a rolling basis.'), null);
  assert.strictEqual(statedDeadline('Deadline: 05/12/2026'), null); // dd/mm vs mm/dd: skipped
  assert.strictEqual(statedDeadline('We grew 300% until 2025'), null);
});

test('a deadline only counts as passed after a full day of grace', () => {
  assert.ok(deadlinePassed('deadline: 16 Nov 2026', NOW + 1));
  assert.strictEqual(deadlinePassed('deadline: 17 Nov 2026', NOW), null);
  assert.strictEqual(deadlinePassed('deadline: 30 Nov 2026', NOW), null);
});

test('closed-page phrases are exact enough not to catch live adverts', () => {
  assert.ok(DEAD_PATTERNS.test('This job is no longer accepting applications'));
  assert.ok(DEAD_PATTERNS.test('This position has been filled.'));
  assert.ok(DEAD_PATTERNS.test('Applications are now closed'));
  assert.ok(!DEAD_PATTERNS.test('Once the position is filled, we will close the advert.'));
  assert.ok(!DEAD_PATTERNS.test('Your session has expired cookies')); // "expired" alone is not enough
  assert.strictEqual(visibleText('<p>Open</p><script>"job has expired"</script>').trim(), 'Open');
});

test('filterOpenJobs drops closed adverts and keeps anything uncertain', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/gone') { res.statusCode = 410; return res.end(); }
    if (req.url === '/filled') return res.end('<h1>Sorry, this position has been filled</h1>');
    if (req.url === '/blocked') { res.statusCode = 403; return res.end(); }
    if (req.url === '/hidden') return res.end('<p>Apply now</p><script>t="this job has closed"</script>');
    return res.end('<h1>Apply now</h1><p>Once the position is filled, we will close the advert.</p>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const job = (id, path, description = '') => ({ id, url: `${base}${path}`, description });
  try {
    const { open, dropped } = await filterOpenJobs([
      job('live', '/live'),
      job('gone', '/gone'),
      job('filled', '/filled'),
      job('blocked', '/blocked'),
      job('hidden', '/hidden'),
      job('late', '/live', 'Application deadline: 1 Jan 2020'),
      { id: 'nourl', description: '' }
    ], { timeoutMs: 3000 });
    assert.deepStrictEqual(open.map(j => j.id).sort(), ['blocked', 'hidden', 'live', 'nourl']);
    const why = Object.fromEntries(dropped.map(d => [d.job.id, d.reason]));
    assert.match(why.gone, /taken down/);
    assert.match(why.filled, /filled or closed/);
    assert.match(why.late, /deadline \(2020-01-01\) has passed/);
  } finally {
    server.close();
  }
});
