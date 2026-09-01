const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'style.css'), 'utf8');

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
  assert.match(helper, /card\.classList\.add\('collapsed'\);/,
    'all tool details should stay hidden until the user opens the card');
  assert.doesNotMatch(helper, /looksBad|traceback|not found/,
    'words inside a tool result must not expand it automatically');
});

test('tool status stays against the right edge', () => {
  assert.match(css, /\.tool \.tool-head \.status \{ margin-left: auto;/);
  assert.doesNotMatch(css, /\.tool\.has-context-actions \.tool-head \{ padding-right:/,
    'the hidden context action must not reserve a visible gap beside the status');
});
