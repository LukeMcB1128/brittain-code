const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'app.js'), 'utf8');

test('saved tool results reuse the compact live tool cards', () => {
  const render = app.slice(app.indexOf('function renderConversation'), app.indexOf('// ---------- attachments ----------'));
  assert.match(render, /pendingToolCalls\.push\(toolCallDetails\(call\)\)/,
    'saved assistant calls retain their short argument summary');
  assert.match(render, /const card = addToolCard\(/);
  assert.match(render, /finishToolCard\(card, text/);
  assert.doesNotMatch(render, /addMessage\('tool'/,
    'rejoining a chat must not use the large gray message renderer');
});

test('live and saved tools share one completion display', () => {
  const live = app.slice(app.indexOf('window.api.onToolCall'), app.indexOf('let compactWarned'));
  assert.match(live, /lastToolCard = addToolCard\(name, args\);/);
  assert.match(live, /finishToolCard\(lastToolCard, result, \{ denied \}\);/);

  const helper = app.slice(app.indexOf('function finishToolCard'), app.indexOf('function decorateContextControls'));
  assert.match(helper, /if \(!looksBad\) card\.classList\.add\('collapsed'\);/,
    'successful saved results should reopen as one compact row');
});
