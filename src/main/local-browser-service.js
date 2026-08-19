'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LOCAL_BROWSER_TOOL_NAMES = new Set([
  'browser_open',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_console',
  'browser_screenshot',
  'browser_close',
]);

function isLoopbackHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1') return true;
  const match = host.match(/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  return !!match && match.slice(1).every((part) => Number(part) <= 255);
}

function parseLoopbackUrl(value, protocols = ['http:', 'https:']) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('A valid loopback URL is required.'); }
  if (!protocols.includes(url.protocol)) throw new Error(`Protocol ${url.protocol || '(missing)'} is not allowed.`);
  if (url.username || url.password) throw new Error('URL credentials are not allowed.');
  if (!isLoopbackHostname(url.hostname)) throw new Error('Only localhost, 127.0.0.0/8, and ::1 are allowed.');
  return url;
}

function isAllowedResourceUrl(value) {
  const text = String(value || '');
  if (/^(?:data|about):/i.test(text)) return true;
  if (/^blob:/i.test(text)) {
    try { parseLoopbackUrl(text.slice(5), ['http:', 'https:']); return true; } catch { return false; }
  }
  try { parseLoopbackUrl(text, ['http:', 'https:', 'ws:', 'wss:']); return true; } catch { return false; }
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(Math.round(number), min), max) : fallback;
}

function safeScreenshotName(value, sessionId) {
  const base = String(value || `browser-${sessionId}.png`).replace(/\.png$/i, '');
  const safe = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 80);
  return (safe || `browser-${sessionId}`) + '.png';
}

