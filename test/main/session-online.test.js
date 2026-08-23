const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHistoryStore } = require('../../src/main/history-store');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-hist-'));
  return {
    dir,
    store: createHistoryStore({
      userDataDir: () => dir,
      runtimeMetadata: async (model) => ({ model }),
    }),
  };
}

test('whether a session went online is saved in the index and the detail', async () => {
  const { store: history } = store();
  await history.save({ id: 'a1', title: 'went online', model: 'm', onlineResearch: true }, [{ role: 'user', content: 'hi' }]);
  await history.save({ id: 'a2', title: 'stayed local', model: 'm', onlineResearch: false }, [{ role: 'user', content: 'hi' }]);

  // In the index, so the session list can show it without opening every file.
  const index = Object.fromEntries(history.list().map((entry) => [entry.id, entry.onlineResearch]));
  assert.equal(index.a1, true);
  assert.equal(index.a2, false);

  // And in the chat itself, where the transcript is.
  assert.equal(history.load('a1').chat.onlineResearch, true);
  assert.equal(history.load('a2').chat.onlineResearch, false);
});

test('the flag is a latch over the session, not the toggle at save time', () => {
  // Research done an hour ago is still in the transcript after the switch goes
  // off, so a snapshot would record "offline" for a session that went online.
  const main = read('main.js');
  assert.match(main, /let sessionOnlineResearch = false;/);
  assert.match(main, /function noteOnlineResearch\(enabled\) \{\s*if \(enabled\) sessionOnlineResearch = true;/);
  assert.match(main, /onlineResearch: !!meta\?\.onlineResearch \|\| sessionOnlineResearch,/);
});

test('a new session starts the latch clear again', () => {
  const main = read('main.js');
  const body = main.slice(main.indexOf('function newSessionId()'), main.indexOf('function newSessionId()') + 260);
  assert.match(body, /sessionOnlineResearch = false;/, 'clearing the conversation must clear the claim too');
});

test('both entry points latch it: the window and a headless run', () => {
  const main = read('main.js');
  assert.match(main, /noteOnlineResearch\(onlineResearch\);/, 'chat:send');
  assert.match(main, /noteOnlineResearch\(!!payload\.onlineResearch\);/, 'runAgentTask');
});

test('opening a saved session still never re-enables network access', () => {
  // The record is provenance. Restoring the switch from history would be a
  // privacy regression, and the existing boundary stays exactly as it was.
  const app = read('renderer/app.js');
  assert.match(app, /onlineResearchToggle\.checked = false; \/\/ loading history must never restore network access/);
  assert.match(app, /onlineResearchToggle\.checked = false; \/\/ privacy boundary: never restore online access implicitly/);
});
