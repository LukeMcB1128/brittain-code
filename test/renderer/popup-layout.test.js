const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('dialogs stay below the measured top bar', () => {
  const css = read('renderer/style.css');
  const app = read('renderer/app.js');

  for (const id of ['overlay', 'confirm-modal', 'settings-modal']) {
    assert.match(
      css,
      new RegExp(`#${id} \\{[\\s\\S]*?inset: var\\(--topbar-height\\) 0 0;`),
      `${id} must use the top-bar inset`
    );
  }

  assert.match(app, /new ResizeObserver\(syncPopupArea\)\.observe\(topbar\);/);
  assert.match(css, /#settings-form \{[\s\S]*?max-height: 100%;/);
  assert.match(css, /#overlay-box \{[\s\S]*?max-height: 100%;/);
});
