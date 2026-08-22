'use strict';

// Decision history across runs, and the suggestions it earns.
//
// A single run's deferred list is a tray to read in the morning. Across many
// runs it is evidence: a call that keeps being deferred or parked and is never
// denied by a human is a candidate to promote into a policy's allow list.
// Promotion is never automatic — the aggregate produces suggestions, and a
// person clicks. Widening a policy writes to the userData autonomy.json,
// outside any repository, per the workspace trust rules.

const fs = require('fs');
const path = require('path');

const MAX_RUNS = 500;
const SUGGESTION_MIN = 5;

function logPath(userDataDir) {
  return path.join(userDataDir, 'decisions.json');
}

function readLog(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(logPath(userDataDir), 'utf8'));
    return Array.isArray(parsed?.runs) ? parsed.runs : [];
  } catch {
    return [];
  }
}

function writeLog(userDataDir, runs) {
  const target = logPath(userDataDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ runs }, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, target);
}

// Grouping key: the tool, plus the leading word of a shell command so
// `npm test` and `rm -rf` do not share a bucket.
function keyFor(entry) {
  if (entry.name === 'run_command') {
    const word = String(entry.target || '').trim().split(/\s+/)[0] || '';
    return `run_command:${word}`;
  }
  return entry.name;
}

function record(userDataDir, run, policyId) {
  if (!run?.decisions?.length) return;
  const runs = readLog(userDataDir);
  runs.push({
    runId: run.id,
    policy: policyId || '',
    at: run.startedAt || new Date().toISOString(),
    entries: run.decisions.map((entry) => ({
      name: entry.name, verdict: entry.verdict, target: entry.target || '',
    })),
  });
  writeLog(userDataDir, runs.slice(-MAX_RUNS));
}

// Patterns worth surfacing: held (deferred or parked) at least `min` times,
// denied by a human zero times. A single human denial disqualifies the pattern
// — the evidence now says a person looked at this and said no.
function suggestions(userDataDir, { min = SUGGESTION_MIN } = {}) {
  const groups = new Map();
  for (const run of readLog(userDataDir)) {
    for (const entry of run.entries || []) {
      const key = keyFor(entry);
      const group = groups.get(key) || { key, name: entry.name, held: 0, denied: 0, runs: new Set(), example: '' };
      if (entry.verdict === 'defer' || entry.verdict === 'park') {
        group.held += 1;
        group.runs.add(run.runId);
        if (!group.example && entry.target) group.example = entry.target;
      }
      if (entry.verdict === 'denied') group.denied += 1;
      groups.set(key, group);
    }
  }
  return [...groups.values()]
    .filter((group) => group.held >= min && group.denied === 0)
    .map((group) => ({
      key: group.key, name: group.name, held: group.held,
      runs: group.runs.size, example: group.example,
    }))
    .sort((a, b) => b.held - a.held);
}

// Adds one tool to a CUSTOM policy's allow list in userData/autonomy.json.
// Built-ins are refused — their whole value is that they mean the same thing in
// every install — and a missing policy is an error, not a creation.
function promote(userDataDir, policyId, toolName, builtInIds) {
  if (builtInIds.includes(policyId)) {
    return { ok: false, error: `"${policyId}" is a built-in policy and cannot be widened. Promote into a custom policy (see /policies edit).` };
  }
  const configPath = path.join(userDataDir, 'autonomy.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    return { ok: false, error: `Could not read ${configPath}: ${String(error.message || error)}` };
  }
  const policy = parsed?.policies?.[policyId];
  if (!policy) return { ok: false, error: `No custom policy named "${policyId}" in autonomy.json.` };
  policy.allow = Array.isArray(policy.allow) ? policy.allow : [];
  if (policy.allow.includes(toolName)) return { ok: true, already: true, configPath };
  policy.allow.push(toolName);
  const temporary = configPath + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, configPath);
  return { ok: true, configPath };
}

module.exports = { record, suggestions, promote, readLog, logPath, SUGGESTION_MIN };
