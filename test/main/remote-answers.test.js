const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { renderResult } = require('../../src/bridge/discord-protocol');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

test('a run with no visible screen is told its message is the whole answer', () => {
  // In the app you watch every tool call go past, so a terse sign-off is fine.
  // Over Discord all of that is hidden and "done, see above" answers nobody.
  const main = read('main.js');
  assert.match(main, /THIS RUN HAS NO VISIBLE SCREEN\./);
  assert.match(main, /cannot see your tool calls, their results, or any file you read/);
  assert.match(main, /Never write "as shown above", "see the output", or "I have finished"/);
});

test('the instruction is conditional, not always on', () => {
  // A windowed run should not be told to restate everything it just displayed.
  const main = read('main.js');
  assert.match(main, /function systemPrompt\(cwd, model = '', onlineResearch = false, \{ remote = false \} = \{\}\)/);
  assert.match(main, /if \(remote\) \{/);
  assert.match(main, /systemPrompt\(cwd, model, onlineResearch, \{ remote \}\)/);
});

test('the flag follows the run origin', () => {
  const main = read('main.js');
  assert.match(main, /\{ remote: \(payload\.origin \|\| 'ui'\) !== 'ui' \}/);
  // runAgentTurn takes it as an option with a safe default, so the callers that
  // never pass it keep the windowed behaviour.
  assert.match(main, /mode = 'code', \{ remote = false \} = \{\}\)/);
});

test('the closing instruction covers questions, not only changes', () => {
  // "a summary of what changed" is the wrong shape for "what is in the repo?".
  const main = read('main.js');
  assert.match(main, /End every turn by answering in plain language: what you found, or what you changed\./);
  assert.ok(!main.includes('End each task with a 1-3 sentence summary of what changed'));
});

test('a run that still says nothing does not come back blank', () => {
  // The prompt is the fix; this is the floor under it.
  const text = renderResult({ ok: true, status: 'completed', content: '', changed: 2, commands: 1, verified: true });
  assert.match(text, /finished without a closing message/);
  assert.match(text, /2 files changed/);
});

test('each completed assistant message is emitted as one event', () => {
  const main = read('main.js');
  // The window renders prose from the token stream, which is far too chatty to
  // relay; a client with no screen wants whole thoughts, in order.
  assert.match(main, /if \(content && content\.trim\(\)\) sink\.emit\('stream:message', content\.trim\(\)\);/);
  assert.match(read('src/main/run-sink.js'), /'stream:message',/);
  // Emitted before lastContent is updated, so the ordering of what a listener
  // sees matches the order the model produced it.
  const at = main.indexOf("sink.emit('stream:message'");
  assert.ok(at > 0 && at < main.indexOf('if (content) lastContent = content;'));
});
