const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { TASKS } = require('../benchmark/tasks');
const { writeReport, aggregate, normalize } = require('../benchmark/report');

test('benchmark task fixtures are versioned, protected, and intentionally incomplete', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-benchmark-suite-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  for (const [id, task] of Object.entries(TASKS)) {
    const dir = path.join(root, id);
    cp.execFileSync(process.execPath, [path.join(__dirname, '..', 'benchmark', 'setup.js'), '--task', id, '--dir', dir, '--force']);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.brittain-benchmark.json'), 'utf8'));
    assert.equal(manifest.task, id);
    assert.equal(manifest.version, task.version);
    assert.equal(task.protectedFiles.includes('test.js'), true);

    const result = task.evaluate(dir);
    assert.equal(result.visible.total > 0, true);
    assert.equal(result.hidden.total > 0, true);
    assert.equal(result.hidden.pass < result.hidden.total, true, `${id} baseline must fail hidden checks`);
  }
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
  fs.writeFileSync(results, JSON.stringify([{
    schemaVersion: 2,
    configKey: 'cart|solo|model-a|think=false',
    task: 'cart',
    mode: 'solo',
    modelLabel: 'model-a',
    settings: { think: false, contextCap: 131072 },
    total: 90,
    correctness: 55,
    reliability: 13,
    efficiency: 12,
    wallTimeMs: 1000,
    fullPass: true,
  }, {
    schemaVersion: 2,
    configKey: 'feature|solo|model-a|think=false',
    task: 'feature',
    mode: 'solo',
    modelLabel: 'model-a',
    settings: { think: false, contextCap: 131072 },
    total: 70,
    correctness: 40,
    reliability: 10,
    efficiency: 10,
    wallTimeMs: 3000,
    fullPass: false,
  }]));
  writeReport(results, report);
  const html = fs.readFileSync(report, 'utf8');
  assert.match(html, /class="score-chart"/);
  assert.match(html, /class="legend-item"/);
  assert.match(html, /<select id="think">/);
  assert.match(html, /tasks 2\/2/);
  assert.match(html, /data-view-key="feature\|all\|all"/);
  assert.doesNotMatch(html, /rotate\(-35/);
});
