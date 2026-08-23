const test = require('node:test');
const assert = require('node:assert/strict');

const {
  authorize, parseCommand, chunk, renderPending, renderEvent, renderResult, MAX_DISCORD_MESSAGE,
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

test('chat gets interruptions, not progress', () => {
  // A console log piped into a DM buries the two things a remote person can
  // act on under paragraphs they cannot.
  assert.equal(renderEvent('stream:token', 'hello'), '');
  assert.equal(renderEvent('stream:toolcall', { name: 'read_file' }), '');
  for (const noise of [
    'Agent run run-123 starting unattended under "Trusted". Transcript: /Users/x/runs/run-123.log',
    'Policy grants access outside the project: /Users/x/notes',
    'Context past 70% — auto-compacting…',
    'This project has no .brittain/ workspace — /workspace init keeps memory in the repo',
  ]) {
    assert.equal(renderEvent('stream:info', noise), '', `should not relay: ${noise}`);
  }
  // But a failure or a skipped call is worth breaking silence for.
  assert.match(renderEvent('stream:info', 'Agent run failed: ollama refused'), /failed/);
  assert.match(renderEvent('stream:info', 'Deferred write_file — risky tool not in the policy allow list'), /Deferred/);
});

test('the answer reaches the person who asked', () => {
  // The whole point of asking from a phone. This returned "completed" and threw
  // the answer away.
  const text = renderResult({ ok: true, status: 'completed', content: 'The repo has 3 files: a.js, b.js, README.md', changed: 0, commands: 1 });
  assert.match(text, /3 files: a\.js/);
  assert.match(text, /1 command/);
});

test('a result says something even when there is nothing to say', () => {
  // Silence is indistinguishable from a broken bridge.
  assert.match(renderResult({ ok: true, status: 'completed', content: '' }), /finished without a closing message/);
});

test('failures and refusals read as such', () => {
  assert.match(renderResult({ ok: false, error: 'no model' }), /⚠️.*no model/);
  assert.match(renderResult({ ok: true, status: 'failed', error: 'ollama died', content: '' }), /Failed.*ollama died/s);
  assert.match(renderResult({ ok: true, status: 'stopped', content: '' }), /Stopped/);
  assert.match(renderResult({ ok: true, queued: true, depth: 2 }), /queued \(2 waiting\)/);
});

test('a suspended run does not repeat what it already announced', () => {
  assert.equal(renderResult({ ok: true, status: 'suspended' }), '');
});

test('unverified changes are flagged, because that is the risky outcome', () => {
  const text = renderResult({ ok: true, status: 'completed', content: 'done', changed: 2, commands: 0, verified: false });
  assert.match(text, /2 files changed/);
  assert.match(text, /not verified/);
  const checked = renderResult({ ok: true, status: 'completed', content: 'done', changed: 2, commands: 3, verified: true });
  assert.ok(!checked.includes('not verified'));
});

test('a suspension is announced with what it is waiting on', () => {
  const text = renderEvent('run:decisions', {
    parked: [{ name: 'mcp_gmail_send', target: 'a@b.c', reason: 'external MCP tools are never automatic', decision: '' }],
  });
  assert.match(text, /Waiting on you/);
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
  assert.match(client, /if \(!notifyChannel \|\| !greetStore \|\| greetStore\.hasGreeted\(notifyChannel\)\) return;/);
  assert.match(client, /greetStore\.markGreeted\(notifyChannel\)/);
  assert.match(client, /\*\*Brittain Code\*\* is here/);
});

test('a bot in no servers says so, because it cannot be DMed at all', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const client = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'bridge', 'discord-client.js'), 'utf8');
  // Discord refuses to open a DM between accounts with no server in common, so
  // this one number explains most of the ways setup silently fails.
  assert.match(client, /identity = \{ username: frame\.d\.user\?\.username \|\| '', guilds: \(frame\.d\.guilds \|\| \[\]\)\.length \}/);
  assert.match(client, /This bot is in no servers/);
  // And the DM open is retried after login, when a shared server may exist.
  assert.match(client, /if \(!notifyChannel\) \{[\s\S]{0,200}?resolveNotifyChannel\(\)/);
});

