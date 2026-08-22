const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Source-level wiring assertions in the style of agent-run.test.js: main.js
// cannot be required outside Electron, but the park contract is textual and
// checkable — what suspends, what freezes, what resumes.

const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

test('a park records the frozen call and its park-time classification', () => {
  const main = read('main.js');
  assert.match(main, /currentRun\?\.parked\?\.push\(\{/);
  assert.match(main, /classification: \{ destructive: !!call\.destructive/,
    'resume must be able to detect an escalated classification');
});

test('the run suspends only after the current batch completes', () => {
  const main = read('main.js');
  assert.match(main, /currentRun\?\.parked\?\.some\(\(entry\) => !entry\.decision\)/);
  assert.match(main, /suspendedForApproval = true;/);
});

test('a suspended run is serialized whole and reported as needing a decision', () => {
  const main = read('main.js');
  assert.match(main, /pendingStore\.save\(settingsUserDataDir, \{/);
  assert.match(main, /conversation,\n\s*maxAgeMs/, 'the conversation itself is in the record');
  assert.match(main, /run suspended, needs your approval/);
});

test('resume executes the frozen arguments, never a regenerated call', () => {
  const main = read('main.js');
  assert.match(main, /await safeExecute\(entry\.name, entry\.args, record\.cwd\)/);
  assert.match(main, /await mcp\.call\(entry\.name, entry\.args\)/);
  // Escalation check: approved-then-worse is refused, not upgraded.
  assert.match(main, /\['destructive', 'sensitive', 'financial'\]\.filter\(\(flag\) => now\[flag\] && !was\[flag\]\)/);
});

test('undecided parks at resume are denials, so a resumed run cannot instantly re-suspend', () => {
  const main = read('main.js');
  assert.match(main, /decision: entry\.decision \|\| 'denied', resumed: true/);
});

test('a resume refuses to queue — its restored conversation cannot survive a wait', () => {
  const main = read('main.js');
  assert.match(main, /if \(payload\.resumeRecord\) return \{ ok: false, error: 'Busy/);
});

test('/pending is wired renderer → preload → main', () => {
  assert.match(read('renderer/app.js'), /case 'pending':/);
  assert.match(read('preload.js'), /pendingResume: \(runId\) => ipcRenderer\.invoke\('pending:resume', runId\)/);
  assert.match(read('main.js'), /ipcMain\.handle\('pending:resume'/);
});

test('a suspended run does not claim it hit the step cap', () => {
  // Suspending breaks out of the tool loop with calls still in flight, which
  // looks identical to exhausting the step budget. Reporting a 100-step cap on
  // a run that parked its first call would be plainly false.
  const main = read('main.js');
  assert.match(main, /exhaustedWithToolCalls && !stopRequested && !suspendedForApproval/);
});
