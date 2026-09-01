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
  // A completed assistant message. Distinct from the token stream: whole
  // thoughts, for a listener that cannot render tokens.
  'stream:message',
  'stream:toolcall',
  'stream:toolresult',
  'stream:subagent',
  'stream:stats',
  'stream:done',
  'run:report',
  'run:decisions',
  // A question is part of the run's narrative, not UI chatter: whoever is
  // driving the run has to be able to answer it, and that is not always the
  // window.
  'question:request',
  // What a turn cost. Part of the run's narrative, so an attached client sees
  // it too rather than only the window.
  'stream:cost',
]);

// Only these read as prose in a transcript. Tokens and stats are far too noisy
// to write to a file, and a reader wants the narrative, not the stream.
const TRANSCRIPT_CHANNELS = new Map([
  ['stream:state', (payload) => `· ${payload}`],
  ['stream:info', (payload) => String(payload)],
  ['stream:toolcall', (payload) => `→ ${payload?.name || 'tool'}${summarizeArgs(payload?.args)}`],
  ['stream:toolresult', (payload) => `← ${payload?.name || 'tool'}: ${firstLine(payload?.result)}${payload?.denied ? ' (denied)' : ''}`],
  ['stream:subagent', (payload) => `· subagent: ${firstLine(payload?.text ?? payload)}`],
  ['stream:message', (payload) => `\n${String(payload ?? '')}\n`],
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

function createRunSink({ window, targets = ['renderer'], transcriptPath = '', now = () => new Date(), rendererRoute = () => null } = {}) {
  let active = new Set(targets);
  let currentTranscript = transcriptPath;
  const defaults = { targets: [...targets], transcriptPath };
  let written = 0;
  let dropped = 0;

  function toRenderer(channel, payload, routeOverride) {
    const win = typeof window === 'function' ? window() : window;
    // A destroyed or absent window is an ordinary condition once runs can start
    // without one, not an error worth throwing from inside a loop.
    if (!win || win.isDestroyed?.()) {
      dropped += 1;
      return;
    }
    // Route metadata is a second argument so existing renderer and test
    // consumers that read only the payload keep the same contract.
    win.webContents.send(channel, payload, routeOverride === undefined ? (rendererRoute?.() || null) : routeOverride);
  }

  function toTranscript(channel, payload) {
    const render = TRANSCRIPT_CHANNELS.get(channel);
    if (!render || !currentTranscript) return;
    try {
      const line = render(payload);
      if (!line?.trim()) return;
      fs.mkdirSync(path.dirname(currentTranscript), { recursive: true });
      fs.appendFileSync(currentTranscript, `[${now().toISOString()}] ${line}\n`, 'utf8');
      written += 1;
    } catch {
      // A transcript that cannot be written must not take the run down with it.
      dropped += 1;
    }
  }

  function emit(channel, payload, routeOverride) {
    if (active.has('renderer')) toRenderer(channel, payload, routeOverride);
    if (active.has('file')) toTranscript(channel, payload);
  }

  return {
    // A run decides where its own output goes: an unattended run adds a file
    // transcript, an ordinary one does not. Reset returns to the defaults so a
    // finished run cannot keep writing into its own transcript.
    configure({ targets: wanted, transcriptPath: transcript } = {}) {
      if (wanted) active = new Set(wanted);
      if (transcript !== undefined) currentTranscript = transcript;
    },
    reset() {
      active = new Set(defaults.targets);
      currentTranscript = defaults.transcriptPath;
    },
    transcriptPath: () => currentTranscript,
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
