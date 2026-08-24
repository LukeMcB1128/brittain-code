const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createSessions, sessionKeyFor, loadSessionState } = require('../../src/main/sessions');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

// --- routing ---

test('a run belongs to the window unless it says otherwise', () => {
  // Anything that forgets to declare an origin must behave as it did before,
  // not quietly acquire a conversation of its own.
  assert.equal(sessionKeyFor({}), 'window');
  assert.equal(sessionKeyFor(), 'window');
  assert.equal(sessionKeyFor({ origin: 'ui', chatId: '17390' }), 'window');
});

test('each origin is its own conversation', () => {
  assert.equal(sessionKeyFor({ origin: 'remote', chatId: 'discord-42' }), 'discord-42');
  assert.equal(sessionKeyFor({ origin: 'trigger', chatId: 'trigger-nightly' }), 'trigger-nightly');
  assert.equal(sessionKeyFor({ origin: 'heartbeat', chatId: 'heartbeat-/x/y' }), 'heartbeat-/x/y');
  // Two channels are two conversations.
  assert.notEqual(sessionKeyFor({ origin: 'remote', chatId: 'discord-1' }),
                  sessionKeyFor({ origin: 'remote', chatId: 'discord-2' }));
});

test('an origin with no chat id still gets its own session', () => {
  assert.equal(sessionKeyFor({ origin: 'remote' }), 'remote');
  assert.equal(sessionKeyFor({ origin: 'remote', chatId: '  ' }), 'remote');
});

test('a saved headless session can be restored after restart', () => {
  const conversation = [
    { role: 'user', content: 'what did we learn?' },
    { role: 'assistant', content: 'Use the school portal first.' },
  ];
  const history = {
    load: (id) => id === 'discord-42'
      ? { ok: true, chat: { conversation, onlineResearch: true, contextState: { projectPath: '/project', pinnedFiles: [] } } }
      : { ok: false },
  };
  const restored = loadSessionState(history, 'discord-42');
  assert.deepEqual(restored.conversation, conversation);
  assert.equal(restored.onlineResearch, true);
  assert.equal(loadSessionState(history, 'discord-missing'), null);
});

// --- swapping ---

test('a conversation comes back exactly as it was left', () => {
  const sessions = createSessions('window');
  const windowState = { conversation: [{ role: 'user', content: 'in the app' }], sessionId: 's-win' };

  const away = sessions.switchTo('discord-42', windowState);
  assert.equal(away.changed, true);
  assert.equal(away.state, null, 'a session entered for the first time starts empty');

  const discordState = { conversation: [{ role: 'user', content: 'from discord' }], sessionId: 's-dis' };
  const back = sessions.switchTo('window', discordState);
  assert.equal(back.changed, true);
  assert.deepEqual(back.state, windowState, 'the window gets its own messages back, not Discord\'s');

  const again = sessions.switchTo('discord-42', windowState);
  assert.deepEqual(again.state, discordState);
});

test('switching to the session already active does nothing', () => {
  const sessions = createSessions('window');
  const result = sessions.switchTo('window', { conversation: [{ role: 'user', content: 'x' }] });
  assert.equal(result.changed, false);
  assert.equal(result.state, null);
  assert.deepEqual(sessions.known(), [], 'nothing was stashed, so nothing can be clobbered');
});

test('forget drops a session so a reset does not come back later', () => {
  const sessions = createSessions('window');
  sessions.switchTo('discord-42', { conversation: [{ role: 'user', content: 'old' }] });
  sessions.switchTo('window', { conversation: [] });
  assert.equal(sessions.forget('discord-42'), true);
  assert.equal(sessions.switchTo('discord-42', { conversation: [] }).state, null);
});

// --- wiring ---

