const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHistoryStore, safeChatId } = require('../../src/main/history-store');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-headless-hist-'));
  return createHistoryStore({ userDataDir: () => dir, runtimeMetadata: async (model) => ({ model }) });
}

test('a run with no window saves its own transcript', () => {
  // Saving was entirely the renderer's job, so a Discord run streamed its
  // messages to the screen and then lost them on exit. It looked like history
  // was deleting them; they had never been written.
  const main = read('main.js');
  assert.match(main, /async function persistRunHistory\(chatId, \{ goal, cwd, model, onlineResearch \}\)/);
  const task = main.slice(main.indexOf('async function runAgentTask'), main.indexOf('ipcMain.handle(\'agent:run\''));
  assert.match(task, /await persistRunHistory\(payload\.chatId, \{ goal, cwd, model, onlineResearch: payload\.onlineResearch \}\)/);
  // In the finally, so a run that throws still leaves its transcript behind.
  assert.ok(task.indexOf('} finally {') < task.indexOf('await persistRunHistory'),
    'persisting belongs with the other end-of-run bookkeeping');
});

test('a Discord channel id survives being used as a chat id', () => {
  assert.equal(safeChatId('discord-1398471209837'), 'discord-1398471209837');
  // Heartbeat ids carry a path; they only need to be stable, not pretty.
  assert.equal(safeChatId('heartbeat-/Users/x/proj'), 'heartbeat-Usersxproj');
  assert.equal(safeChatId('trigger-nightly-check'), 'trigger-nightly-check');
});

test('the transcript round-trips under a headless chat id', async () => {
  const history = store();
  const convo = [
    { role: 'user', content: 'what is in the repo?' },
    { role: 'assistant', content: 'Three files.' },
  ];
  await history.save({ id: 'discord-42', title: 'what is in the repo?', model: 'm', mode: 'code', cwd: '/tmp/p' }, convo);

  const loaded = history.load('discord-42');
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.chat.conversation, convo);
  // And it is in the index, so it shows up in the session list after a restart.
  assert.equal(history.list().some((entry) => entry.id === 'discord-42'), true);
});

test('a follow-up does not rename the conversation it continues', async () => {
  const history = store();
  await history.save({ id: 'discord-42', title: 'what is in the repo?', model: 'm', mode: 'code' }, [{ role: 'user', content: 'a' }]);
  // The second run has a different goal; the chat keeps the name it earned.
  const existing = history.list().find((entry) => entry.id === 'discord-42');
  assert.equal(existing.title, 'what is in the repo?');
  assert.match(read('main.js'), /title: existing\?\.title \|\| \(summary\.length > 60/);
});

test('a failed history write never changes the run outcome', () => {
  const main = read('main.js');
  const body = main.slice(main.indexOf('async function persistRunHistory'), main.indexOf('// Projects already told'));
  assert.match(body, /\} catch \{/);
  assert.match(body, /must not change the outcome of the run/);
  // Nothing to save is not an error either.
  assert.match(body, /if \(!id \|\| !conversation\.length\) return;/);
});
