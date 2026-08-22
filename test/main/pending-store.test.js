const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../../src/main/pending-store');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pending-'));
}

function record(overrides = {}) {
  return {
    runId: 'run-1',
    goal: 'do the thing',
    cwd: '/tmp/project',
    suspendedAt: new Date().toISOString(),
    parked: [
      { name: 'mcp_gmail_send', args: { to: 'a@b.c' }, reason: 'external MCP tools are never automatic', messageIndex: 4, decision: '' },
    ],
    conversation: [{ role: 'user', content: 'goal' }],
    ...overrides,
  };
}

test('a suspended run round-trips whole: conversation, frozen args and all', () => {
  const dir = tempDir();
  store.save(dir, record());
  const loaded = store.read(dir, 'run-1');
  assert.equal(loaded.goal, 'do the thing');
  assert.deepEqual(loaded.parked[0].args, { to: 'a@b.c' });
  assert.equal(loaded.parked[0].messageIndex, 4);
});

test('resolveCall marks a decision without executing anything', () => {
  const dir = tempDir();
  store.save(dir, record());
  const result = store.resolveCall(dir, 'run-1', 0, true);
  assert.equal(result.ok, true);
  assert.equal(store.read(dir, 'run-1').parked[0].decision, 'approved');
  assert.equal(store.resolveCall(dir, 'run-1', 7, true).ok, false);
  assert.equal(store.resolveCall(dir, 'missing', 0, true).ok, false);
});

test('a decision nobody made in six hours is a decision not to', () => {
  const dir = tempDir();
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  store.save(dir, record({ runId: 'run-old', suspendedAt: old }));
  store.save(dir, record({ runId: 'run-new' }));
  const { records, expired } = store.list(dir);
  assert.deepEqual(records.map((entry) => entry.runId), ['run-new']);
  assert.deepEqual(expired.map((entry) => entry.runId), ['run-old']);
  // The expired record is gone from disk, not lingering.
  assert.equal(store.read(dir, 'run-old'), null);
});

test('remove is idempotent and list survives an empty directory', () => {
  const dir = tempDir();
  store.remove(dir, 'never-existed');
  assert.deepEqual(store.list(dir).records, []);
});
