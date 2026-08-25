const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

test('messages the app wrote to itself are marked as such', () => {
  // Replaying them as dialogue claimed the user typed "You stopped without any
  // visible output or tool call", which they never did.
  const main = read('main.js');
  assert.match(main, /meta: 'nudge',[\s\S]{0,120}You stopped without any visible output/);
  assert.match(main, /meta: 'nudge',[\s\S]{0,80}You are planning in circles/);
  // The whole compaction block: notice, ledger and summary.
  assert.equal((main.match(/meta: 'compaction'/g) || []).length, 3);
});

test('the marker never reaches the model', () => {
  assert.match(read('main.js'), /compactionRecord, meta, \.\.\.message/);
});

test('a marked message renders as a folded context block, not as a person talking', () => {
  const app = read('renderer/app.js');
  assert.match(app, /if \(msg\.meta\) \{\s*\n\s*addContextBlock\(msg\);/);
  assert.match(app, /function addContextBlock\(msg\)/);
  // Folded: a details element with no open attribute.
  const body = app.slice(app.indexOf('function addContextBlock'), app.indexOf('function addMessage'));
  assert.match(body, /createElement\('details'\)/);
  assert.ok(!body.includes('details.open = true'), 'bookkeeping should start collapsed');
  // And labelled for what it is, rather than YOU or MODEL.
  assert.match(app, /compaction: 'CONTEXT — earlier conversation compacted'/);
  assert.match(app, /nudge: 'CONTEXT — the app prompted the model to continue'/);
});

test('the block is checked before the role branches, so a nudge never renders as YOU', () => {
  const app = read('renderer/app.js');
  const loop = app.slice(app.indexOf('conversation.forEach((msg, index)'), app.indexOf("} else if (msg.role === 'tool')"));
  assert.ok(loop.indexOf('msg.meta') < loop.indexOf("msg.role === 'user'"));
});

test('it is styled as machinery rather than conversation', () => {
  const css = read('renderer/style.css');
  assert.match(css, /\.context-block > summary/);
  assert.match(css, /\.context-block-body/);
});
