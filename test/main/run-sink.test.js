const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createRunSink, RUN_CHANNELS } = require('../../src/main/run-sink');

function fakeWindow() {
  const sent = [];
  return {
    sent,
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: { send: (channel, payload, route) => sent.push({ channel, payload, route }) },
  };
}

test('renderer events carry chat identity without changing their payload', () => {
  const win = fakeWindow();
  const route = { chatId: 'chat-a', runId: 'run-a' };
  const sink = createRunSink({ window: win, rendererRoute: () => route });
  sink.token('hello');
  assert.equal(win.sent[0].payload, 'hello');
  assert.deepEqual(win.sent[0].route, route);

  sink.emit('stream:done', { ok: true }, { chatId: 'chat-b', runId: 'run-b' });
  assert.deepEqual(win.sent[1].route, { chatId: 'chat-b', runId: 'run-b' });
});

test('a windowed run still sends the same channels and payloads', () => {
  const win = fakeWindow();
  const sink = createRunSink({ window: win });

  sink.state('thinking');
  sink.info('context past 80%');
  sink.toolCall({ name: 'read_file', args: { path: 'main.js' } });
  sink.toolResult({ name: 'read_file', result: 'contents' });
  sink.stats({ contextTokens: 10 });
  sink.done({ ok: true });

  assert.deepEqual(win.sent.map((entry) => entry.channel), [
    'stream:state', 'stream:info', 'stream:toolcall',
    'stream:toolresult', 'stream:stats', 'stream:done',
  ]);
  assert.deepEqual(win.sent[1].payload, 'context past 80%');
  assert.deepEqual(win.sent[2].payload, { name: 'read_file', args: { path: 'main.js' } });
});

test('a run without a window carries on instead of throwing', () => {
  const sink = createRunSink({ window: null });
  assert.doesNotThrow(() => {
    sink.info('nobody is watching');
    sink.done({ ok: true });
  });
  assert.equal(sink.counters().dropped, 2);
});

test('a window destroyed mid-run stops being written to', () => {
  const win = fakeWindow();
  const sink = createRunSink({ window: () => win });
  sink.info('before');
  win.destroyed = true;
  assert.doesNotThrow(() => sink.info('after'));
  assert.deepEqual(win.sent.map((entry) => entry.payload), ['before']);
});

test('the window is resolved at send time, not captured at construction', () => {
  let current = null;
  const sink = createRunSink({ window: () => current });
  sink.info('dropped');
  current = fakeWindow();
  sink.info('delivered');
  assert.deepEqual(current.sent.map((entry) => entry.payload), ['delivered']);
});

test('a file target writes the narrative but not the token stream', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-sink-'));
  try {
    const transcriptPath = path.join(dir, 'nested', 'run.log');
    const sink = createRunSink({ targets: ['file'], transcriptPath });

    sink.info('starting');
    sink.toolCall({ name: 'write_file', args: { path: 'main.js', content: 'x'.repeat(500) } });
    sink.toolResult({ name: 'write_file', result: 'Wrote 10 lines' });
    sink.token('every');
    sink.token('single');
    sink.stats({ contextTokens: 10 });

    const text = fs.readFileSync(transcriptPath, 'utf8');
    assert.match(text, /starting/);
    assert.match(text, /→ write_file\(path=main\.js/);
    assert.match(text, /← write_file: Wrote 10 lines/);
    assert.doesNotMatch(text, /every|single/, 'the token stream is far too noisy for a transcript');
    assert.doesNotMatch(text, /contextTokens/);
    assert.ok(text.split('\n').filter(Boolean).every((line) => /^\[\d{4}-/.test(line)), 'every line is timestamped');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('long tool arguments are summarized rather than dumped into the transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-sink-'));
  try {
    const transcriptPath = path.join(dir, 'run.log');
    const sink = createRunSink({ targets: ['file'], transcriptPath });
    sink.toolCall({ name: 'write_file', args: { path: 'a.js', content: 'y'.repeat(5000), mode: 'overwrite', extra: 'ignored' } });
    const line = fs.readFileSync(transcriptPath, 'utf8');
    assert.ok(line.length < 400, `transcript line was ${line.length} chars`);
    assert.doesNotMatch(line, /extra=/, 'only the first few arguments are shown');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an unwritable transcript does not take the run down', () => {
  const sink = createRunSink({ targets: ['file'], transcriptPath: '/dev/null/nope/run.log' });
  assert.doesNotThrow(() => sink.info('still running'));
  assert.equal(sink.counters().dropped, 1);
});

test('both targets can be active at once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-sink-'));
  try {
    const win = fakeWindow();
    const transcriptPath = path.join(dir, 'run.log');
    const sink = createRunSink({ window: win, targets: ['renderer', 'file'], transcriptPath });
    sink.info('to both');
    assert.equal(win.sent.length, 1);
    assert.match(fs.readFileSync(transcriptPath, 'utf8'), /to both/);
    assert.deepEqual(sink.targets().sort(), ['file', 'renderer']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every channel a run emits is declared as a run channel', () => {
  for (const channel of ['stream:state', 'stream:info', 'stream:token', 'stream:toolcall',
    'stream:toolresult', 'stream:stats', 'stream:done', 'run:report']) {
    assert.ok(RUN_CHANNELS.has(channel), `${channel} should be a run channel`);
  }
  // An approval genuinely needs the window: unattended, a risky call parks or
  // defers rather than prompting, so requestApproval only ever matters when
  // someone is sitting there.
  assert.equal(RUN_CHANNELS.has('approval:request'), false);
  // A question is different. ask_user is how a run asks the person who started
  // it to clarify, and that person is not always at the window — a run driven
  // from Discord has to be able to answer. Routed straight to win.webContents
  // it asked into the void and the model was told the user had cancelled.
  assert.equal(RUN_CHANNELS.has('question:request'), true);
});

test('no run channel bypasses the sink in main.js', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');

  const direct = [...main.matchAll(/win\.webContents\.send\('([a-z:]+)'/g)].map((match) => match[1]);
  const leaked = direct.filter((channel) => RUN_CHANNELS.has(channel));
  assert.deepEqual(leaked, [], 'run output must go through the sink so a run can survive without a window');

  // What legitimately still talks to the window directly: the approval prompt,
  // which is meaningless without someone watching, and UI state that is not
  // part of a run's narrative. Questions are no longer on this list — they go
  // through the sink so whoever is driving the run can answer.
  // run:external is window controls, not run narrative: it tells this window
  // that something else is driving it so the UI stops claiming to be idle.
  // Pointless to send anywhere but a window, which is the test for this list.
  assert.deepEqual([...new Set(direct)].sort(), [
    'approval:request', 'checkpoint:state', 'mission:update', 'run:external', 'updates:state',
  ]);
});

test('a run can add a file transcript and give it back when it finishes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-sink-'));
  try {
    const win = fakeWindow();
    const sink = createRunSink({ window: win });
    const transcriptPath = path.join(dir, 'run.log');

    sink.info('before the run');
    assert.equal(fs.existsSync(transcriptPath), false);

    sink.configure({ targets: ['renderer', 'file'], transcriptPath });
    sink.info('during the run');
    assert.match(fs.readFileSync(transcriptPath, 'utf8'), /during the run/);

    sink.reset();
    sink.info('after the run');
    const text = fs.readFileSync(transcriptPath, 'utf8');
    assert.doesNotMatch(text, /after the run/, 'a finished run must stop writing to its own transcript');
    assert.equal(sink.transcriptPath(), '');
    // The renderer saw all three either way.
    assert.equal(win.sent.length, 3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
