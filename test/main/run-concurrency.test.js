const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

test('one predicate decides whether the agent is busy', () => {
  // The drain asked a narrower question than the thing it was handing work to,
  // which is what let the two disagree.
  const main = read('main.js');
  assert.match(main, /function runInFlight\(\) \{[\s\S]{0,300}return !!activeChatJob \|\| !!currentAbort \|\| !!currentRun \|\| !!activeEventRoute \|\| activeMission\?\.status === 'running';/);
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
  assert.match(task, /setImmediate\(\(\) => \{\s*drainChatRuns\(\)/);
  assert.match(task, /drainRunQueue\(\)/);
  assert.ok(task.indexOf('activeEventRoute = null') < task.indexOf('setImmediate(() => {'),
    'the finished run must release its event route before the next run starts');
});

test('run ownership lasts through final history and delivery work', () => {
  const main = read('main.js');
  assert.match(main, /return !!activeChatJob \|\| !!currentAbort \|\| !!currentRun \|\| !!activeEventRoute/);
  assert.match(main, /status: 'finishing'/);
});

test('window chats are saved first and then execute through one serial queue', () => {
  const main = read('main.js');
  const send = main.slice(main.indexOf("ipcMain.handle('chat:send'"), main.indexOf("ipcMain.handle('chat:send'") + 1800);
  assert.match(send, /const staged = await stageChatJob\(job\);/);
  assert.match(send, /queuedChatRuns\.push\(job\);/);
  assert.ok(send.indexOf('stageChatJob(job)') < send.indexOf('queuedChatRuns.push(job)'), 'the user message must be durable before the request is queued');
  assert.match(send, /stagingChatRuns\.has\(chatId\)/, 'a second click cannot enter while the first durable save is pending');
  assert.match(send, /runInFlight\(\) \|\| queuedChatRuns\.length > 0/, 'a request behind an admitted job must report itself as queued');
  const drain = main.slice(main.indexOf('async function drainChatRuns'), main.indexOf('async function drainChatRuns') + 1200);
  assert.match(drain, /if \(runInFlight\(\) \|\| !queuedChatRuns\.length\) return;/);
  assert.match(drain, /activeChatJob = job;/);
  assert.match(drain, /message\.clientRunId === job\.runId \|\| message\.pendingRunId === job\.runId/,
    'a preparation failure must keep one saved user message, not add a duplicate');
});

test('stop targets one queued chat without changing the global stop action', () => {
  const main = read('main.js');
  const stop = main.slice(main.indexOf("ipcMain.on('chat:stop'"), main.indexOf("ipcMain.handle('chat:reset'"));
  assert.match(stop, /const hasTarget = !!\(wantedChat \|\| wantedRun\);/);
  assert.match(stop, /const queuedIndex = hasTarget/,
    'only a targeted stop can remove a queued chat');
  assert.match(stop, /if \(hasTarget && \(\(wantedChat/,
    'a targeted stop must not abort a different active run');
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
