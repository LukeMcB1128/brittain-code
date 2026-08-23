const test = require('node:test');
const assert = require('node:assert/strict');

const {
  authorize, parseCommand, chunk, renderPending, renderEvent, MAX_DISCORD_MESSAGE,
} = require('../../src/bridge/discord-protocol');

const config = { ownerIds: ['111'], channelIds: ['999'] };
const dm = (over = {}) => ({ author: { id: '111' }, channel_id: '555', content: 'hi', ...over });

// --- authorization: this is the whole security boundary ---

test('a message from anyone but an owner is refused', () => {
  assert.equal(authorize(config, dm({ channel_id: '999' })).ok, true);
  assert.equal(authorize(config, dm({ author: { id: '222' }, channel_id: '999' })).ok, false);
  assert.match(authorize(config, dm({ author: { id: '222' }, channel_id: '999' })).reason, /not an owner/);
});

test('with no owners configured the bridge answers nobody', () => {
  // Deny by default: an unconfigured bridge that answered everyone would be a
  // remote shell for the whole server.
  for (const empty of [{}, { ownerIds: [] }, { ownerIds: [''] }]) {
    const decision = authorize(empty, dm());
    assert.equal(decision.ok, false);
    assert.match(decision.reason, /no ownerIds/);
  }
});

test('bots are refused, including this bridge talking to itself', () => {
  assert.equal(authorize(config, dm({ author: { id: '111', bot: true }, channel_id: '999' })).ok, false);
});

test('an owner in a non-allowlisted channel is still refused', () => {
  assert.equal(authorize(config, dm({ channel_id: '777' })).ok, false);
  assert.match(authorize(config, dm({ channel_id: '777' })).reason, /not allowlisted/);
});

test('with no channel allowlist, DMs work and guild messages do not', () => {
  // The safe default: talking to the bot privately is fine, but a shared
  // channel has to be opted into by naming it.
  const dmsOnly = { ownerIds: ['111'] };
  assert.equal(authorize(dmsOnly, dm()).ok, true);
  const inGuild = authorize(dmsOnly, dm({ guild_id: '42' }));
  assert.equal(inGuild.ok, false);
  assert.match(inGuild.reason, /no channelIds allowlisted/);
});

// --- parsing ---

test('anything not starting with ! is a goal', () => {
  assert.deepEqual(parseCommand('check my email and summarise it'),
    { kind: 'run', goal: 'check my email and summarise it' });
  assert.deepEqual(parseCommand('  '), { kind: 'ignore' });
});

test('bang commands mirror the slash commands in the app', () => {
  assert.equal(parseCommand('!pending').kind, 'pending');
  assert.equal(parseCommand('!status').kind, 'status');
  assert.equal(parseCommand('!stop').kind, 'stop');
  assert.equal(parseCommand('!help').kind, 'help');
  assert.deepEqual(parseCommand('!run fix the tests'), { kind: 'run', goal: 'fix the tests' });
  assert.equal(parseCommand('!run').kind, 'error');
  assert.match(parseCommand('!frobnicate').error, /Unknown command/);
});

test('approve and deny default to every parked call', () => {
  assert.deepEqual(parseCommand('!approve'), { kind: 'resolve', approved: true, selector: 'all' });
  assert.deepEqual(parseCommand('!approve 2'), { kind: 'resolve', approved: true, selector: '2' });
  assert.deepEqual(parseCommand('!deny all'), { kind: 'resolve', approved: false, selector: 'all' });
});

// --- rendering ---

test('messages are split on line boundaries under the Discord cap', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
  const parts = chunk(lines);
  assert.ok(parts.length > 1);
  for (const part of parts) assert.ok(part.length <= MAX_DISCORD_MESSAGE, 'no part may exceed the cap');
  assert.equal(parts.join('\n'), lines, 'splitting must not lose or reorder content');
});

test('a single over-long line is truncated rather than dropped', () => {
  const parts = chunk('y'.repeat(5000));
  assert.equal(parts.length, 1);
  assert.ok(parts[0].length <= MAX_DISCORD_MESSAGE);
  assert.ok(parts[0].endsWith('…'));
});

test('only the run narrative is relayed, never the token stream', () => {
  // Relaying every token would be unreadable and would rate-limit the bot.
  assert.equal(renderEvent('stream:token', 'hello'), '');
  assert.equal(renderEvent('stream:toolcall', { name: 'read_file' }), '');
  assert.equal(renderEvent('stream:info', 'Agent run starting'), 'Agent run starting');
});

test('a suspension is announced with what it is waiting on', () => {
  const text = renderEvent('run:decisions', {
    parked: [{ name: 'mcp_gmail_send', target: 'a@b.c', reason: 'external MCP tools are never automatic', decision: '' }],
  });
  assert.match(text, /Run suspended/);
  assert.match(text, /mcp_gmail_send/);
  assert.match(text, /!approve all/);
});

test('a run whose parked calls are already decided announces nothing', () => {
  assert.equal(renderEvent('run:decisions', { parked: [{ name: 'x', decision: 'approved' }] }), '');
  assert.equal(renderEvent('run:decisions', { parked: [] }), '');
});

test('an empty tray says so rather than rendering nothing', () => {
  assert.match(renderPending([]), /Nothing parked/);
  const text = renderPending([{ runId: 'run-1', goal: 'triage mail', parked: [{ index: 0, name: 'mcp_gmail_send', target: 'a@b.c', reason: 'never automatic', decision: '' }] }]);
  assert.match(text, /run-1/);
  assert.match(text, /\[0\]/);
  assert.match(text, /mcp_gmail_send/);
});

// --- the bot has to speak first, once ---

test('the greeting happens once per channel, not on every restart', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { greetStore } = require('../../src/bridge/discord-config');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-greet-'));
  const store = greetStore(dir);
  assert.equal(store.hasGreeted('chan-1'), false);
  store.markGreeted('chan-1');
  assert.equal(store.hasGreeted('chan-1'), true);
  // Survives a restart, because it is on disk and not in memory.
  assert.equal(greetStore(dir).hasGreeted('chan-1'), true);
  // A different channel is a different conversation and needs its own hello.
  assert.equal(store.hasGreeted('chan-2'), false);
  assert.equal(store.hasGreeted(''), false);
});

test('the bridge introduces itself so the DM exists to click', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const client = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'bridge', 'discord-client.js'), 'utf8');
  // Discord hides a DM channel until it holds a message, so a silently opened
  // one leaves the bot unreachable — findable nowhere in the sidebar.
  assert.match(client, /greetStore && !greetStore\.hasGreeted\(notifyChannel\)/);
  assert.match(client, /greetStore\.markGreeted\(notifyChannel\)/);
  assert.match(client, /\*\*Brittain Code\*\* is connected/);
});
