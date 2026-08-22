const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workspace = require('../../src/main/workspace');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ws-'));
}

test('a project without .brittain has no workspace; init creates one with starters', () => {
  const dir = tempProject();
  assert.equal(workspace.hasWorkspace(dir), false);
  const { created } = workspace.initWorkspace(dir);
  assert.equal(workspace.hasWorkspace(dir), true);
  assert.ok(created.includes('.gitignore'));
  assert.ok(created.includes('HEARTBEAT.md'));
  assert.ok(created.includes('triggers.json'));
  assert.ok(created.includes('MEMORY.md'));
  // The volatile half is ignored; the committed half is not.
  const gitignore = fs.readFileSync(path.join(dir, '.brittain', '.gitignore'), 'utf8');
  assert.match(gitignore, /state\.json/);
  assert.match(gitignore, /runs\//);
  const rules = gitignore.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
  assert.ok(!rules.includes('MEMORY.md') && !rules.includes('HEARTBEAT.md'));
  // Init is idempotent: a second call creates nothing and clobbers nothing.
  fs.writeFileSync(workspace.memoryFile(dir), '- a fact\n', 'utf8');
  assert.equal(workspace.initWorkspace(dir).created.length, 0);
  assert.equal(fs.readFileSync(workspace.memoryFile(dir), 'utf8'), '- a fact\n');
});

test('HEARTBEAT.md parses frontmatter and checklist items', () => {
  const dir = tempProject();
  workspace.initWorkspace(dir);
  fs.writeFileSync(workspace.heartbeatFile(dir), [
    '---', 'interval: 45m', 'policy: trusted', 'quiet: 22:00-07:00', '---', '',
    '- [ ] If CI is red, report.', '- plain item without checkbox', 'not an item',
  ].join('\n'), 'utf8');
  const heartbeat = workspace.readHeartbeat(dir);
  assert.equal(heartbeat.exists, true);
  assert.equal(heartbeat.intervalMs, 45 * 60 * 1000);
  assert.equal(heartbeat.policy, 'trusted');
  assert.deepEqual(heartbeat.items, ['If CI is red, report.', 'plain item without checkbox']);
});

test('the interval floor holds: a heartbeat every minute is a runaway loop', () => {
  assert.equal(workspace.parseInterval('1m'), workspace.MIN_HEARTBEAT_MS);
  assert.equal(workspace.parseInterval('2h'), 2 * 60 * 60 * 1000);
  assert.equal(workspace.parseInterval('garbage'), workspace.DEFAULT_HEARTBEAT_MS);
});

test('quiet hours work across midnight', () => {
  const quiet = workspace.parseQuiet('22:00-07:00');
  const at = (h, m) => new Date(2026, 0, 1, h, m);
  assert.equal(workspace.inQuietHours(quiet, at(23, 0)), true);
  assert.equal(workspace.inQuietHours(quiet, at(3, 0)), true);
  assert.equal(workspace.inQuietHours(quiet, at(12, 0)), false);
  assert.equal(workspace.inQuietHours(null, at(23, 0)), false);
});

test('heartbeatDue respects the interval recorded in state.json', () => {
  const dir = tempProject();
  workspace.initWorkspace(dir);
  fs.writeFileSync(workspace.heartbeatFile(dir), '---\ninterval: 30m\n---\n- [ ] check something\n', 'utf8');
  const noon = new Date(2026, 0, 1, 12, 0);
  assert.equal(workspace.heartbeatDue(dir, noon).due, true);
  workspace.writeState(dir, { lastHeartbeatAt: new Date(2026, 0, 1, 11, 45).toISOString() });
  assert.equal(workspace.heartbeatDue(dir, noon).due, false);
  workspace.writeState(dir, { lastHeartbeatAt: new Date(2026, 0, 1, 11, 15).toISOString() });
  assert.equal(workspace.heartbeatDue(dir, noon).due, true);
});

test('an empty checklist never fires — nothing to evaluate is nothing to run', () => {
  const dir = tempProject();
  workspace.initWorkspace(dir);
  fs.writeFileSync(workspace.heartbeatFile(dir), '---\ninterval: 30m\n---\nno items here\n', 'utf8');
  const result = workspace.heartbeatDue(dir, new Date());
  assert.equal(result.due, false);
  assert.match(result.reason, /checklist/);
});

test('the project autonomy overlay keeps narrowing keys and reports the rest', () => {
  const dir = tempProject();
  workspace.initWorkspace(dir);
  fs.writeFileSync(workspace.autonomyFile(dir), JSON.stringify({
    deny: ['delete_file'], maxToolCalls: 20, network: 'deny',
    allowRisky: true, allow: ['run_command'],
  }), 'utf8');
  const { overlay, ignored } = workspace.readProjectAutonomy(dir);
  assert.deepEqual(Object.keys(overlay).sort(), ['deny', 'maxToolCalls', 'network']);
  assert.deepEqual(ignored.sort(), ['allow', 'allowRisky']);
});

test('the secret scan catches real key shapes, not the word "token"', () => {
  assert.equal(workspace.looksLikeSecret('the API uses token-based auth'), false);
  assert.equal(workspace.looksLikeSecret('tests need the fixtures regenerated after schema changes'), false);
  assert.equal(workspace.looksLikeSecret('AKIAIOSFODNN7EXAMPLE'), true);
  assert.equal(workspace.looksLikeSecret('ghp_' + 'a'.repeat(36)), true);
  assert.equal(workspace.looksLikeSecret('api_key = "sk4f8a9b2c1d0e3f4a5b6c7d8e9f0a1b"'), true);
  assert.equal(workspace.looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----'), true);
});

test('the shipped heartbeat trigger is inert: no checklist, and gated by enablement', () => {
  const dir = tempProject();
  workspace.initWorkspace(dir);

  // The starter checklist is empty, so enabling the trigger still does nothing
  // until someone writes an item they actually want run.
  assert.deepEqual(workspace.readHeartbeat(dir).items, []);
  const due = workspace.heartbeatDue(dir, new Date());
  assert.equal(due.due, false);
  assert.match(due.reason, /checklist/);

  // One gate, not two: the trigger carries no `enabled` field, because project
  // triggers are held by the local enablement registry instead.
  const shipped = JSON.parse(fs.readFileSync(workspace.triggersFile(dir), 'utf8'));
  assert.deepEqual(shipped.triggers, [{ id: 'heartbeat', type: 'heartbeat' }]);
  const projectTriggers = require('../../src/main/project-triggers');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-ws-user-'));
  assert.equal(projectTriggers.enablement(userDataDir, dir, shipped.triggers[0]), 'disabled');
  assert.deepEqual(projectTriggers.firableProjectTriggers(userDataDir, [dir]).firable, []);
});

test('an item commented out is an item that does not run', () => {
  const dir = tempProject();
  workspace.initWorkspace(dir);
  fs.writeFileSync(workspace.heartbeatFile(dir), [
    '---', 'interval: 30m', '---', '',
    '- [ ] live item',
    '<!--', '- [ ] parked item', '-->',
  ].join('\n'), 'utf8');
  assert.deepEqual(workspace.readHeartbeat(dir).items, ['live item']);
});
