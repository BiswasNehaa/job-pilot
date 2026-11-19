// "Not interested" must mean the job never comes back, even though the job
// itself is deleted. Throwaway data folder, job sources stubbed: no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

process.env.JOBPILOT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'jobpilot-skip-'));
process.env.PORT = '0';
process.env.GROQ_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const db = require('../server/db');
const jobs = require('../server/jobs');
const job = () => ({ id: 'x1', source: 'Test', title: 'AI Engineer', company: 'Acme', location: 'Bengaluru',
  url: 'https://example.com/x', description: 'Python.', publishedAt: new Date().toISOString() });
jobs.searchJobs = async () => ({ jobs: [job()], source: 'Test', filtered: 0 });

const { app } = require('../server/index');
const { discover } = require('../server/discovery');

function del(server, id) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port, path: `/api/applications/${id}`, method: 'DELETE' },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end();
  });
}

test('a job marked Not interested is not added again by the next search', async () => {
  const d = db.load();
  d.profile = { name: 'Test', skills: ['Python'], years_experience: 0 };
  d.applications = [];
  db.save();

  await discover('AI Engineer');
  const added = db.load().applications;
  assert.strictEqual(added.length, 1);

  const server = app.listen(0);
  try {
    assert.strictEqual(await del(server, added[0].id), 200);
  } finally { server.close(); }
  assert.strictEqual(db.load().applications.length, 0);

  await discover('AI Engineer');
  assert.strictEqual(db.load().applications.length, 0, 'it stayed gone');
});
