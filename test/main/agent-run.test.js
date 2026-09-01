const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function agentHandler() {
  const main = read('main.js');
  const start = main.indexOf('async function runAgentTask(');
  assert.ok(start > 0, 'runAgentTask should exist');
  const end = main.indexOf("ipcMain.handle('agent:run'", start);
  assert.ok(end > start, 'the IPC handler should be a wrapper around it');
  return main.slice(start, end);
}

test('an agent run is callable without IPC, so a trigger can start one', () => {
  const main = read('main.js');
  assert.match(main, /async function runAgentTask\(payload = \{\}\) \{/);
  // The IPC handler is a thin wrapper, so the same function serves a trigger,
  // the daemon and the Discord bridge. It tags the origin so the run lands in
  // the window's conversation rather than one of its own.
  assert.match(main, /ipcMain\.handle\('agent:run', async \(_e, payload = \{\}\) => runAgentTask\(\{ \.\.\.payload, origin: 'ui' \}\)\)/);
});

test('/agent is a single agent loop, not the mission pipeline', () => {
  const body = agentHandler();
  // "check my emails" must not stand up a planner/coder/verifier — it runs the
  // ordinary single-agent ReAct loop with nobody watching.
  assert.match(body, /await runAgentTurn\(/, 'the agent runs one loop');
  assert.doesNotMatch(body, /startMission\(/, 'it must not route through the mission pipeline');
});

test('a request arriving while busy is queued rather than refused', () => {
  const body = agentHandler();
  assert.match(body, /enqueueRun\(settingsUserDataDir, payload\)/);
  // Busy means any run in flight, not only a mission. That distinction now
  // lives in one predicate, because two places asked it differently and the
  // queue livelocked when they disagreed.
  assert.match(body, /if \(runInFlight\(\)\) \{/);
  assert.match(read('main.js'), /return !!activeChatJob \|\| !!currentAbort \|\| !!currentRun \|\| !!activeEventRoute \|\| activeMission\?\.status === 'running';/);
});

test('/agent always branches, checkpoints, and reports', () => {
  const body = agentHandler();
  assert.match(body, /maybeAutoBranch\(cwd, goal, true\)/, 'an unattended run branches for undo where it can');
  assert.match(body, /await createCheckpoint\(cwd\)/);
  assert.match(body, /beginRun\(\{\s*attended: false/);
  assert.match(body, /renderRunReport\(finished, context\)/);
  assert.match(body, /notifyRunFinished\(/);
  // The report and decision log are emitted from a finally block, so a run that
  // throws still leaves a record behind.
  assert.match(body, /\} finally \{[\s\S]*renderRunReport/);
});

test('the run is treated as unattended so an ask becomes a defer, not a hang', () => {
  const main = read('main.js');
  assert.match(main, /beginRun\(\{\s*attended: false/, 'the agent run declares itself unattended');
  // resolveToolCall reads attended from the run context rather than a caller
  // flag, so every tool call in the loop knows nobody is watching.
  assert.match(main, /const attended = currentRun \? currentRun\.attended : true;/);
});

test('preconditions are checked before the loop starts', () => {
  const body = agentHandler();
  const check = body.indexOf('checkPreconditions(');
  const started = body.indexOf('runAgentTurn(');
  assert.ok(check > 0 && started > check, 'refusing after starting would leave a half-run');
  assert.match(body, /rev-parse', '--abbrev-ref'/, 'the branch is read for the requireBranch check');
});

test('the policy override is scoped to the run and restored afterwards', () => {
  const body = agentHandler();
  assert.match(body, /const previousPolicy = runtimeSettings\.autonomyPolicy/);
  // Restored in the finally block so a --policy flag never becomes the default.
  assert.match(body, /\} finally \{[\s\S]*autonomyPolicy: previousPolicy \}/);
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
  assert.match(app, /window\.api\.onRunDecisions\(\(decision, route\) => \{\s*if \(routeIsVisible\(route\)\) addDecisionLog\(decision\);\s*\}\);/);
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
  assert.match(app, /'ledger', 'agent'\]/);
});

test('a mission runs without a Git repo instead of failing on the checkpoint', () => {
  const main = read('main.js');
  const start = main.indexOf('async function startMission(');
  const end = main.indexOf('ipcMain.handle(\'mission:start\'', start);
  const body = main.slice(start, end);

  // The checkpoint is best-effort: a null result (no repo) must not throw.
  assert.doesNotMatch(body, /if \(!checkpoint\) throw/,
    'a repo-less folder must not fail the mission on a missing checkpoint');
  assert.match(body, /if \(checkpoint\) \{/, 'checkpoint work is guarded on there being one');
  assert.match(body, /recovery: null/, 'a mission with no checkpoint records no recovery');

  // Progress capture and resume both tolerate a null recovery.
  assert.match(main, /if \(!activeMission\.recovery\) \{\s*updateMission\(\{ \.\.\.progress \}\);/);
  assert.match(main, /ran without a Git repository, so there is no checkpoint to resume/);
});

test('the run report compares two complete snapshots', () => {
  // The checkpoint can contain files that are still untracked in the real
  // index. Comparing through that index reports them as deleted and then new.
  // The checkpoint service uses its own index so each file appears once.
  const main = read('main.js');
  const report = main.slice(main.indexOf('async function emitRunReport'), main.indexOf('async function emitRunReport') + 2600);
  assert.match(report, /checkpointService\.diffStat\(cwd, runCheckpoint\)/);
  assert.match(report, /no net file changes since the run checkpoint/);
  assert.match(report, /currentCheckpoint\?\.ref === runCheckpoint\?\.ref/);
  assert.match(report, /if \(undoAvailable\) lines\.push\('UNDO is available/);
  assert.doesNotMatch(report, /new, untracked:/);
});

test('each report is bound to the checkpoint created for that run', () => {
  const main = read('main.js');
  assert.match(main, /runCheckpoint = await createCheckpoint\(cwd\)/);
  assert.match(main, /emitRunReport\(cwd, runLog, runCheckpoint\)/);
  const report = main.slice(main.indexOf('async function emitRunReport'), main.indexOf('async function emitRunReport') + 2500);
  assert.doesNotMatch(report, /const lastCheckpoint = checkpointService\.current\(\)/);
});

test('all successful coding tools contribute paths to the run report', () => {
  const main = read('main.js');
  const outcome = main.slice(main.indexOf("if (toolOutcome === 'ok')"), main.indexOf("if (toolOutcome === 'ok')") + 900);
  assert.match(outcome, /ORCHESTRATION_MUTATING_TOOLS\.has\(name\)/);
  assert.match(outcome, /evidencePaths\(\{ name, args, result \}\)/);
  assert.doesNotMatch(outcome, /args\?\.path/);
});

test('CMake builds count as verification in every agent path', () => {
  const main = read('main.js');
  assert.match(main, /cmake\\s\+--build/);
  assert.equal((main.match(/isVerificationCommand\(/g) || []).length, 3);
});
