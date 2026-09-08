const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { protectWindow, trustedIpc } = require('../../src/main/window-security');
const appUrl = 'file:///app/renderer/index.html';

test('external navigation cannot replace the app or create a privileged window', () => {
  const webContents = new EventEmitter();
  webContents.setWindowOpenHandler = (handler) => { webContents.open = handler; };
  const opened = [];
  protectWindow({ webContents }, appUrl, (url) => opened.push(url));
  for (const url of ['https://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'https://user:pass@example.com/']) {
    let blocked = false;
    webContents.emit('will-navigate', { preventDefault() { blocked = true; } }, url);
    assert.equal(blocked, true);
  }
  assert.deepEqual(opened, ['https://example.com/']);
  assert.deepEqual(webContents.open({ url: 'https://example.org/' }), { action: 'deny' });
  assert.equal(opened[1], 'https://example.org/');
});

test('IPC rejects remote pages, other windows and subframes', () => {
  const handlers = {};
  const frame = { url: appUrl };
  const window = { isDestroyed: () => false, webContents: { mainFrame: frame } };
  const ipc = trustedIpc({ handle: (name, fn) => { handlers[name] = fn; }, on: (name, fn) => { handlers[name] = fn; } }, () => window, appUrl);
  let calls = 0;
  ipc.handle('secret', () => ++calls);
  ipc.on('delete', () => ++calls);
  const event = { sender: window.webContents, senderFrame: frame };
  assert.equal(handlers.secret(event), 1);
  for (const bad of [{ ...event, sender: {} }, { ...event, senderFrame: { url: appUrl } }]) {
    assert.throws(() => handlers.secret(bad), /Untrusted/);
    handlers.delete(bad);
  }
  frame.url = 'https://example.com/';
  assert.throws(() => handlers.secret(event), /Untrusted/);
  handlers.delete(event);
  assert.equal(calls, 1);
});
