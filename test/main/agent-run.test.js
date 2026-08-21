const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function agentHandler() {
  const main = read('main.js');
  const start = main.indexOf('async function runAgentMission(');
  assert.ok(start > 0, 'runAgentMission should exist');
  const end = main.indexOf("ipcMain.handle('agent:run'", start);
  assert.ok(end > start, 'the IPC handler should be a wrapper around it');
  return main.slice(start, end);
}

test('an agent run is callable without IPC, so a trigger can start one', () => {
  const main = read('main.js');
  assert.match(main, /async function runAgentMission\(payload = \{\}\) \{/);
  assert.match(main, /ipcMain\.handle\('agent:run', async \(_e, payload = \{\}\) => runAgentMission\(payload\)\)/);
});

test('a request arriving mid-mission is queued rather than refused', () => {
  const body = agentHandler();
  assert.match(body, /enqueueRun\(settingsUserDataDir, payload\)/);
  assert.doesNotMatch(body.slice(0, 400), /return \{ ok: false, error: 'A mission is already running/,
    'decision A chose queueing over refusal');
});

test('/agent is a commitment, not a setting: it always branches and reports', () => {
  const body = agentHandler();
  assert.match(body, /autoBranch: true/, 'an unattended run must be undoable');
  assert.match(body, /beginRun\(\{ attended: false/);
  assert.match(body, /renderRunReport\(finished, activeMission\)/);
  assert.match(body, /notifyRunFinished\(/);
  // The report and decision log are emitted from a finally block, so a run that
  // throws still leaves a record behind.
  assert.match(body, /\} finally \{[\s\S]*renderRunReport/);
});

test('preconditions are checked before anything is started', () => {
  const body = agentHandler();
  const check = body.indexOf('checkPreconditions(');
  const started = body.indexOf('startMission(');
  assert.ok(check > 0 && started > check, 'refusing after starting would leave a half-run mission');
  assert.match(body, /rev-parse', '--abbrev-ref'/, 'the branch is read for the requireBranch check');
});

test('the policy override is scoped to the run and restored afterwards', () => {
  const body = agentHandler();
  assert.match(body, /const previousPolicy = runtimeSettings\.autonomyPolicy/);
  assert.match(body, /\} finally \{\s*runtimeSettings = \{ \.\.\.runtimeSettings, autonomyPolicy: previousPolicy \}/,
    'a --policy flag must not silently become the new default');
});

test('an unattended run writes a transcript that stops when the run does', () => {
  const body = agentHandler();
  assert.match(body, /sink\.configure\(\{ targets: \['renderer', 'file'\], transcriptPath: run\.transcriptPath \}\)/);
  assert.match(read('main.js'), /function endRun\(\) \{\s*const finished = currentRun;\s*sink\.reset\(\)/);
});

test('the decision log renders inline rather than as a panel', () => {
  const app = read('renderer/app.js');
  assert.match(app, /function addDecisionLog\(/);
  assert.match(app, /document\.createElement\('details'\)/, 'one foldable block per run');
  assert.match(app, /window\.api\.onRunDecisions\(addDecisionLog\)/);
  // Decision J chose inline over a panel: no new markup in index.html.
  assert.doesNotMatch(read('renderer/index.html'), /decision-log/);
});

test('the needs-review tray is separated from the rest of the log', () => {
  const app = read('renderer/app.js');
  assert.match(app, /class = 'needs-review'|className = 'needs-review'/);
  assert.match(app, /Not permitted for this unattended run/);
  assert.match(read('renderer/style.css'), /\.decision-log \.needs-review/);
});

test('/agent is wired from the renderer through preload to main', () => {
  assert.match(read('renderer/app.js'), /case 'agent':/);
  assert.match(read('renderer/app.js'), /window\.api\.agentRun\(\{/);
  assert.match(read('preload.js'), /agentRun: \(payload\) => ipcRenderer\.invoke\('agent:run', payload\)/);
  assert.match(read('preload.js'), /onRunDecisions: \(cb\) => ipcRenderer\.on\('run:decisions'/);
  assert.match(read('src/main/run-sink.js'), /'run:decisions',/, 'the channel must be a declared run channel');
});

test('/agent is listed in help and restricted to Code mode', () => {
  const app = read('renderer/app.js');
  assert.match(app, /'\/agent \[--policy <name>\] <goal>/);
  assert.match(app, /'memory', 'ledger', 'agent'\]/);
});
