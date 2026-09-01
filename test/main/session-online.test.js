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

test('online provenance and the saved switch state stay separate', async () => {
  const { store: history } = store();
  await history.save({ id: 'a1', title: 'went online', model: 'm', onlineResearch: true, onlineResearchEnabled: false }, [{ role: 'user', content: 'hi' }]);
  await history.save({ id: 'a2', title: 'saved online', model: 'm', onlineResearch: true, onlineResearchEnabled: true }, [{ role: 'user', content: 'hi' }]);
  await history.save({ id: 'old', title: 'older chat', model: 'm', onlineResearch: true }, [{ role: 'user', content: 'hi' }]);

  // Only permanent provenance is needed in the index for the sidebar marker.
  const index = Object.fromEntries(history.list().map((entry) => [entry.id, entry.onlineResearch]));
  assert.equal(index.a1, true);
  assert.equal(index.a2, true);

  // The detail keeps the current switch state separately. A missing field from
  // an older chat is normalized to false when that chat is saved again.
  assert.equal(history.load('a1').chat.onlineResearch, true);
  assert.equal(history.load('a1').chat.onlineResearchEnabled, false);
  assert.equal(history.load('a2').chat.onlineResearchEnabled, true);
  assert.equal(history.load('old').chat.onlineResearchEnabled, false);
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

test('reopening a chat restores its saved permission without asking again', () => {
  const app = read('renderer/app.js');
  assert.match(app, /onlineResearchToggle\.checked = saved\.onlineResearchEnabled === true;/,
    'only an explicit switch snapshot can restore ONLINE');
  const load = app.slice(app.indexOf('async function loadChat'), app.indexOf('async function syncVisibleChatToMain'));
  assert.doesNotMatch(load, /confirmOnlineResearch\(/,
    'routine chat navigation must not repeat the enable warning');
  assert.match(app, /onlineResearchEverUsed: !!saved\.onlineResearch,/, 'the provenance flag remains separate');
  assert.match(app, /onlineResearchEnabled: onlineResearchToggle\.checked,/, 'save records the current switch state');
  assert.match(app, /onlineResearchToggle\.checked = false; \/\/ privacy boundary: never restore online access implicitly/, 'new sessions still start offline');

  const main = read('main.js');
  assert.match(main, /sessionOnlineResearch = !!view\.onlineResearchEverUsed;/, 'loading a chat preserves its provenance latch');
});
