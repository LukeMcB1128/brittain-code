const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Extract the detector functions verbatim from main.js by source slicing —
// they're plain, dependency-light functions, so this avoids needing to boot
// Electron/the full app just to unit-test the scanning logic itself.
const src = fs.readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8');
const { SELF_TALK } = require('../tools');
const start = src.indexOf('class PsychosisDetectedError');
const end = src.indexOf('// ---------- agent loop ----------');
// `class` (like let/const) is block-scoped even under direct eval, so it
// wouldn't survive past this eval call for later assertions to reference
// directly — converting the declaration to a `var`-assigned expression keeps
// identical runtime behavior (still `instanceof Error`) but makes the binding
// visible to the rest of this test file.
eval(src.slice(start, end).replace('class PsychosisDetectedError extends Error {', 'var PsychosisDetectedError = class extends Error {'));

test('psychosis: byte-fallback / replacement token triggers content scan', () => {
  const state = { value: 0 };
  const hit = scanContentForPsychosis('some code <0xC2><0xA0> more code', state);
  assert.ok(hit, 'expected a hit');
  assert.match(hit.reason, /byte-fallback/);

  const hit2 = scanContentForPsychosis('normal output with a � in it', { value: 0 });
  assert.ok(hit2);
});

test('psychosis: full-width punctuation adjacent to identifier triggers, prose does not', () => {
  // real observed case (fablereview.md): a full-width period corrupting an
  // identifier mid-name, e.g. getTitleFromContent -> getTitle．Content
  const hit = scanContentForPsychosis('const value = getTitle．Content(note);', { value: 0 });
  assert.ok(hit, 'expected the identifier-adjacent full-width period to trigger');
  assert.match(hit.reason, /full-width/);

  // full-width characters in legitimate CJK prose, not touching an identifier, must NOT trigger
  const clean = scanContentForPsychosis('This paragraph discusses Japanese punctuation （like this） in passing.', { value: 0 });
  assert.equal(clean, null);
});

test('psychosis: self-talk leaking into code comments triggers, real comments do not', () => {
  const leaked = scanContentForPsychosis('const x = 1;\n// Wait, I messed up the assignment above\nconst y = 2;', { value: 0 });
  assert.ok(leaked);
  assert.match(leaked.reason, /self-talk/);

  const real = scanContentForPsychosis('const x = 1;\n// Wait for the DB connection before querying\nconst y = 2;', { value: 0 });
  assert.equal(real, null);
});

test('psychosis: repetition loop is detected but throttled, and short output never false-positives', () => {
  const state = { value: 0 };
  const chunk = 'const thisIsARepeatedLineOfCodeThatKeepsComingBack = 1;\n';
  let content = '';
  let hit = null;
  // simulate streaming: feed the same chunk repeatedly, exactly like a degenerate model would
  for (let i = 0; i < 30 && !hit; i++) {
    content += chunk;
    hit = scanContentForPsychosis(content, state);
  }
  assert.ok(hit, 'expected repetition to eventually trigger');
  assert.match(hit.reason, /repetition/);

  // a short, non-repeating response must never trigger anything
  const short = scanContentForPsychosis('function add(a, b) { return a + b; }', { value: 0 });
  assert.equal(short, null);
});

test('psychosis: thinking-channel scan only checks glitch tokens, never self-talk (normal CoT is not psychosis)', () => {
  const normalReasoning = "Wait, let me reconsider. I think the bug is in the loop condition. Let me re-check the file.";
  assert.equal(scanThinkingForPsychosis(normalReasoning), null);

  const glitchy = 'The value should be getTitle．Content based on the pattern';
  const hit = scanThinkingForPsychosis(glitchy);
  assert.ok(hit);
  assert.match(hit.reason, /full-width/);
});

test('psychosis: PsychosisDetectedError carries reason as message and excerpt separately', () => {
  const err = new PsychosisDetectedError('repetition loop detected', 'const x = 1;');
  assert.equal(err.name, 'PsychosisDetectedError');
  assert.equal(err.message, 'repetition loop detected');
  assert.equal(err.excerpt, 'const x = 1;');
  assert.ok(err instanceof Error);
});
