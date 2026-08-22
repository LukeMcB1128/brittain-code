const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseSchedule, matchesSchedule, dueTriggers, validateTrigger,
  readTriggers, ensureConfig, configPath, EXAMPLE_CONFIG,
} = require('../../src/main/triggers');

const at = (hour, minute, day = 21, month = 8, year = 2026) => new Date(year, month - 1, day, hour, minute);
const fires = (schedule, date) => matchesSchedule(parseSchedule(schedule), date);

test('a fixed time fires only at that time', () => {
  assert.equal(fires('0 2 * * *', at(2, 0)), true);
  assert.equal(fires('0 2 * * *', at(2, 1)), false);
  assert.equal(fires('0 2 * * *', at(3, 0)), false);
});

test('steps, ranges, and lists all work', () => {
  assert.equal(fires('*/15 * * * *', at(9, 30)), true);
  assert.equal(fires('*/15 * * * *', at(9, 31)), false);
  assert.equal(fires('0 9-17 * * *', at(13, 0)), true);
  assert.equal(fires('0 9-17 * * *', at(18, 0)), false);
  assert.equal(fires('0 9,17 * * *', at(17, 0)), true);
  assert.equal(fires('0 9,17 * * *', at(12, 0)), false);
});

test('weekdays match, and Sunday works spelled either way', () => {
  const sunday = at(2, 0, 23); // 2026-08-23 is a Sunday
  assert.equal(sunday.getDay(), 0);
  assert.equal(fires('0 2 * * 0', sunday), true);
  assert.equal(fires('0 2 * * 7', sunday), true);
  assert.equal(fires('0 2 * * 1', sunday), false);
});

test('a schedule this app does not understand is rejected, not guessed at', () => {
  for (const bad of ['', 'nonsense', '0 2 * *', '0 2 * * * *', '99 2 * * *', '0 2 * * 9', '0 2 * * */0']) {
    assert.equal(parseSchedule(bad), null, `${bad} should not parse`);
    assert.equal(matchesSchedule(parseSchedule(bad), at(2, 0)), false);
  }
});

const trigger = (over = {}) => ({
  id: 'nightly', enabled: true, schedule: '0 2 * * *',
  cwd: '/project', goal: 'run the tests', ...over,
});

test('a trigger fires once per minute even if the tick lands twice', () => {
  const now = at(2, 0);
  const first = dueTriggers([trigger()], now);
  assert.equal(first.length, 1);

  const lastFired = { nightly: first[0].minuteKey };
  assert.deepEqual(dueTriggers([trigger()], now, lastFired), [],
    'a second tick in the same minute must not fire it again');
  assert.equal(dueTriggers([trigger()], at(2, 0, 22), lastFired).length, 1, 'the next day still fires');
});

test('a disabled or invalid trigger never fires', () => {
  assert.deepEqual(dueTriggers([trigger({ enabled: false })], at(2, 0)), []);
  assert.deepEqual(dueTriggers([trigger({ goal: '' })], at(2, 0)), []);
  assert.deepEqual(dueTriggers([trigger({ cwd: '' })], at(2, 0)), []);
  assert.deepEqual(dueTriggers([trigger({ schedule: 'whenever' })], at(2, 0)), []);
});

test('a broken trigger does not stop its neighbours from firing', () => {
  const due = dueTriggers([trigger({ id: 'broken', schedule: 'nope' }), trigger({ id: 'good' })], at(2, 0));
  assert.deepEqual(due.map((entry) => entry.trigger.id), ['good']);
});

test('validation says what is missing rather than failing silently', () => {
  assert.match(validateTrigger({}), /id/);
  assert.match(validateTrigger({ id: 'x' }), /goal/);
  assert.match(validateTrigger({ id: 'x', goal: 'g' }), /working directory/);
  assert.match(validateTrigger({ id: 'x', goal: 'g', cwd: '/p', schedule: 'nope' }), /not a schedule/);
  assert.equal(validateTrigger(trigger()), '');
});

