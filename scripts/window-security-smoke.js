'use strict';

// Run with Electron. Uses a temporary profile and does not start agent services.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { protectWindow, trustedIpc } = require('../src/main/window-security');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-security-'));
app.setPath('userData', profile);

app.whenReady().then(async () => {
  const root = path.join(__dirname, '..');
  const appUrl = pathToFileURL(path.join(root, 'renderer/index.html')).href;
  const window = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  const opened = [];
  const ipc = trustedIpc(ipcMain, () => window, appUrl);
  ipc.handle('app:getVersion', () => 'smoke-test');
  protectWindow(window, appUrl, (url) => opened.push(url));
  let remoteImages = 0;
  const server = http.createServer((request, response) => {
    if (request.url === '/image.png') remoteImages++;
    response.end('<html><body>Untrusted page</body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const remote = `http://127.0.0.1:${server.address().port}`;
  try {
    await window.loadURL(appUrl);
    assert.equal(await window.webContents.executeJavaScript('window.api.getVersion()'), 'smoke-test');
    assert.equal(await window.webContents.executeJavaScript('typeof DOMPurify.sanitize'), 'function');
    await window.webContents.executeJavaScript(`new Promise(resolve => {
      const image = new Image(); image.onload = image.onerror = resolve;
      image.src = ${JSON.stringify(remote + '/image.png')}; document.body.append(image);
    })`);
    assert.equal(remoteImages, 0, 'CSP must block remote Markdown images');
    await window.webContents.executeJavaScript(`{
      const link = document.createElement('a'); link.href = ${JSON.stringify(remote + '/link')};
      document.body.append(link); link.click();
    }`);
    assert.deepEqual(opened, [remote + '/link']);
    assert.equal(window.webContents.getURL(), appUrl);
    // Main-process navigation bypasses will-navigate. IPC must still reject it.
    await window.loadURL(remote);
    await assert.rejects(window.webContents.executeJavaScript('window.api.getVersion()'), /Untrusted IPC sender/);
    console.log('Electron window security smoke test passed.');
  } finally {
    window.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}).then(() => app.exit(0), (error) => { console.error(error); app.exit(1); });

process.on('exit', () => fs.rmSync(profile, { recursive: true, force: true }));
