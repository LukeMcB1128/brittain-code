const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseCommand, renderCompaction, renderUsage, renderMemory, HELP } = require('../../src/bridge/discord-protocol');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

test('the session commands mirror the ones in the app', () => {
  assert.equal(parseCommand('!compact').kind, 'compact');
  assert.equal(parseCommand('!ledger').kind, 'ledger');
  assert.equal(parseCommand('!memory').kind, 'memory');
  // Two names each where the app has two, so muscle memory works either way.
  assert.equal(parseCommand('!clear').kind, 'clear');
  assert.equal(parseCommand('!new').kind, 'clear');
  assert.equal(parseCommand('!usage').kind, 'usage');
  assert.equal(parseCommand('!context').kind, 'usage');
});

test('they act on this channel, not on whatever the app has open', () => {
  // A long Discord thread compacting the window's conversation would be both
  // useless and destructive.
  const client = read('src/bridge/discord-client.js');
  assert.match(client, /function sessionKeyFor\(channelId\) \{\s*return `discord-\$\{channelId\}`;/);
  for (const cmd of ['compact', 'clear', 'usage', 'ledger']) {
    assert.match(client, new RegExp(`cmd: '${cmd}', payload: \\{ sessionKey: sessionKeyFor\\(channelId\\)`),
      `!${cmd} must name its session`);
  }
});

test('the key matches the one a run from the same channel uses', () => {
  // Otherwise !compact would tidy a conversation nothing ever writes to.
  const client = read('src/bridge/discord-client.js');
  assert.match(client, /chatId: `discord-\$\{channelId\}`/, 'runs use this key');
  assert.match(client, /return `discord-\$\{channelId\}`/, 'and so does housekeeping');
});

test('housekeeping refuses while a run is in flight', () => {
  // Switching sessions under a live loop is the tearing that cost a run its
  // context; withSession refuses rather than risking it again.
  const main = read('main.js');
  const body = main.slice(main.indexOf('async function withSession'), main.indexOf('async function withSession') + 500);
  assert.match(body, /if \(runInFlight\(\)\) return \{ ok: false/);
  assert.match(body, /Try again when it finishes, or !stop it\./);
  // And it always puts the previous session back.
  assert.match(body, /\} finally \{\s*enterSession\(previous\);/);
});

test('clear removes durable history, queued work, and bridge-local state', () => {
  const main = read('main.js');
  const clearBody = main.slice(main.indexOf('clear: ({ sessionKey })'), main.indexOf('usage: ({ sessionKey })'));
  assert.match(clearBody, /cancelQueuedRuns\(settingsUserDataDir/);
  assert.match(clearBody, /historyStore\.remove\(key\)/);
  assert.match(clearBody, /contextState = normalizeContextState\(\)/);
  assert.match(clearBody, /usage = freshUsage\(\)/);

  const client = read('src/bridge/discord-client.js');
  assert.match(client, /awaitingQuestions\.delete\(channelId\)/);
  assert.match(client, /queuedRequests = new Map\(\)/);
  assert.match(client, /queuedRequests\.delete\(requestId\)/);
});

test('compaction is reported as what it did to the room', () => {
  const text = renderCompaction({ ok: true, beforeTokens: 40000, approxTokens: 12000, description: 'kept 8 turns verbatim' });
  assert.match(text, /70% smaller/);
  assert.match(text, /kept 8 turns/);
  assert.match(renderCompaction({ ok: false, error: 'summary too thin' }), /Could not compact: summary too thin/);
  // No before/after numbers is not a failure, just less to say.
  assert.match(renderCompaction({ ok: true, description: 'done' }), /Compacted\. done/);
});

test('usage says how full the context is, not just a number', () => {
  assert.match(renderUsage({ ok: true, messages: 42, approxTokens: 15235 }, 131072), /42 message\(s\).*15,235.*12%/);
  // Without a known limit it still says something useful.
  assert.match(renderUsage({ ok: true, messages: 3, approxTokens: 900 }), /3 message\(s\), about 900 tokens\./);
});

test('an empty memory or ledger says so rather than sending nothing', () => {
  assert.match(renderMemory({ ok: true, content: '   ' }), /Nothing remembered/);
  assert.match(renderMemory({ ok: true, content: '- prefer tabs', inRepo: true }), /in the repo/);
  assert.match(read('src/bridge/discord-client.js'), /Nothing changed or ran in this conversation yet\./);
});

test('help lists them, grouped so the two kinds are distinguishable', () => {
  assert.match(HELP, /\*\*This conversation\*\*/);
  for (const cmd of ['!compact', '!clear', '!usage', '!ledger', '!memory']) {
    assert.ok(HELP.includes(cmd), `${cmd} should be documented`);
  }
});