test('a missing config reads as no triggers, a corrupt one reports the error', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-trig-'));
  try {
    assert.deepEqual(readTriggers(dir), { triggers: [], error: '' });

    fs.writeFileSync(configPath(dir), 'not json', 'utf8');
    const broken = readTriggers(dir);
    assert.deepEqual(broken.triggers, []);
    assert.ok(broken.error, 'a corrupt file should be reported, not silently ignored');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the config is created disabled, so nothing runs until it is edited', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-trig-'));
  try {
    const created = ensureConfig(dir);
    assert.ok(fs.existsSync(created));
    const { triggers } = readTriggers(dir);
    assert.equal(triggers.length, 2, 'a cron example and a heartbeat example');
    for (const trigger of triggers) {
      assert.equal(trigger.enabled, false, 'a generated example must never fire on its own');
    }
    assert.deepEqual(dueTriggers(triggers, at(2, 0)), []);

    // Writing again must not overwrite what the user has since edited.
    fs.writeFileSync(created, JSON.stringify({ triggers: [] }), 'utf8');
    ensureConfig(dir);
    assert.deepEqual(readTriggers(dir).triggers, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the shipped example is itself valid apart from its placeholder path', () => {
  const example = EXAMPLE_CONFIG.triggers[0];
  assert.equal(validateTrigger(example), '', 'the example must parse, or it teaches the wrong shape');
  assert.equal(example.enabled, false);
});

test('the scheduler is wired into app startup and drains the queue before firing', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  assert.match(main, /startTriggerScheduler\(\);/);
  assert.match(main, /triggerTimer = setInterval\(/);
  // The queue is drained first: a run that has been waiting should not be
  // overtaken by one whose schedule happens to land on the same tick.
  assert.match(main, /await drainRunQueue\(\);\s*await fireDueTriggers\(\);/);
  // A throwing tick would stop the scheduler for the rest of the session.
  assert.match(main, /\} catch \{[\s\S]{0,120}\}\s*\}, 60_000\)/);
});

test('a trigger becomes a run without inheriting interactive defaults', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  const start = main.indexOf('function triggerToRequest(');
  const body = main.slice(start, main.indexOf('async function fireDueTriggers', start));
  assert.match(body, /onlineResearch: false/, 'a scheduled run must not silently reach the network');
  assert.match(body, /triggerId: trigger\.id/, 'the id is what lets the queue de-duplicate');
});

test('/agent trigger is wired from the renderer through preload to main', () => {
  const root = path.join(__dirname, '..', '..');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(read('renderer/app.js'), /window\.api\.triggersState\(/);
  assert.match(read('renderer/app.js'), /window\.api\.triggersRun\(id\)/);
  assert.match(read('renderer/app.js'), /window\.api\.triggersOpenConfig\(\)/);
  assert.match(read('renderer/app.js'), /Triggers only fire while Brittain Code is open/,
    'the app-must-be-open limit should be stated where it is felt');
  assert.match(read('preload.js'), /triggersState: \(cwd\) => ipcRenderer\.invoke\('triggers:state', cwd\)/);
  for (const channel of ['triggers:state', 'triggers:run', 'triggers:openConfig']) {
    assert.match(read('main.js'), new RegExp(`ipcMain\\.handle\\('${channel}'`));
  }
});

test('a heartbeat trigger validates with no goal and no schedule — its pacing lives in HEARTBEAT.md', () => {
  assert.equal(validateTrigger({ id: 'hb', type: 'heartbeat', cwd: '/tmp/project' }), '');
  assert.notEqual(validateTrigger({ type: 'heartbeat', cwd: '/tmp/project' }), '');
  assert.notEqual(validateTrigger({ id: 'hb', type: 'heartbeat' }), '');
});

test('heartbeat triggers never enter the cron matcher', () => {
  const triggers = [
    { id: 'hb', type: 'heartbeat', cwd: '/tmp/project' },
    { id: 'cron', schedule: '30 14 * * *', goal: 'x', cwd: '/tmp/project' },
  ];
  const due = dueTriggers(triggers, new Date(2026, 0, 1, 14, 30));
  assert.deepEqual(due.map((entry) => entry.trigger.id), ['cron']);
});
