const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'app.js'), 'utf8');

test('model slash commands bound an unfiltered cloud catalog', () => {
  assert.match(app, /const MODEL_COMMAND_LIMIT = 20/);
  assert.match(app, /matches\.slice\(0, MODEL_COMMAND_LIMIT\)/);
  assert.match(app, /Add more of the model name to narrow the list/);
});

test('model matching treats dot, dash, and underscore as equal', () => {
  assert.match(app, /replace\(\/\[\._-\]\+\/g, ''\)/);
  assert.match(app, /normalizeModelQuery\(model\) === normalized/);
});

test('cloud model errors do not give Ollama install advice', () => {
  const block = app.slice(app.indexOf('function modelNotFound'), app.indexOf('function selectModelMatch'));
  assert.match(block, /No provider model matches/);
  assert.match(block, /No installed model matches/);
  assert.ok(block.indexOf('No provider model matches') < block.indexOf('No installed model matches'));
});

test('folder-free Chat can open its user-wide memory', () => {
  const gate = app.slice(app.indexOf('const codeOnlyCommands'), app.indexOf('switch (normalizedCmd)'));
  assert.doesNotMatch(gate, /'memory'/);
  assert.match(app, /const memoryCwd = appMode === 'chat' \? null : cwd/);
});
