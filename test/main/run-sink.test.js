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
    webContents: { send: (channel, payload) => sent.push({ channel, payload }) },
  };
}

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
  // Approval and question requests are interactive, not narrative — they need a
  // human, so they must not be routed through a sink that may have no window.
  assert.equal(RUN_CHANNELS.has('approval:request'), false);
  assert.equal(RUN_CHANNELS.has('question:request'), false);
});

test('no run channel bypasses the sink in main.js', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');

  const direct = [...main.matchAll(/win\.webContents\.send\('([a-z:]+)'/g)].map((match) => match[1]);
  const leaked = direct.filter((channel) => RUN_CHANNELS.has(channel));
  assert.deepEqual(leaked, [], 'run output must go through the sink so a run can survive without a window');

  // What legitimately still talks to the window directly: interactive prompts
  // that require a human, and UI state that is not part of a run's narrative.
  assert.deepEqual([...new Set(direct)].sort(), [
    'approval:request', 'checkpoint:state', 'mission:update', 'question:request', 'updates:state',
  ]);
});
