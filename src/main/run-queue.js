'use strict';

// A durable queue of runs waiting for the current one to finish.
//
// Only one mission runs at a time, and a trigger that fires mid-mission should
// not be lost — but neither should it run blindly hours later. Three things
// this has to get right, none of which come for free:
//
//   staleness      a goal queued at 02:00 may be meaningless, or actively
//                  wrong, by 09:00. Entries expire rather than run.
//   drift          the working tree moves while an entry waits, so branching
//                  and checkpointing belong at dequeue time, not enqueue time.
//                  This module records when an entry was enqueued so callers
//                  can tell; it deliberately does not snapshot the tree.
//   duplication    an hourly trigger firing during a long mission must not
//                  stack eight copies of the same goal.

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000; // six hours
const MAX_ENTRIES = 50;

function queuePath(userDataDir) {
  return path.join(userDataDir, 'missions', 'queue.json');
}

function readQueue(userDataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(queuePath(userDataDir), 'utf8'));
    return Array.isArray(value?.entries) ? value.entries : [];
  } catch {
    return [];
  }
}

function writeQueue(userDataDir, entries) {
  const target = queuePath(userDataDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ entries }, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, target);
  return entries;
}

function isExpired(entry, now) {
  const maxAge = Number(entry?.maxAgeMs) > 0 ? Number(entry.maxAgeMs) : DEFAULT_MAX_AGE_MS;
  return now - Date.parse(entry?.enqueuedAt || 0) > maxAge;
}

// Same trigger, still waiting: replace it. The newer request reflects the more
// recent state of the world, and eight identical goals help nobody.
function enqueue(userDataDir, request, now = Date.now()) {
  if (!request?.goal?.trim()) return { ok: false, error: 'A queued run needs a goal.' };
  if (!request?.cwd) return { ok: false, error: 'A queued run needs a working directory.' };

  const entry = {
    id: `queued-${now}-${Math.random().toString(36).slice(2, 8)}`,
    enqueuedAt: new Date(now).toISOString(),
    ...request,
    goal: request.goal.trim(),
  };

  const kept = readQueue(userDataDir).filter((existing) => {
    if (isExpired(existing, now)) return false;
    if (entry.triggerId && existing.triggerId === entry.triggerId) return false;
    return true;
  });
  kept.push(entry);

  writeQueue(userDataDir, kept.slice(-MAX_ENTRIES));
  return { ok: true, entry, depth: Math.min(kept.length, MAX_ENTRIES) };
}

// Returns the oldest entry that is still worth running, dropping anything that
// aged out along the way. Expired entries are reported so a caller can say what
// it skipped rather than silently discarding work someone asked for.
function dequeue(userDataDir, now = Date.now()) {
  const entries = readQueue(userDataDir);
  const expired = [];
  let next = null;
  const remaining = [];

  for (const entry of entries) {
    if (next) { remaining.push(entry); continue; }
    if (isExpired(entry, now)) { expired.push(entry); continue; }
    next = entry;
  }

  if (next || expired.length) writeQueue(userDataDir, remaining);
  return { entry: next, expired };
}

function peek(userDataDir, now = Date.now()) {
  return readQueue(userDataDir).filter((entry) => !isExpired(entry, now));
}

function clear(userDataDir) {
  writeQueue(userDataDir, []);
}

// Remove only work owned by the caller that cancelled it. A Discord stop in
// one channel must not erase a trigger or a request from another channel.
function cancel(userDataDir, predicate) {
  const removed = [];
  const kept = [];
  for (const entry of readQueue(userDataDir)) {
    if (typeof predicate === 'function' && predicate(entry)) removed.push(entry);
    else kept.push(entry);
  }
  if (removed.length) writeQueue(userDataDir, kept);
  return { removed, remaining: kept };
}

module.exports = {
  enqueue, dequeue, peek, clear, cancel, readQueue, queuePath, isExpired,
  DEFAULT_MAX_AGE_MS, MAX_ENTRIES,
};