function createLocalBrowserService({ BrowserWindow, getDataDir }) {
  const sessions = new Map();

  function getSession(id) {
    const entry = sessions.get(String(id || ''));
    if (!entry || entry.window.isDestroyed()) {
      sessions.delete(String(id || ''));
      throw new Error(`Unknown browser session "${id || ''}".`);
    }
    return entry;
  }

  function close(id) {
    const key = String(id || '');
    const entry = sessions.get(key);
    if (!entry) return false;
    sessions.delete(key);
    if (!entry.window.isDestroyed()) entry.window.destroy();
    return true;
  }

  async function open(args) {
    const url = parseLoopbackUrl(args.url).toString();
    const id = crypto.randomUUID();
    const window = new BrowserWindow({
      show: false,
      width: boundedInteger(args.width, 1280, 320, 1920),
      height: boundedInteger(args.height, 800, 240, 1080),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: `brittain-browser-${id}`,
      },
    });
    const entry = { id, window, console: [], createdAt: new Date().toISOString() };
    sessions.set(id, entry);

    const blockNavigation = (event, nextUrl) => {
      try { parseLoopbackUrl(nextUrl); } catch { event.preventDefault(); }
    };
    window.webContents.on('will-navigate', blockNavigation);
    window.webContents.on('will-redirect', blockNavigation);
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      entry.console.push({ level, message: String(message).slice(0, 2_000), line, source: sourceId || '' });
      if (entry.console.length > 200) entry.console.splice(0, entry.console.length - 200);
    });
    window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
      callback({ cancel: !isAllowedResourceUrl(details.url) });
    });
    window.on('closed', () => sessions.delete(id));

    try {
      await window.loadURL(url);
    } catch (err) {
      close(id);
      throw new Error(`Could not load ${url}: ${err.message}`);
    }
    return {
      session_id: id,
      url: window.webContents.getURL(),
      title: window.webContents.getTitle(),
      viewport: window.getContentBounds(),
      isolation: 'ephemeral loopback-only session',
    };
  }

  async function snapshot(args) {
    const entry = getSession(args.session_id);
    const maxChars = boundedInteger(args.max_chars, 30_000, 1_000, 80_000);
    const script = `(() => {
      const maxChars = ${maxChars};
      const selectorFor = (element) => {
        if (element.id) return '#' + String(element.id).replace(/[^A-Za-z0-9_-]/g, '\\$&');
        const parts = [];
        let current = element;
        while (current && current.nodeType === 1 && parts.length < 5) {
          let part = current.tagName.toLowerCase();
          const siblings = current.parentElement ? Array.from(current.parentElement.children).filter((item) => item.tagName === current.tagName) : [];
          if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')';
          parts.unshift(part);
          current = current.parentElement;
        }
        return parts.join(' > ');
      };
      const interactive = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"]')).slice(0, 300).map((element) => ({
        selector: selectorFor(element),
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role') || '',
        type: element.getAttribute('type') || '',
        name: element.getAttribute('name') || '',
        text: String(element.innerText || element.value || element.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ').slice(0, 300),
        disabled: !!element.disabled,
      }));
      const html = document.documentElement ? document.documentElement.outerHTML : '';
      return {
        url: location.href,
        title: document.title,
        active_element: document.activeElement ? selectorFor(document.activeElement) : '',
        interactive,
        html: html.slice(0, maxChars),
        html_truncated: html.length > maxChars,
      };
    })()`;
    return entry.window.webContents.executeJavaScript(script, true);
  }

  async function click(args) {
    const entry = getSession(args.session_id);
    const selector = String(args.selector || '');
    if (!selector) throw new Error('selector must not be empty.');
    const result = await entry.window.webContents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return { ok: false, error: 'No element matched the selector.' };
      element.scrollIntoView({ block: 'center', inline: 'center' });
      element.click();
      return { ok: true, tag: element.tagName.toLowerCase(), text: String(element.innerText || element.value || '').trim().slice(0, 300) };
    })()`, true);
    if (result.ok && args.wait_ms) await new Promise((resolve) => setTimeout(resolve, boundedInteger(args.wait_ms, 0, 0, 5_000)));
    return { ...result, url: entry.window.webContents.getURL() };
  }

  async function type(args) {
    const entry = getSession(args.session_id);
    const selector = String(args.selector || '');
    if (!selector) throw new Error('selector must not be empty.');
    const result = await entry.window.webContents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return { ok: false, error: 'No element matched the selector.' };
      const text = ${JSON.stringify(String(args.text ?? ''))};
      element.focus();
      if (element.isContentEditable) {
        if (${args.clear !== false}) element.textContent = '';
        element.textContent += text;
      } else if ('value' in element) {
        const value = ${args.clear !== false} ? text : String(element.value || '') + text;
        const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(element, value); else element.value = value;
      } else return { ok: false, error: 'Matched element does not accept text.' };
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      if (${!!args.press_enter}) element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      return { ok: true, value: String(element.value ?? element.textContent ?? '').slice(0, 1000) };
    })()`, true);
    if (result.ok && args.wait_ms) await new Promise((resolve) => setTimeout(resolve, boundedInteger(args.wait_ms, 0, 0, 5_000)));
    return { ...result, url: entry.window.webContents.getURL() };
  }

  async function screenshot(args) {
    const entry = getSession(args.session_id);
    const image = await entry.window.webContents.capturePage();
    const directory = path.join(getDataDir(), 'browser-screenshots');
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, safeScreenshotName(args.filename, entry.id));
    const temporaryPath = filePath + '.tmp';
    const png = image.toPNG();
    fs.writeFileSync(temporaryPath, png);
    fs.renameSync(temporaryPath, filePath);
    return { path: filePath, bytes: png.length, size: image.getSize(), url: entry.window.webContents.getURL() };
  }

  async function execute(name, args = {}) {
    switch (name) {
      case 'browser_open': return JSON.stringify(await open(args), null, 2);
      case 'browser_snapshot': return JSON.stringify(await snapshot(args), null, 2);
      case 'browser_click': return JSON.stringify(await click(args), null, 2);
      case 'browser_type': return JSON.stringify(await type(args), null, 2);
      case 'browser_console': {
        const entry = getSession(args.session_id);
        const maxEntries = boundedInteger(args.max_entries, 100, 1, 200);
        const selected = entry.console.slice(-maxEntries);
        if (args.clear) entry.console.length = 0;
        return JSON.stringify({ entries: selected, count: selected.length, cleared: !!args.clear }, null, 2);
      }
      case 'browser_screenshot': return JSON.stringify(await screenshot(args), null, 2);
      case 'browser_close': return close(args.session_id) ? 'Browser session closed.' : 'Browser session was already closed.';
      default: throw new Error(`Unknown local browser tool "${name}".`);
    }
  }

  function closeAll() {
    for (const id of [...sessions.keys()]) close(id);
  }

  return { closeAll, execute };
}

module.exports = {
  LOCAL_BROWSER_TOOL_NAMES,
  createLocalBrowserService,
  isAllowedResourceUrl,
  isLoopbackHostname,
  parseLoopbackUrl,
  safeScreenshotName,
};
