// Seniority guard for job scoring: pure helpers, no server and no AI calls.
const test = require('node:test');
const assert = require('node:assert');

process.env.GROQ_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';

const { scoringHelpers: H } = require('../server/llm');

const blurb = 'About us. '.repeat(300); // ~3000 chars of company intro first

test('requiredYears reads years tied to experience, ignores other numbers', () => {
  assert.strictEqual(H.requiredYears('Have 5+ years of experience in professional software engineering'), 5);
  assert.strictEqual(H.requiredYears('Minimum 3 years in backend roles'), 3);
  assert.strictEqual(H.requiredYears('2-4 years of relevant experience; 6+ yrs experience preferred'), 6);
  assert.strictEqual(H.requiredYears('We were founded 10 years ago and serve 5 years of data'), null);
  assert.strictEqual(H.requiredYears('No experience needed'), null);
});

test('scoringDescription keeps experience lines that sit past the head', () => {
  const text = `${blurb}\nYou must have 5+ years of professional software engineering experience.\nNice to have: pgvector.`;
  const out = H.scoringDescription(text);
  assert.ok(out.length < text.length + 200);
  assert.match(out, /5\+ years of professional software engineering experience/);
  assert.doesNotMatch(out, /pgvector/);
  assert.strictEqual(H.scoringDescription('short ad'), 'short ad');
});

test('applySeniority caps over-senior roles and boosts early-career ones for a fresher', () => {
  const fresher = { years_experience: 0 };
  const supabase = { title: 'Software Engineer AI Tooling', description: `${blurb} Have 5+ years of professional software engineering experience.` };
  assert.strictEqual(H.applySeniority(fresher, supabase, { score: 84, reasons: [] }).score, 35);

  const staff = { title: 'Staff Forward Deployed Engineer', description: 'agents and evals' };
  assert.strictEqual(H.applySeniority(fresher, staff, { score: 62, reasons: [] }).score, 35);

  const grad = { title: 'Graduate Software Engineer (2027 start)', description: 'For final-year students.' };
  assert.strictEqual(H.applySeniority(fresher, grad, { score: 51, reasons: [] }).score, 61);

  const seniorGrad = { title: 'Senior Graduate Programme Lead', description: '' };
  assert.notStrictEqual(H.applySeniority(fresher, seniorGrad, { score: 50, reasons: [] }).score, 35);
});

test('applySeniority leaves scores alone when the profile has no years figure', () => {
  const job = { title: 'Senior Engineer', description: '8+ years of experience' };
  assert.strictEqual(H.applySeniority({}, job, { score: 80, reasons: [] }).score, 80);
  assert.strictEqual(H.applySeniority({ years_experience: 9 }, job, { score: 80, reasons: [] }).score, 80);
});

test('hasWord matches whole words only', () => {
  assert.ok(!H.hasWord('we use mongodb and google', 'go'));
  assert.ok(H.hasWord('written in go and rust', 'go'));
  assert.ok(H.hasWord('modern c++ codebase', 'c++'));
  assert.ok(!H.hasWord('object storage', 'rag'));
});
