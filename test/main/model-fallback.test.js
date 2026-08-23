const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { DEFAULT_SETTINGS, normalizeSettings } = require('../../settings');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

test('lastModel is a real setting that survives a round trip', () => {
  assert.equal(DEFAULT_SETTINGS.lastModel, '');
  assert.equal(normalizeSettings({ lastModel: 'ornith:latest' }).lastModel, 'ornith:latest');
  // Not something a user edits, but it must not be dropped on load either.
  assert.equal(normalizeSettings({}).lastModel, '');
});

test('a caller with no window inherits the model instead of being told to pick one', () => {
  // The dropdown lives in the renderer and is passed per call, so the daemon,
  // a trigger and the Discord bridge all arrive with no model at all.
  const main = read('main.js');
  assert.match(main, /const model = payload\.model \|\| runtimeSettings\.codeModel \|\| runtimeSettings\.lastModel;/);
  // And the message that remains names every place a model can come from.
  assert.match(main, /No model to run with\. Send one message from the app first, set a default in Settings, or put "model" in discord\.json\./);
});

test('the UI records what it ran, but only when it changes', () => {
  const main = read('main.js');
  assert.match(main, /rememberLastModel\(model\);/);
  const body = main.slice(main.indexOf('function rememberLastModel'), main.indexOf('// Projects already told'));
  assert.match(body, /if \(!name \|\| name === runtimeSettings\.lastModel\) return;/,
    'this runs on every message; rewriting settings each time would be silly');
  assert.match(body, /saveSettings\(settingsUserDataDir, runtimeSettings\)/);
});
