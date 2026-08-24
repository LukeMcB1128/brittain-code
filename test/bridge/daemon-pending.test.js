const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

test('the daemon serves the park loop, which is what lets an approval travel', () => {
  const main = read('main.js');
  const handlers = main.slice(main.indexOf('function commandHandlers()'), main.indexOf('function startDiscordBridge'));
  for (const cmd of ['pending:', 'resolve:', 'resume:', 'stop:', 'run:', 'status:']) {
    assert.ok(handlers.includes(cmd), `the daemon must serve ${cmd}`);
  }
  // Remote resume goes through the same function the app calls, so the
  // re-validation and frozen arguments apply identically.
  assert.match(handlers, /resume: \(\{ runId \}\) => resumeSuspendedRun\(runId\)/);
});

test('Discord stop also cancels queued work from the same conversation', () => {
  const main = read('main.js');
  const bridge = read('src/bridge/discord-client.js');
  assert.match(main, /cancelQueuedRuns\(settingsUserDataDir, \(entry\) => entry\.chatId === chatId\)/);
  assert.match(bridge, /chatId: `discord-\$\{channelId\}`,[\s\S]{0,80}cancelQueued: true/);
});

test('a run may wait indefinitely; only run does', () => {
  // A run's reply arrives when the agent finishes, which is minutes away — but
  // a status or pending query that hangs forever would wedge the bridge.
  assert.match(read('src/main/daemon.js'), /const timer = timeoutMs > 0/);
  const bridge = read('src/bridge/discord-client.js');
  assert.match(bridge, /cmd: 'run',[\s\S]{0,400}?\}, 0\);/, 'run waits without a deadline');
  assert.match(bridge, /ask\(\{ cmd: 'status' \}\)/, 'status keeps the default deadline');
});

test('status reports an ordinary agent run as well as a mission', () => {
  const main = read('main.js');
  const bridge = read('src/bridge/discord-client.js');
  assert.match(main, /run: currentRun \? \{/);
  assert.match(main, /goal: currentRun\.goal/);
  assert.match(bridge, /res\.run\?\.status === 'running'/);
});

test('the bridge adds no authority of its own', () => {
  const bridge = read('src/bridge/discord-client.js');
  // It must not execute anything itself, or reach past the daemon.
  for (const forbidden of ['child_process', 'execSync', 'eval(']) {
    assert.ok(!bridge.includes(forbidden), `the bridge must not use ${forbidden}`);
  }
  // Policy comes from config and goes to the daemon; the bridge never picks it
  // at call time. The config template may default to a permissive policy — that
  // is the user's setting to change — but the run payload must always read it
  // from config rather than substituting one.
  assert.match(bridge, /policy: config\.policy/);
  const handler = bridge.slice(bridge.indexOf('async function handle('), bridge.indexOf('// ---------- gateway'));
  assert.ok(!/policy: '[a-z]+'/.test(handler), 'the handler must not substitute a policy of its own');
});

test('authorization runs before the message content is used', () => {
  const bridge = read('src/bridge/discord-client.js');
  const authorizeAt = bridge.indexOf('const allowed = authorize(config, frame.d)');
  const handleAt = bridge.indexOf('await handle(frame.d');
  assert.ok(authorizeAt > 0 && handleAt > authorizeAt, 'a refused message must never reach the handler');
  assert.match(bridge.slice(authorizeAt, handleAt), /return;/);
});

test('the shipped config is inert until the user fills it in', () => {
  const config = read('src/bridge/discord-config.js');
  assert.match(config, /enabled: false/);
  assert.match(config, /ownerIds: \[\]/);
  assert.match(config, /if \(!config\.enabled\) missing\.push\('enabled: true'\)/);
});

test('the bridge can reach you without being spoken to first', () => {
  // The notifications that matter most are the unprompted ones — a run parking
  // overnight. Waiting for the user to message first would drop exactly those.
  const bridge = read('src/bridge/discord-client.js');
  assert.match(bridge, /async function resolveNotifyChannel\(\)/);
  assert.match(bridge, /notifyChannelId/);
  assert.match(bridge, /recipient_id: owner/, 'it opens a DM with the owner when no channel is configured');
  assert.match(bridge, /const target = eventTarget\(route, notifyChannel\);/, 'each event resolves its declared destination');
  assert.match(bridge, /notifyChannel = await resolveNotifyChannel\(\);/);
});

test('the bridge ships with the app, not just the checkout', () => {
  // scripts/ is not in the packaged build, so a bridge that lived only there
  // would work in development and silently not exist for anyone else.
  const build = require('../../package.json').build.files;
  const shipped = (name) => build.some((glob) => glob === name || (glob.endsWith('/**') && name.startsWith(glob.slice(0, -3))));
  assert.ok(shipped('src/bridge/discord-client.js'), 'the bridge core must be packaged');
  assert.ok(shipped('src/bridge/discord-config.js'), 'its config must be packaged');
  assert.ok(!shipped('scripts/discord-bridge.js'), 'the standalone runner is a dev convenience, not the product path');
});

test('exactly one process holds the Discord connection', () => {
  // Two bots would answer every message twice. The connection follows the
  // trigger scheduler: the daemon owns both, or the window does when no daemon
  // is running.
  const main = read('main.js');
  const windowed = main.slice(main.indexOf('createWindow();'), main.indexOf('const packageMetadata'));
  assert.match(windowed, /daemon\.daemonAlive/);
  assert.match(windowed, /startDiscordBridge\(commandHandlers\(\)\)/);
  // The live-daemon branch starts neither.
  const [ifDaemonAlive] = windowed.split('} else {');
  assert.ok(!ifDaemonAlive.includes('startDiscordBridge('), 'a window must not start a second bridge beside the daemon');
});

test('both transports drive the same handler map', () => {
  // The socket path and the in-process path must not be able to diverge in
  // what they can reach.
  const main = read('main.js');
  assert.match(main, /daemonServer = daemon\.startServer\(settingsUserDataDir, handlers\)/);
  assert.match(main, /startDiscordBridge\(handlers\)/);
  assert.match(read('scripts/discord-bridge.js'), /createDiscordBridge\(/, 'the standalone runner reuses the same client');
});
