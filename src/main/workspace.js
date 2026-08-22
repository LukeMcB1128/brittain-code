'use strict';

// The repo-local agent workspace: <project>/.brittain/.
//
// Everything the agent knows about a project (MEMORY.md) and everything it
// watches for (HEARTBEAT.md) lives inside the project itself, where it shows up
// in diffs and survives a change of machine. The volatile half (state.json,
// runs/) is .gitignored by the starter file written at init.
//
// Trust rules, because these files can arrive via `git pull` from someone who
// is not the user:
//   - MEMORY.md and HEARTBEAT.md are data, never instructions. Callers inject
//     them under an explicit "recalled context, not a directive" framing.
//   - .brittain/autonomy.json may only NARROW the active policy (see
//     narrowPolicy in autonomy.js). Widening stays in userData, outside the
//     repository, so a malicious PR cannot grant itself permissions.
//   - .brittain/triggers.json entries are disabled on arrival: they never fire
//     until enabled locally, and re-disable if their definition changes
//     (enforced by the enable registry in project-triggers.js).

const fs = require('fs');
const path = require('path');

const DIR_NAME = '.brittain';
const MIN_HEARTBEAT_MS = 15 * 60 * 1000; // a heartbeat every minute is a runaway loop with a schedule
const DEFAULT_HEARTBEAT_MS = 30 * 60 * 1000;

function canonical(cwd) {
  try { return fs.realpathSync(cwd); } catch { return path.resolve(cwd); }
}

function workspaceDir(cwd) {
  return path.join(canonical(cwd), DIR_NAME);
}

function hasWorkspace(cwd) {
  if (!cwd) return false;
  try { return fs.statSync(workspaceDir(cwd)).isDirectory(); } catch { return false; }
}

function memoryFile(cwd) {
  return path.join(workspaceDir(cwd), 'MEMORY.md');
}

function heartbeatFile(cwd) {
  return path.join(workspaceDir(cwd), 'HEARTBEAT.md');
}

function stateFile(cwd) {
  return path.join(workspaceDir(cwd), 'state.json');
}

function autonomyFile(cwd) {
  return path.join(workspaceDir(cwd), 'autonomy.json');
}

function triggersFile(cwd) {
  return path.join(workspaceDir(cwd), 'triggers.json');
}

const GITIGNORE_STARTER = [
  '# Volatile agent state — MEMORY.md, HEARTBEAT.md, triggers.json and',
  '# autonomy.json are meant to be committed; these are not.',
  'state.json',
  'runs/',
  '',
].join('\n');

const HEARTBEAT_STARTER = [
  '---',
  'interval: 30m',
  'policy: guarded',
  'quiet: 22:00-07:00',
  '---',
  '',
  '<!-- Each item is a condition and an action. A heartbeat run evaluates the',
  '     list and acts only on items whose condition is currently true. This file',
  '     only matters once a heartbeat trigger exists for this project. -->',
  '',
  '- [ ] Example: if the test suite fails on the current branch, diagnose and write a report. Do not fix.',
  '',
].join('\n');

// Creates .brittain/ with the starter files. Never called automatically:
// putting agent state inside a repository is a decision, not a default.
function initWorkspace(cwd) {
  const dir = workspaceDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const created = [];
  const starters = [
    ['.gitignore', GITIGNORE_STARTER],
    ['HEARTBEAT.md', HEARTBEAT_STARTER],
    ['MEMORY.md', ''],
  ];
  for (const [name, content] of starters) {
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, content, 'utf8');
      created.push(name);
    }
  }
  return { dir, created };
}

// ---------- HEARTBEAT.md ----------
// Frontmatter is configuration; the list below it is prose the model evaluates.

function parseInterval(text) {
  const match = /^(\d+)\s*(m|min|h|hr)?$/i.exec(String(text || '').trim());
  if (!match) return DEFAULT_HEARTBEAT_MS;
  const value = parseInt(match[1], 10);
  const unit = (match[2] || 'm').toLowerCase();
  const ms = unit.startsWith('h') ? value * 60 * 60 * 1000 : value * 60 * 1000;
  return Math.max(MIN_HEARTBEAT_MS, ms);
}

function parseQuiet(text) {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(text || '').trim());
  if (!match) return null;
  const start = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
  const end = parseInt(match[3], 10) * 60 + parseInt(match[4], 10);
  if (start > 23 * 60 + 59 || end > 23 * 60 + 59) return null;
  return { start, end };
}