test('a connection Discord refuses stops and explains, rather than looping', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const client = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'bridge', 'discord-client.js'), 'utf8');
  // Retrying a disallowed intent or a bad token can never succeed, and the
  // loop buries the one line that says what to fix.
  assert.match(client, /const FATAL_CLOSE = \{/);
  assert.match(client, /4014: 'the Message Content intent is not enabled/);
  assert.match(client, /4004: 'the bot token is wrong/);
  assert.match(client, /stopped = true; \/\/ retrying cannot help/);
  // And the gateway's real state is reported separately from "did start() run".
  assert.match(client, /gateway = \{ state: 'ready', lastError: '' \}/);
  assert.match(client, /gateway = \{ state: 'failed'/);
});

// --- speaking as it works ---

test('the model\'s own words go out as it says them', () => {
  // A long run narrates its way through several steps. Relaying only the last
  // paragraph made a working agent look like a silent one.
  assert.equal(renderEvent('stream:message', '  Updated memory.md with two notes.  '),
    'Updated memory.md with two notes.');
  assert.equal(renderEvent('stream:message', '   '), '');
});

test('the machinery still stays out of it', () => {
  // Relaying prose must not become an excuse to relay everything.
  assert.equal(renderEvent('stream:token', 'Upd'), '');
  assert.equal(renderEvent('stream:cleancontent', 'recovered text'), '');
  assert.equal(renderEvent('stream:toolcall', { name: 'read_file' }), '');
  assert.equal(renderEvent('stream:info', 'Agent run run-1 starting. Transcript: /x/y.log'), '');
});

test('a closing message already sent live is not repeated at the end', () => {
  const result = { ok: true, status: 'completed', content: 'The repo has three files.', changed: 0, commands: 1 };
  assert.match(renderResult(result, false), /three files/);
  const afterStreaming = renderResult(result, true);
  assert.ok(!afterStreaming.includes('three files'), 'the answer went out already');
  assert.match(afterStreaming, /1 command/, 'the footer is still worth having');
});

test('a silent run is only called silent when it truly said nothing', () => {
  assert.match(renderResult({ ok: true, status: 'completed', content: '' }, false), /without a closing message/);
  // It spoke during the run and simply had no epilogue — that is not silence.
  assert.ok(!renderResult({ ok: true, status: 'completed', content: '' }, true).includes('without a closing message'));
});

test('failures are reported whether or not the model spoke', () => {
  assert.match(renderResult({ ok: true, status: 'failed', error: 'ollama died', content: '' }, true), /Failed.*ollama died/s);
});

// --- compaction and degradation ---

test('a successful compaction is invisible, because nothing was lost', () => {
  assert.equal(renderEvent('stream:info', 'Context past 70% — auto-compacting…'), '');
  assert.equal(renderEvent('stream:info', 'Compacted: summarized 40 messages, kept 12 verbatim'), '');
  assert.equal(renderEvent('stream:info', 'Context is ~92% full before sending — auto-compacting first…'), '');
  assert.equal(renderEvent('stream:state', 'compacting'), '');
});

test('a failed compaction is not invisible, because the run gets worse', () => {
  // Silent, this is experienced as the bot quietly degrading for no reason.
  const text = renderEvent('stream:info', 'Auto-compact failed (summary too thin) — continuing.');
  assert.match(text, /could not summarise/);
  assert.match(text, /answers may get worse/);
  assert.match(text, /!stop/, 'it should say what to do about it');
});

test('a turn that stops mid-task says so, in words that mean something', () => {
  // These are phrased for a console: "Detected again after recovery" names
  // neither what was detected nor what it means for the person waiting.
  for (const [line, expected] of [
    ['Recovery compact failed (context too small) — stopping this turn.', /stopped here rather than continue badly/],
    ['Detected again after recovery — stopping this turn. Consider switching models or starting a new session.', /started repeating myself/],
    ['Model produced no output after 2 nudges — giving up on this turn. Send a message to continue.', /went quiet and would not continue/],
  ]) {
    const text = renderEvent('stream:info', line);
    assert.match(text, expected);
    assert.ok(!text.includes('this turn'), 'console phrasing should not leak into chat');
  }
});

test('a nudge that is still trying stays quiet', () => {
  // Recovery in progress is progress, not an interruption.
  assert.equal(renderEvent('stream:info', 'Model stopped without output or a tool call — nudging it to continue (1/2)…'), '');
  assert.equal(renderEvent('stream:info', 'Injected a commit-and-act directive (1/2) and retrying.'), '');
  assert.equal(renderEvent('stream:info', 'Context compacted (kept 12 turns) — retrying this turn once.'), '');
});
