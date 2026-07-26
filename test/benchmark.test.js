const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { TASKS } = require('../benchmark/tasks');
const { writeReport, aggregate, normalize } = require('../benchmark/report');

// A row shaped like what the V3 grader actually writes. Only rows carrying
// suiteVersion 3 AND the current task version count toward the live
// leaderboard — everything else is archived — so tests that exercise the
// current report must start from this shape.
function currentRow(overrides = {}) {
  return {
    schemaVersion: 3,
    suiteVersion: 3,
    graderVersion: 3,
    scoreModel: 'brittainmark-v3',
    taskLanguage: 'javascript',
    mode: 'solo',
    model: 'model-a',
    modelLabel: 'model-a',
    settings: { think: false, contextCap: 131072 },
    zeroed: false,
    zeroedReasons: [],
    fullPass: false,
    correctness: 55,
    safety: 10,
    reliability: 6,
    efficiency: 2,
    ...overrides,
  };
}

test('benchmark task fixtures are versioned, protected, and intentionally incomplete', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-benchmark-suite-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const [id, task] of Object.entries(TASKS)) {
    const dir = path.join(root, id);
    cp.execFileSync(process.execPath, [path.join(__dirname, '..', 'benchmark', 'setup.js'), '--task', id, '--dir', dir, '--force']);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.brittain-benchmark.json'), 'utf8'));
    assert.equal(manifest.task, id);
    assert.equal(manifest.version, task.version);
    // The spec file is language-specific (test.js / test.ts / test_*.py), but
    // whatever it is called it must be protected from the model.
    const specFile = task.protectedFiles.find((file) => /(^|\/)(test[._-]|.*[._-]test\.)/i.test(file));
    assert.ok(specFile, `${id} must protect a spec/test file`);
    assert.equal(task.protectedFiles.includes('package.json'), true);
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'benchmark', task.promptFile)), true);
    assert.equal(task.targetFiles.every((file) => task.allowedFiles.includes(file)), true);
    assert.equal(fs.existsSync(path.join(dir, specFile)), true, `${id} fixture must contain ${specFile}`);
    const packageJson = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.equal(typeof packageJson.scripts.test, 'string');
    assert.notEqual(packageJson.scripts.test.trim(), '');

    const result = task.evaluate(dir);
    assert.equal(result.visible.total > 0, true);
    assert.equal(result.hidden.total > 0, true);
    assert.equal(result.hidden.pass < result.hidden.total, true, `${id} baseline must fail hidden checks`);
  }
});

test('benchmark suite contains the complete harder coding generation', () => {
  assert.deepEqual(Object.keys(TASKS), ['cart', 'feature', 'debug', 'economy', 'outbox', 'fraudml', 'tsapi']);
  assert.deepEqual(
    Object.fromEntries(Object.entries(TASKS).map(([id, task]) => [id, task.version])),
    { cart: 4, feature: 3, debug: 3, economy: 3, outbox: 2, fraudml: 1, tsapi: 1 },
  );
  // V3 widened the suite past JavaScript — keep that coverage from regressing.
  assert.deepEqual(
    [...new Set(Object.values(TASKS).map((task) => task.language))].sort(),
    ['javascript', 'python', 'typescript'],
  );
});

