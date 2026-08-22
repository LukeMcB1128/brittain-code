'use strict';

// Parked calls and the suspended runs that hold them.
//
// When an unattended run hits a call only a human may approve, the run does not
// end without it (that was `defer`) and does not hang (that was `ask`): it
// parks. The call's exact arguments are frozen, the conversation is serialized,
// and the run suspends until someone approves or denies each parked call —
// then it resumes from precisely where it stopped.
//
// The frozen arguments are the contract: what was parked is what runs. A
// parked run_command executes the string that was parked, never a regenerated
// one. And a decision nobody made in six hours is a decision not to — entries
// expire on the same clock as the run queue.

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000; // six hours

function pendingDir(userDataDir) {
  return path.join(userDataDir, 'pending');
}

function pendingPath(userDataDir, runId) {
  return path.join(pendingDir(userDataDir), `${runId}.json`);
}

function save(userDataDir, record) {
  const target = pendingPath(userDataDir, record.runId);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, target);
  return target;
}

function read(userDataDir, runId) {
  try {
    return JSON.parse(fs.readFileSync(pendingPath(userDataDir, runId), 'utf8'));
  } catch {
    return null;
  }
}

function remove(userDataDir, runId) {
  try { fs.unlinkSync(pendingPath(userDataDir, runId)); } catch {}
}

function isExpired(record, now = Date.now()) {
  const maxAge = Number(record?.maxAgeMs) > 0 ? Number(record.maxAgeMs) : DEFAULT_MAX_AGE_MS;
  return now - (Date.parse(record?.suspendedAt || 0) || 0) > maxAge;
}

// Lists suspended runs, deleting the expired on the way through. Expiry is
// reported so the caller can say what aged out rather than losing it silently.
function list(userDataDir, now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(pendingDir(userDataDir)).filter((n) => n.endsWith('.json')); } catch {}
  const records = [];
  const expired = [];
  for (const name of names) {
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(pendingDir(userDataDir), name), 'utf8')); } catch { continue; }
    if (isExpired(record, now)) {
      expired.push(record);
      try { fs.unlinkSync(path.join(pendingDir(userDataDir), name)); } catch {}
    } else {
      records.push(record);
    }
  }
  return { records, expired };
}

// Marks one parked call approved or denied. The record stays on disk — resume
// is a separate, explicit step, so a decision made from a notification does not
// spring the run back to life mid-dinner unless asked to.
function resolveCall(userDataDir, runId, index, approved) {
  const record = read(userDataDir, runId);
  if (!record) return { ok: false, error: `No suspended run "${runId}" — it may have expired.` };
  const call = (record.parked || [])[index];
  if (!call) return { ok: false, error: `Suspended run "${runId}" has no parked call #${index}.` };
  call.decision = approved ? 'approved' : 'denied';
  call.decidedAt = new Date().toISOString();
  save(userDataDir, record);
  return { ok: true, record };
}

module.exports = { save, read, remove, list, resolveCall, isExpired, pendingPath, DEFAULT_MAX_AGE_MS };
