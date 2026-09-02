const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('normal sends have stable chat and run identities', () => {
  const app = read('renderer/app.js');
  assert.match(app, /if \(!currentChatId\) currentChatId = newIdentity\('chat'\);/);
  assert.match(app, /chatId: runChatId,\s*runId,/);
  assert.match(app, /setChatRun\(runChatId, res\.runId \|\| runId, res\.queued \? 'queued' : 'running'\);/);
});

test('background events cannot write into the visible chat', () => {
  const app = read('renderer/app.js');
  assert.match(app, /const routeIsVisible = \(route\) => !route\?\.chatId \|\| route\.chatId === currentChatId;/);
  for (const listener of ['onToken', 'onThinking', 'onCleanContent', 'onToolCall', 'onToolResult', 'onStats']) {
    const start = app.indexOf(`window.api.${listener}`);
    assert.ok(start > 0, `${listener} must exist`);
    assert.match(app.slice(start, start + 220), /if \(!routeIsVisible\(route\)\) return;/, `${listener} must check its route before it changes the DOM`);
  }
});

test('chat navigation remains available while normal chat runs are active', () => {
  const app = read('renderer/app.js');
  const load = app.slice(app.indexOf('async function loadChat'), app.indexOf('async function syncVisibleChatToMain'));
  assert.doesNotMatch(load, /hasChatRuns\(\).*return/);
  assert.match(app, /className = 'chat-run-state'/);
  assert.match(app, /liveRun\.state === 'queued' \? 'QUEUED' : 'RUNNING'/);
  assert.match(app, /else if \(!hasChatRuns\(\)\)/);
  assert.match(app, /await syncVisibleChatToMain\(\);/,
    'the visible chat becomes the active main conversation after the last background run');
  assert.match(app, /else await window\.api\.reset\(\);/,
    'an empty new chat clears the completed background transcript before commands can use it');
  assert.match(app, /if \(busy\) setState\('idle'\);\s*else if \(!hasChatRuns\(\)\)/,
    'an external run also restores the chat that is visible when it finishes');
  assert.match(load, /busy \|\| chatSubmitPending/,
    'navigation waits only for the immediate durable save, not for inference');
});

test('saved chats settle at the bottom after transcript layout', () => {
  const app = read('renderer/app.js');
  const render = app.slice(app.indexOf('function renderConversation'), app.indexOf('// ---------- attachments ----------'));
  assert.match(render, /settleAtChatBottom\(\);/);
  assert.match(app, /function settleAtChatBottom\(\) \{\s*scrollDown\(\);\s*requestAnimationFrame\(scrollDown\);/);
});

test('the running badge starts at the left edge of chat metadata', () => {
  const css = read('renderer/style.css');
  const badge = css.slice(css.indexOf('.chat-run-state {'), css.indexOf('}', css.indexOf('.chat-run-state {')) + 1);
  assert.match(badge, /display: block;/);
  assert.match(badge, /margin: 3px 0 0;/);
});
