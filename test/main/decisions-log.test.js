const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const log = require('../../src/main/decisions-log');
const { BUILT_IN } = require('../../src/main/autonomy');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-decisions-'));
}

function runWith(entries, runId = `run-${Math.random()}`) {
  return { id: runId, startedAt: new Date().toISOString(), decisions: entries };
}

test('held-often-never-denied patterns become suggestions; one human denial disqualifies', () => {
  const dir = tempDir();
  for (let i = 0; i < 6; i++) {
    log.record(dir, runWith([
      { name: 'run_command', verdict: 'defer', target: 'npm test' },
      { name: 'write_file', verdict: 'defer', target: 'src/x.js' },
    ]), 'guarded');
  }
  // A human looked at write_file once and said no.
  log.record(dir, runWith([{ name: 'write_file', verdict: 'denied', target: 'src/x.js' }]), 'guarded');
  const suggestions = log.suggestions(dir, { min: 5 });
  assert.deepEqual(suggestions.map((entry) => entry.key), ['run_command:npm']);
  assert.equal(suggestions[0].held, 6);
});

test('run_command groups by leading word so npm and rm never share a bucket', () => {
  const dir = tempDir();
  for (let i = 0; i < 5; i++) {
    log.record(dir, runWith([{ name: 'run_command', verdict: 'park', target: 'npm test' }]));
    log.record(dir, runWith([{ name: 'run_command', verdict: 'park', target: 'rm -rf build' }]));
  }
  const keys = log.suggestions(dir, { min: 5 }).map((entry) => entry.key).sort();
  assert.deepEqual(keys, ['run_command:npm', 'run_command:rm']);
});

test('promotion refuses built-ins — they mean the same thing in every install', () => {
  const dir = tempDir();
  for (const id of Object.keys(BUILT_IN)) {
    const result = log.promote(dir, id, 'run_command', Object.keys(BUILT_IN));
    assert.equal(result.ok, false);
    assert.match(result.error, /built-in/);
  }
});

test('promotion writes into a custom policy allow list, once', () => {
  const dir = tempDir();
  const configPath = path.join(dir, 'autonomy.json');
  fs.writeFileSync(configPath, JSON.stringify({ policies: { mine: { allowRisky: false } } }), 'utf8');
  assert.equal(log.promote(dir, 'mine', 'run_project_check', Object.keys(BUILT_IN)).ok, true);
  const promoted = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.deepEqual(promoted.policies.mine.allow, ['run_project_check']);
  assert.equal(log.promote(dir, 'mine', 'run_project_check', Object.keys(BUILT_IN)).already, true);
  assert.equal(log.promote(dir, 'missing', 'x', Object.keys(BUILT_IN)).ok, false);
});
