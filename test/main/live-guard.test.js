const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const main = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');

// Rebuild the helper from source: it lives in main.js, which cannot be required
// outside Electron, but it is pure and worth testing on real inputs.
const withoutQuotedSpans = new Function(
  main.slice(main.indexOf('function withoutQuotedSpans'), main.indexOf('function scanContentForPsychosis'))
  + '; return withoutQuotedSpans;',
)();
const CONTEXT_RESET_RE = /\b(?:the user (?:has not|hasn't) (?:provided|asked|given) (?:anything|(?:a |any )?(?:specific )?(?:task|question|instructions?))|i should wait for (?:the user's )?(?:instructions|request))\b/i;
const fires = (text) => CONTEXT_RESET_RE.test(withoutQuotedSpans(text));

const thinkingGuard = new Function(
  'provider',
  'thinking',
  `var runtimeSettings = { provider };
   const RAW_CHANNEL_MARKER_RE = /$a/;
   const CONTEXT_RESET_RE = /$a/;
   const GLITCH_TOKEN_RE = /$a/;
   const GLITCH_FULLWIDTH_RE = /$a/;
   const withoutQuotedSpans = (value) => value;
   ${main.slice(main.indexOf('const DELIBERATION_RESTART_RE'), main.indexOf('// ---------- agent loop ----------'))}
   return scanThinkingForPsychosis(thinking);`,
);

test('explaining the guard does not trip the guard', () => {
  // This is the real failure: asked to explain main.js, the model described the
  // detector, quoted its trigger phrases, and was killed mid-sentence.
  assert.equal(fires('* Context loss ("the user hasn\'t asked anything")'), false);
  assert.equal(fires('matches `the user has not asked anything` in the output'), false);
  assert.equal(fires('```\nthe user hasn\'t asked anything\n```'), false);
});

test('a quote cut off by the stream still counts as quoted', () => {
  // The excerpt that killed it ended mid-quote, because generation stops the
  // instant the guard fires.
  assert.equal(fires('- Context loss ("the user hasn\'t asked anything'), false);
  assert.equal(fires('it looks for `i should wait for instructions'), false);
});

test('a model genuinely losing the thread still fires', () => {
  // The guard has to keep working, or fixing the false positive costs the
  // detection that matters.
  assert.equal(fires('The user has not asked anything specific, so I will wait.'), true);
  assert.equal(fires('I should wait for instructions before continuing.'), true);
  assert.equal(fires('Looking at this, the user hasn\'t provided a task.'), true);
});

test('quoting suppresses only the sentence it wraps', () => {
  const text = 'The docs say "the user hasn\'t asked anything". '
    + 'Anyway, the user has not provided a task, so I will stop.';
  assert.equal(fires(text), true, 'the unquoted assertion after the quote still counts');
});

test('corruption checks still read the raw output', () => {
  // A replacement character is broken output wherever it appears; only the
  // semantic assertions are about who is speaking.
  const scan = main.slice(main.indexOf('function scanContentForPsychosis'), main.indexOf('function scanContentForPsychosis') + 1400);
  assert.match(scan, /GLITCH_TOKEN_RE\.test\(tail\)/);
  assert.match(scan, /CONTEXT_RESET_RE\.test\(spoken\)/);
  assert.match(scan, /SELF_TALK\.test\(spoken\)/);
});

test('a conversation with no context cannot have lost the task from it', () => {
  // The guard fired on the first turn of a fresh chat, recovery had nothing to
  // compact, and the turn was killed outright.
  assert.match(main, /if \(\/nothing to compact\/i\.test\(c\.error \|\| ''\)\) \{/);
  assert.match(main, /there is no earlier context it could have lost/);
  const block = main.slice(main.indexOf('const c = await compactConversation(model);'));
  assert.ok(block.indexOf('continue;') < block.indexOf('Recovery compact failed'),
    'the false-positive path continues instead of breaking');
});

test('cloud reasoning is not stopped by local restart heuristics', () => {
  const loops = 'Actually, let me reconsider. '.repeat(20);
  assert.match(thinkingGuard('ollama', loops).reason, /deliberation loop/);
  assert.equal(thinkingGuard('openai', loops), null);
});

test('cloud reasoning keeps a large runaway ceiling', () => {
  assert.equal(thinkingGuard('openai', 'x'.repeat(99_999)), null);
  assert.match(thinkingGuard('openai', 'x'.repeat(100_000)).reason, /100,000/);
});
