// Is this job still open?
//
// Two moments use this:
//  - discovery: before a new job is added to the board, drop adverts that have
//    clearly closed (a stated deadline that has passed, a 404/410, or a page
//    that says it is closed), so nobody spends an application on them;
//  - just before an application goes out (verifyJobLive), in case the job
//    closed since it was found.
// Both err on the side of "open": only a clear signal drops a job. A bot wall,
// a timeout or a page we cannot read keeps it.

const DEAD_STATUS = new Set([404, 410]);
// Phrases job boards/ATSs show on a closed posting. Deliberately exact: live
// adverts say things like "Once the position is filled, we will close the
// advert", which a looser pattern would wrongly read as closed.
const DEAD_PATTERNS = /no longer accepting applications|this (job|position|posting|vacancy|role) (is no longer|has been) (available|active|filled|removed|closed)|this (job|position|posting|vacancy|role) is closed|position has been filled|job (has )?expired|posting (is )?(closed|expired|removed)|applications (are|have) (now )?closed|vacature is gesloten|this job has closed/i;

// Page text without scripts, styles and tags, so a phrase that only lives in
// a hidden template or a script string can't mark a live job as closed.
function visibleText(html) {
  return String(html || '')
    .slice(0, 400000)
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

// `reason` is shown to the person using JobPilot (in the message that appears
// when a send is stopped, and in the day's activity), so it is written as a
// short piece of plain English, never as a status code.
async function verifyJobLive(job, { timeoutMs = 12000 } = {}) {
  if (!job.url) return { live: true, reason: 'there was no advert to check' };
  try {
    const res = await fetch(job.url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobPilot/1.0)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (DEAD_STATUS.has(res.status)) return { live: false, reason: 'the advert has been taken down' };
    // Bot walls / rate limits (LinkedIn 999, Cloudflare 403/429) prove nothing
    if (!res.ok) return { live: true, reason: 'the site would not let us look' };
    if (DEAD_PATTERNS.test(visibleText(await res.text()))) {
      return { live: false, reason: 'the advert says the job has been filled or closed' };
    }
    return { live: true, reason: 'the advert is still up' };
  } catch (err) {
    return { live: true, reason: err.name === 'TimeoutError' ? 'the site did not answer in time' : 'we could not reach the site' };
  }
}

// ---------- Stated application deadlines ----------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const DEADLINE_WORDS = /(deadline|closing date|apply by|apply before|applications? close[sd]?(?: on)?|closes on|last date(?: to apply)?)\s*(?:is|date)?\s*[:\-–]?\s*/gi;
// Only unambiguous dates with a year: "16 Nov 2026", "Nov 16, 2026",
// "2026-11-16". Slashed dates (dd/mm vs mm/dd) are skipped on purpose.
const DATE_FORMS = [
  [new RegExp(`^(?:[a-z]+,?\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON},?\\s+(\\d{4})`, 'i'), m => [m[3], m[2], m[1]]],
  [new RegExp(`^(?:[a-z]+,?\\s+)?${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})`, 'i'), m => [m[3], m[1], m[2]]],
  [/^(\d{4})-(\d{2})-(\d{2})\b/, m => [m[1], MONTHS[Number(m[2]) - 1], m[3]]]
];

// The earliest application deadline stated in the text, as a Date (midnight
// UTC on that day), or null when there is none we can read for certain.
function statedDeadline(text) {
  const t = String(text || '');
  let earliest = null;
  DEADLINE_WORDS.lastIndex = 0;
  let k;
  while ((k = DEADLINE_WORDS.exec(t))) {
    const rest = t.slice(k.index + k[0].length, k.index + k[0].length + 40);
    for (const [re, parts] of DATE_FORMS) {
      const m = re.exec(rest);
      if (!m) continue;
      const [y, mon, d] = parts(m);
      const mi = MONTHS.indexOf(String(mon).toLowerCase().slice(0, 3));
      const year = Number(y), day = Number(d);
      if (mi < 0 || day < 1 || day > 31 || year < 2000 || year > 2100) break;
      const date = new Date(Date.UTC(year, mi, day));
      if (!earliest || date < earliest) earliest = date;
      break;
    }
  }
  return earliest;
}

// A whole extra day of grace, so time zones never close a job early.
function deadlinePassed(text, nowMs = Date.now()) {
  const d = statedDeadline(text);
  if (!d) return null;
  return nowMs > d.getTime() + 2 * 86400000 ? d : null;
}

// ---------- Discovery-time filter ----------

// Splits jobs into the ones to keep and the ones that have clearly closed,
// each dropped job with a plain-English reason. Page checks run a few at a
// time with a short timeout; anything uncertain is kept.
async function filterOpenJobs(jobs, { concurrency = 4, timeoutMs = 8000, checkPages = true } = {}) {
  const open = [];
  const dropped = [];
  const toCheck = [];
  for (const job of jobs) {
    const past = deadlinePassed(job.description);
    if (past) dropped.push({ job, reason: `its application deadline (${past.toISOString().slice(0, 10)}) has passed` });
    else toCheck.push(job);
  }
  if (!checkPages) return { open: toCheck, dropped };

  const verdicts = new Map();
  let next = 0;
  async function worker() {
    while (next < toCheck.length) {
      const job = toCheck[next++];
      verdicts.set(job, await verifyJobLive(job, { timeoutMs }));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, toCheck.length) }, worker));
  for (const job of toCheck) {
    const v = verdicts.get(job);
    if (v && !v.live) dropped.push({ job, reason: v.reason });
    else open.push(job);
  }
  return { open, dropped };
}

module.exports = { verifyJobLive, filterOpenJobs, statedDeadline, deadlinePassed, DEAD_PATTERNS, visibleText };
