'use strict';

// Where a run's output goes.
//
// Every progress message used to be posted straight to win.webContents, which
// makes the renderer a hard requirement for running anything: no window, no
// run. Routing run output through a sink puts one seam between producing an
// event and delivering it, so a run can later be delivered somewhere else — a
// file, a notification — or to nobody at all, without touching the loops that
// produce it.
//
// Behaviour for a windowed run is unchanged: same channels, same payloads.

const fs = require('fs');
const path = require('path');

// Channels that carry the narrative of a run. Everything else (settings,
// updates, mission state) is UI chatter and keeps talking to the window
// directly.
const RUN_CHANNELS = new Set([
  'stream:state',
  'stream:info',
  'stream:token',
  'stream:thinking',
  'stream:cleancontent',
  'stream:toolcall',
  'stream:toolresult',
  'stream:subagent',
  'stream:stats',
  'stream:done',
  'run:report',
]);

// Only these read as prose in a transcript. Tokens and stats are far too noisy
// to write to a file, and a reader wants the narrative, not the stream.
const TRANSCRIPT_CHANNELS = new Map([
  ['stream:state', (payload) => `· ${payload}`],
  ['stream:info', (payload) => String(payload)],
  ['stream:toolcall', (payload) => `→ ${payload?.name || 'tool'}${summarizeArgs(payload?.args)}`],
  ['stream:toolresult', (payload) => `← ${payload?.name || 'tool'}: ${firstLine(payload?.result)}${payload?.denied ? ' (denied)' : ''}`],
  ['stream:subagent', (payload) => `· subagent: ${firstLine(payload?.text ?? payload)}`],
  ['run:report', (payload) => `\n${String(payload?.report ?? payload ?? '')}`],
]);

function firstLine(value, max = 300) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max) + '…' : text;
}

function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return '';
  const shown = Object.entries(args)
    .slice(0, 3)
    .map(([key, value]) => `${key}=${firstLine(value, 60)}`)
    .join(' ');
  return shown ? `(${shown})` : '';
}

function createRunSink({ window, targets = ['renderer'], transcriptPath = '', now = () => new Date() } = {}) {
  const active = new Set(targets);
  let written = 0;
  let dropped = 0;

  function toRenderer(channel, payload) {
    const win = typeof window === 'function' ? window() : window;
    // A destroyed or absent window is an ordinary condition once runs can start
    // without one, not an error worth throwing from inside a loop.
    if (!win || win.isDestroyed?.()) {
      dropped += 1;
      return;
    }
    win.webContents.send(channel, payload);
  }

  function toTranscript(channel, payload) {
    const render = TRANSCRIPT_CHANNELS.get(channel);
    if (!render || !transcriptPath) return;
    try {
      const line = render(payload);
      if (!line?.trim()) return;
      fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
      fs.appendFileSync(transcriptPath, `[${now().toISOString()}] ${line}\n`, 'utf8');
      written += 1;
    } catch {
      // A transcript that cannot be written must not take the run down with it.
      dropped += 1;
    }
  }

  function emit(channel, payload) {
    if (active.has('renderer')) toRenderer(channel, payload);
    if (active.has('file')) toTranscript(channel, payload);
  }

  return {
    emit,
    state: (text) => emit('stream:state', text),
    info: (text) => emit('stream:info', text),
    token: (text) => emit('stream:token', text),
    toolCall: (payload) => emit('stream:toolcall', payload),
    toolResult: (payload) => emit('stream:toolresult', payload),
    stats: (payload) => emit('stream:stats', payload),
    done: (payload) => emit('stream:done', payload),
    targets: () => [...active],
    counters: () => ({ written, dropped }),
  };
}

module.exports = { createRunSink, RUN_CHANNELS, TRANSCRIPT_CHANNELS };