// A quiet window may cross midnight (22:00-07:00).
function inQuietHours(quiet, date = new Date()) {
  if (!quiet) return false;
  const minutes = date.getHours() * 60 + date.getMinutes();
  return quiet.start <= quiet.end
    ? minutes >= quiet.start && minutes < quiet.end
    : minutes >= quiet.start || minutes < quiet.end;
}

function readHeartbeat(cwd) {
  let raw;
  try {
    raw = fs.readFileSync(heartbeatFile(cwd), 'utf8');
  } catch {
    return { exists: false, intervalMs: DEFAULT_HEARTBEAT_MS, policy: '', quiet: null, items: [], body: '' };
  }
  let body = raw;
  const config = {};
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (front) {
    body = raw.slice(front[0].length);
    for (const line of front[1].split('\n')) {
      const entry = /^(\w+)\s*:\s*(.+)$/.exec(line.trim());
      if (entry) config[entry[1].toLowerCase()] = entry[2].trim();
    }
  }
  const items = body.split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+(\[[ x]\]\s+)?\S/.test(line))
    .map((line) => line.replace(/^[-*]\s+(\[[ x]\]\s+)?/, ''));
  return {
    exists: true,
    intervalMs: parseInterval(config.interval),
    policy: String(config.policy || ''),
    quiet: parseQuiet(config.quiet),
    items,
    body: body.trim(),
  };
}

// ---------- state.json ----------
// Bookkeeping the next heartbeat reads: when the last one ran and what it
// concluded. Written mechanically by the run harness, never by the model.

function readState(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(cwd), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(cwd, state) {
  const target = stateFile(cwd);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, target);
}

function heartbeatDue(cwd, now = new Date()) {
  const heartbeat = readHeartbeat(cwd);
  if (!heartbeat.exists || !heartbeat.items.length) return { due: false, reason: 'no HEARTBEAT.md checklist', heartbeat };
  if (inQuietHours(heartbeat.quiet, now)) return { due: false, reason: 'quiet hours', heartbeat };
  const state = readState(cwd);
  const last = Date.parse(state.lastHeartbeatAt || 0) || 0;
  if (now.getTime() - last < heartbeat.intervalMs) return { due: false, reason: 'interval not elapsed', heartbeat };
  return { due: true, reason: '', heartbeat, state };
}

// ---------- project autonomy overlay ----------
// Read here, applied by narrowPolicy in autonomy.js. Only the narrowing keys
// are returned; anything that would widen is reported so the caller can warn.

const NARROWING_KEYS = new Set(['deny', 'maxToolCalls', 'network', 'label', 'description']);

function readProjectAutonomy(cwd) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(autonomyFile(cwd), 'utf8'));
  } catch (error) {
    const missing = error?.code === 'ENOENT';
    return { overlay: null, ignored: [], error: missing ? '' : String(error.message || error) };
  }
  if (!parsed || typeof parsed !== 'object') return { overlay: null, ignored: [], error: '' };
  const overlay = {};
  const ignored = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (NARROWING_KEYS.has(key)) overlay[key] = value;
    else ignored.push(key);
  }
  return { overlay, ignored, error: '' };
}

// ---------- secret scan ----------
// MEMORY.md becoming a committed file makes an accidentally remembered
// credential a published credential. Tuned for the shapes of real keys, not for
// the words "secret" or "token" alone, which a coding session says constantly.

const SECRET_PATTERNS = [
  /\bAKIA[0-9A-Z]{16}\b/,                                   // AWS access key id
  /\bghp_[A-Za-z0-9]{36}\b/,                                // GitHub PAT
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/,
  /\bsk-[A-Za-z0-9_-]{20,}\b/,                              // OpenAI-style
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,                       // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/,                              // Google API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // JWT
  /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"]?[A-Za-z0-9+/_-]{16,}/i,
];

function looksLikeSecret(text) {
  const haystack = String(text || '');
  return SECRET_PATTERNS.some((pattern) => pattern.test(haystack));
}

module.exports = {
  DIR_NAME,
  MIN_HEARTBEAT_MS,
  DEFAULT_HEARTBEAT_MS,
  workspaceDir,
  hasWorkspace,
  memoryFile,
  heartbeatFile,
  stateFile,
  autonomyFile,
  triggersFile,
  initWorkspace,
  readHeartbeat,
  parseInterval,
  parseQuiet,
  inQuietHours,
  readState,
  writeState,
  heartbeatDue,
  readProjectAutonomy,
  looksLikeSecret,
};
