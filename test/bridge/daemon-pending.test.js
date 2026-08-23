const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

test('the daemon serves the park loop, which is what lets an approval travel', () => {
  const main = read('main.js');
  const handlers = main.slice(main.indexOf('daemonServer = daemon.startServer'), main.indexOf('const originalEmit'));
  for (const cmd of ['pending:', 'resolve:', 'resume:', 'stop:', 'run:', 'status:']) {
    assert.ok(handlers.includes(cmd), `the daemon must serve ${cmd}`);
  }
  // Remote resume goes through the same function the app calls, so the
  // re-validation and frozen arguments apply identically.
  assert.match(handlers, /resume: \(\{ runId \}\) => resumeSuspendedRun\(runId\)/);
});

test('a run may wait indefinitely; only run does', () => {
  // A run's reply arrives when the agent finishes, which is minutes away — but
  // a status or pending query that hangs forever would wedge the bridge.
  assert.match(read('src/main/daemon.js'), /const timer = timeoutMs > 0/);
  const bridge = read('scripts/discord-bridge.js');
  assert.match(bridge, /cmd: 'run',[\s\S]{0,400}?\}, 0\);/, 'run waits without a deadline');
  assert.match(bridge, /ask\(\{ cmd: 'status' \}\)/, 'status keeps the default deadline');
});

test('the bridge adds no authority of its own', () => {
  const bridge = read('scripts/discord-bridge.js');
  // It must not execute anything itself, or reach past the daemon.
  for (const forbidden of ['child_process', 'execSync', 'eval(']) {
    assert.ok(!bridge.includes(forbidden), `the bridge must not use ${forbidden}`);
  }
  // Policy comes from config and goes to the daemon; the bridge never picks it.
  assert.match(bridge, /policy: config\.policy/);
  assert.ok(!bridge.includes("policy: 'trusted'"), 'the bridge must not hardcode a permissive policy');
});

test('authorization runs before the message content is used', () => {
  const bridge = read('scripts/discord-bridge.js');
  const authorizeAt = bridge.indexOf('const allowed = authorize(config, message)');
  const handleAt = bridge.indexOf('await handle(config, message');
  assert.ok(authorizeAt > 0 && handleAt > authorizeAt, 'a refused message must never reach the handler');
  assert.match(bridge.slice(authorizeAt, handleAt), /return;/);
});

test('the shipped config is inert until the user fills it in', () => {
  const bridge = read('scripts/discord-bridge.js');
  assert.match(bridge, /enabled: false/);
  assert.match(bridge, /ownerIds: \[\]/);
  assert.match(bridge, /if \(!config\.enabled\) missing\.push/);
});

test('the bridge can reach you without being spoken to first', () => {
  // The notifications that matter most are the unprompted ones — a run parking
  // overnight. Waiting for the user to message first would drop exactly those.
  const bridge = read('scripts/discord-bridge.js');
  assert.match(bridge, /async function resolveNotifyChannel\(config\)/);
  assert.match(bridge, /notifyChannelId/);
  assert.match(bridge, /recipient_id: owner/, 'it opens a DM with the owner when no channel is configured');
  assert.match(bridge, /attach\(config, \(\) => lastChannel \|\| notifyChannel\)/);
  assert.match(bridge, /const notifyChannel = await resolveNotifyChannel\(config\);/);
});