test('every window entry point declares its session', () => {
  const main = read('main.js');
  // Without this a Discord run would leave its conversation active and the
  // next thing typed in the app would land in it.
  for (const handler of ['chat:send', 'chat:loop', 'chat:reset', 'chat:load', 'chat:compact', 'chat:plan', 'chat:orchestrate', 'chat:export']) {
    const at = main.indexOf(`ipcMain.handle('${handler}'`);
    assert.ok(at > 0, `${handler} should exist`);
    // A wider window than you might expect: chat:send now refuses a concurrent
    // run before it touches session state at all.
    assert.match(main.slice(at, at + 900), /enterSession\('window'\)/, `${handler} must declare its session`);
  }
  // chat:get is the exception: it reads without switching, because it is
  // called while other sessions are mid-run.
  assert.match(main, /ipcMain\.handle\('chat:get', \(\) => \(/);
});

test('runs enter the session their origin names', () => {
  const main = read('main.js');
  assert.match(main, /enterSession\(sessionKeyFor\(payload\)\);/);
  assert.match(main, /ipcMain\.handle\('agent:run', async \(_e, payload = \{\}\) => runAgentTask\(\{ \.\.\.payload, origin: 'ui' \}\)\)/);
  assert.match(main, /run: \(payload\) => runAgentTask\(\{ \.\.\.payload, origin: payload\.origin \|\| 'remote' \}\)/);
  assert.match(main, /origin: 'trigger',/);
  assert.match(main, /origin: 'heartbeat',/);
  assert.match(main, /loadSessionState\(historyStore, target\)/);
});

test('a suspended run resumes into the session it was suspended from', () => {
  const main = read('main.js');
  assert.match(main, /sessionKey: activeSessionKey,/, 'the session is recorded with the parked call');
  assert.match(main, /enterSession\(record\.sessionKey \|\| sessionKeyFor\(record\)\);/);
});

test('the online latch travels with the session, not the process', () => {
  const main = read('main.js');
  assert.match(main, /onlineResearch: sessionOnlineResearch \}/, 'stashed on the way out');
  assert.match(main, /sessionOnlineResearch = !!restored\?\.onlineResearch;/, 'restored on the way in');
});

// --- safety against concurrent access ---

test('a session can be read without becoming it', () => {
  const sessions = createSessions('window');
  const windowState = { conversation: [{ role: 'user', content: 'in the app' }], sessionId: 's-win' };
  sessions.switchTo('discord-42', windowState);

  assert.deepEqual(sessions.peek('window'), windowState);
  assert.equal(sessions.active(), 'discord-42', 'peeking must not change who is active');
  assert.equal(sessions.peek('never-seen'), null);
});

test('a run in progress cannot have its conversation swapped away', () => {
  // The agent loop reads the conversation as a module variable on every step,
  // so a switch mid-run pushes the rest of that run into somebody else's
  // transcript. It surfaced as a run that had worked for minutes suddenly
  // announcing it had no context.
  const main = read('main.js');
  assert.match(main, /if \(currentAbort && target !== activeSessionKey\) \{/);
  assert.match(main, /Ignored a session switch to/);
});

test('reading the window transcript never switches sessions', () => {
  // chat:get is called by the renderer at arbitrary times, including while a
  // Discord run is executing.
  const main = read('main.js');
  assert.match(main, /activeSessionKey === 'window' \? conversation : \(sessions\.peek\('window'\)\?\.conversation \|\| \[\]\)/);
  assert.ok(!/ipcMain\.handle\('chat:get', \(\) => \{ enterSession/.test(main));
});

test('a run hands the session back when it finishes', () => {
  // So the window is active whenever nothing is running, and the renderer's
  // handlers never have to reason about which session they are looking at.
  const main = read('main.js');
  assert.match(main, /const callerSessionKey = activeSessionKey;/);
  assert.match(main, /enterSession\(callerSessionKey\);/);
  const task = main.slice(main.indexOf('async function runAgentTask'), main.indexOf("ipcMain.handle('agent:run'"));
  assert.ok(task.indexOf('} finally {') < task.lastIndexOf('enterSession(callerSessionKey)'),
    'the hand-back belongs in the finally, so an aborted run restores it too');
});