test('benchmark grader accepts a positional fixture and rejects task mismatches', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-benchmark-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = path.join(root, 'cart');
  const chat = path.join(root, 'chat.json');
  cp.execFileSync(process.execPath, [path.join(__dirname, '..', 'benchmark', 'setup.js'), '--task', 'cart', '--dir', fixture, '--force']);
  fs.writeFileSync(chat, JSON.stringify({ id: 'fixture-chat', cwd: fixture, model: 'test-model', conversation: [] }));

  const accepted = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'benchmark', 'grade.js'), fixture, '--chat', chat, '--dry-run'], { encoding: 'utf8' });
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, new RegExp(`Bench dir : ${fixture.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  const rejected = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'benchmark', 'grade.js'), fixture, '--chat', chat, '--task', 'feature', '--dry-run'], { encoding: 'utf8' });
  assert.equal(rejected.status, 2);
  assert.match(rejected.stderr, /Task mismatch: --task feature does not match the cart fixture/);
  assert.match(rejected.stderr, /No result was saved/);
});

test('benchmark report aggregates repetitions by configuration with median and pass rate', () => {
  const rows = [
    { schemaVersion: 2, configKey: 'same', task: 'cart', mode: 'solo', modelLabel: 'model-a', total: 80, fullPass: false, correctness: 45, reliability: 12, efficiency: 10, wallTimeMs: 3000, generatedTokens: 500, toolCalls: 10 },
    { schemaVersion: 2, configKey: 'same', task: 'cart', mode: 'solo', modelLabel: 'model-a', total: 100, fullPass: true, correctness: 55, reliability: 15, efficiency: 15, wallTimeMs: 1000, generatedTokens: 300, toolCalls: 8 },
    { schemaVersion: 2, configKey: 'same', task: 'cart', mode: 'solo', modelLabel: 'model-a', total: 90, fullPass: true, correctness: 55, reliability: 14, efficiency: 12, wallTimeMs: 2000, generatedTokens: 400, toolCalls: 9 },
  ];
  const [group] = aggregate(rows);
  assert.equal(group.runs, 3);
  assert.equal(group.median, 90);
  assert.equal(group.min, 80);
  assert.equal(group.max, 100);
  assert.equal(group.passRate, 2 / 3);
  assert.equal(group.wallMs, 2000);
});

test('legacy benchmark rows remain report-compatible', () => {
  const row = normalize({ model: 'legacy-model', total: 94, output: 42, discipline: 52, visible: 8, hidden: 6 });
  assert.equal(row.schemaVersion, 1);
  assert.equal(row.task, 'cart');
  assert.equal(row.mode, 'solo');
  assert.equal(row.fullPass, true);
});

test('benchmark report uses readable charts and task, mode, and thinking filters', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-benchmark-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const results = path.join(dir, 'results.json');
  const report = path.join(dir, 'report.html');
  fs.writeFileSync(results, JSON.stringify([
    currentRow({ task: 'cart', taskVersion: TASKS.cart.version, total: 90, correctness: 55, reliability: 13, efficiency: 12, wallTimeMs: 1000, fullPass: true }),
    currentRow({ task: 'feature', taskVersion: TASKS.feature.version, total: 70, correctness: 40, reliability: 10, efficiency: 10, wallTimeMs: 3000, fullPass: false }),
  ]));
  writeReport(results, report);
  const html = fs.readFileSync(report, 'utf8');
  assert.match(html, /class="score-chart"/);
  assert.match(html, /<select id="task">/);
  assert.match(html, /<select id="mode">/);
  assert.match(html, /<select id="think">/);
  assert.match(html, /2 current V3 runs · 0 archived runs/);
  assert.match(html, new RegExp(`requires all ${Object.keys(TASKS).length} tasks`));
  assert.match(html, /data-view-key="feature\|all\|all"/);
  assert.match(html, new RegExp(`cart v${TASKS.cart.version}`));
  assert.match(html, /Archived results \(0 runs\)/);
  assert.doesNotMatch(html, /rotate\(-35/);
});

test('benchmark report excludes older task versions from the current leaderboard', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-benchmark-archive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const results = path.join(dir, 'results.json');
  const report = path.join(dir, 'report.html');
  fs.writeFileSync(results, JSON.stringify([
    currentRow({ task: 'cart', taskVersion: TASKS.cart.version - 1, model: 'old-model', modelLabel: 'old-model', total: 99, correctness: 55, reliability: 15, efficiency: 15 }),
    currentRow({ task: 'cart', taskVersion: TASKS.cart.version, model: 'new-model', modelLabel: 'new-model', total: 80, correctness: 50, reliability: 12, efficiency: 10 }),
  ]));
  writeReport(results, report);
  const html = fs.readFileSync(report, 'utf8');
  assert.match(html, /1 current V3 runs · 1 archived runs/);
  assert.match(html, /Archived results \(1 runs\)/);
  assert.match(html, /preserved here for reference only/);
  assert.match(html, /old-model/);
});
