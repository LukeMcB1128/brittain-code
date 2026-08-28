const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('the bar uses conversation estimates instead of provider samples', () => {
  const main = read('main.js');
  const renderer = read('renderer/app.js');
  assert.match(main, /function publishContextStats\(stats, contextLength, scope = 'provider'\)/);
  assert.match(main, /function currentConversationTokens\(model = conversationView\.model\)/);
  assert.match(renderer, /const isConversation = scope === 'conversation' \|\| !scope/);
  assert.match(renderer, /if \(isConversation\) updateContextBar/);
});

test('the inspector and loaded chat use the shared context estimate', () => {
  const main = read('main.js');
  assert.match(main, /tokens: estimateContextTokens\(msg, \{ model \}\)/);
  assert.match(main, /const approxTokens = currentConversationTokens\(model\)/);
  assert.match(main, /await publishPersistedConversationContext\(model\)/);
});
