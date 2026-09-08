'use strict';

function isAppUrl(value, appUrl) {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href === appUrl;
  } catch { return false; }
}

function protectWindow(window, appUrl, openExternal) {
  const contents = window.webContents;
  const openLink = (value) => {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
      Promise.resolve(openExternal(url.href)).catch(() => {});
    } catch {}
  };
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url, appUrl)) return;
    event.preventDefault();
    openLink(url);
  });
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-frame-navigate', (event) => {
    if (!isAppUrl(event.url, appUrl)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    openLink(url);
    return { action: 'deny' };
  });
}

// Both invoke and send handlers require the main frame of the app window.
function trustedIpc(ipc, getWindow, appUrl) {
  const trusted = (event) => {
    const window = getWindow();
    return window && !window.isDestroyed()
      && event.sender === window.webContents
      && event.senderFrame === window.webContents.mainFrame
      && isAppUrl(event.senderFrame?.url, appUrl);
  };
  return {
    handle(channel, handler) {
      ipc.handle(channel, (event, ...args) => {
        if (!trusted(event)) throw new Error('Untrusted IPC sender');
        return handler(event, ...args);
      });
    },
    on(channel, handler) {
      ipc.on(channel, (event, ...args) => {
        if (trusted(event)) return handler(event, ...args);
      });
    },
  };
}

module.exports = { isAppUrl, protectWindow, trustedIpc };
