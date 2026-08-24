const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

test('one predicate decides whether the agent is busy', () => {
  // The drain asked a narrower question than the thing it was handing work to,
  // which is what let the two disagree.
  const main = read('main.js');
  assert.match(main, /function runInFlight\(\) \{\s*return !!currentAbort \|\| activeMission\?\.status === 'running';/);
});

test('the queue does not dequeue work it cannot start', () => {
  // It checked only for a running mission, so during an ordinary run it took an
  // entry off the queue, handed it over, and got it put straight back —
  // "Starting queued run" and "Busy — queued" alternating forever.
  const main = read('main.js');
  const drain = main.slice(main.indexOf('async function drainRunQueue'), main.indexOf('async function drainRunQueue') + 300);
  assert.match(drain, /if \(runInFlight\(\)\) return;/);
  assert.ok(!drain.includes("activeMission?.status === 'running'"), 'the narrower check is what caused the livelock');
  // The dequeue must come after the guard, or the entry is already gone.
  assert.ok(drain.indexOf('runInFlight()') < drain.indexOf('dequeueRun'));
});

test('a finished run starts the next queued request without waiting a minute', () => {
  const main = read('main.js');
  const task = main.slice(main.indexOf('async function runAgentTask'), main.indexOf("ipcMain.handle('agent:run'"));
  assert.match(task, /setImmediate\(\(\) => drainRunQueue\(\)/);
  assert.ok(task.indexOf('activeEventRoute = null') < task.indexOf('setImmediate(() => drainRunQueue()'),
    'the finished run must release its event route before the next run starts');
});

test('the window cannot start a second run on top of one already going', () => {
  // A run started elsewhere does not set this window's busy state, so nothing
  // stopped a send landing mid-run. Two loops then shared one conversation and
  // one abort controller.
  const main = read('main.js');
  const send = main.slice(main.indexOf("ipcMain.handle('chat:send'"), main.indexOf("ipcMain.handle('chat:send'") + 900);
  assert.match(send, /if \(runInFlight\(\)\) \{/);
  assert.match(send, /Something is already running\./);
  // Refused before it touches session state.
  assert.ok(send.indexOf('runInFlight()') < send.indexOf("enterSession('window')"));
});

test('the window is told when something else is driving it', () => {
  const main = read('main.js');
  assert.match(main, /win\.webContents\.send\('run:external', \{ active: true, origin: payload\.origin, goal \}\)/);
  assert.match(main, /win\.webContents\.send\('run:external', \{ active: false, origin: payload\.origin, goal \}\)/);
  // Only for runs it did not start itself.
  assert.match(main, /const foreign = \(payload\.origin \|\| 'ui'\) !== 'ui';/);
  assert.match(read('preload.js'), /onExternalRun: \(cb\) => ipcRenderer\.on\('run:external'/);
  assert.match(read('renderer/app.js'), /window\.api\.onExternalRun\(\(\{ active, origin, goal \}\)/);
});

test('the session guard is a diagnostic, not user-facing narration', () => {
  const main = read('main.js');
  assert.match(main, /console\.log\(`Ignored a session switch to/);
  assert.ok(!/sink\.emit\('stream:info', `Ignored a session switch/.test(main),
    'whoever is waiting on the run does not need to hear about internal guards');
});
