const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { captureMissionRecovery, validateMissionRecovery } = require('../../src/main/mission-recovery');

function gitRun(args, cwd) {
  const result = cp.spawnSync('git', args, { cwd, encoding: 'utf8' });
  return Promise.resolve({ ok: result.status === 0, out: result.stdout || '', err: result.stderr || '' });
}

function repository(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-mission-recovery-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  cp.execFileSync('git', ['init', '-q'], { cwd });
  cp.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  cp.execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'base\n');
  cp.execFileSync('git', ['add', '.'], { cwd });
  cp.execFileSync('git', ['commit', '-qm', 'base'], { cwd });
  const head = cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
  const checkpointRef = 'refs/brittain/checkpoints/test';
  cp.execFileSync('git', ['update-ref', checkpointRef, head], { cwd });
  return { cwd, checkpointRef };
}

test('mission recovery validates the project, commit, diff, and checkpoint', async (t) => {
  const { cwd, checkpointRef } = repository(t);
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'changed\n');
  fs.writeFileSync(path.join(cwd, 'untracked.txt'), 'new\n');
  const recovery = await captureMissionRecovery({ cwd, checkpointRef, gitRun });
  const valid = await validateMissionRecovery({ mission: { recovery }, cwd, gitRun });
  assert.equal(valid.ok, true);

  fs.appendFileSync(path.join(cwd, 'untracked.txt'), 'external change\n');
  const changed = await validateMissionRecovery({ mission: { recovery }, cwd, gitRun });
  assert.equal(changed.ok, false);
  assert.match(changed.errors.join('\n'), /working-tree diff changed/);
});

test('mission recovery rejects a missing checkpoint', async (t) => {
  const { cwd, checkpointRef } = repository(t);
  const recovery = await captureMissionRecovery({ cwd, checkpointRef, gitRun });
  cp.execFileSync('git', ['update-ref', '-d', checkpointRef], { cwd });
  const result = await validateMissionRecovery({ mission: { recovery }, cwd, gitRun });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /checkpoint no longer exists/);
});
