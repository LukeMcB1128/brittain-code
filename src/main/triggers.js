'use strict';

// Cron-shaped triggers, read from a plain file the user owns.
//
// The scheduler is deliberately small: a minute-resolution tick over a list of
// entries. That is ample for a desktop app, needs no dependency, and keeps the
// whole trigger surface auditable in one file.
//
// It only fires while the app is running (decision C). A launchd/Scheduled Task
// that boots the app headless is a separate, larger piece of work.

const fs = require('fs');
const path = require('path');

function configPath(userDataDir) {
  return path.join(userDataDir, 'triggers.json');
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  // 0-7, because Sunday is written both ways in the wild; 7 is folded onto 0
  // when matching rather than rejected as out of range.
  { name: 'weekday', min: 0, max: 7 },
];

// Supports the subset people actually write: *, N, a-b, */n, and comma lists.
function parseField(text, { min, max }) {
  const values = new Set();
  for (const part of String(text).split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText ? parseInt(stepText, 10) : 1;
    if (!Number.isInteger(step) || step < 1) return null;

    let low = min;
    let high = max;
    if (range !== '*') {
      const bounds = range.split('-');
      low = parseInt(bounds[0], 10);
      high = bounds.length > 1 ? parseInt(bounds[1], 10) : low;
      if (!Number.isInteger(low) || !Number.isInteger(high)) return null;
      if (low < min || high > max || low > high) return null;
    }
    for (let value = low; value <= high; value += step) values.add(value);
  }
  return values.size ? values : null;
}

function parseSchedule(schedule) {
  const parts = String(schedule || '').trim().split(/\s+/);
  if (parts.length !== FIELDS.length) return null;
  const parsed = [];
  for (let i = 0; i < FIELDS.length; i++) {
    const values = parseField(parts[i], FIELDS[i]);
    if (!values) return null;
    parsed.push(values);
  }
  return parsed;
}

// Sunday is both 0 and 7 in the wild; normalize so either spelling works.
function matchesSchedule(parsed, date) {
  if (!parsed) return false;
  const [minute, hour, day, month, weekday] = parsed;
  const dow = date.getDay();
  return minute.has(date.getMinutes())
    && hour.has(date.getHours())
    && day.has(date.getDate())
    && month.has(date.getMonth() + 1)
    && (weekday.has(dow) || (dow === 0 && weekday.has(7)));
}

function readTriggers(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(userDataDir), 'utf8'));
    const list = Array.isArray(parsed?.triggers) ? parsed.triggers : [];
    return { triggers: list, error: '' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { triggers: [], error: '' };
    return { triggers: [], error: String(error.message || error) };
  }
}

function validateTrigger(trigger) {
  if (!trigger?.id) return 'a trigger needs an id';
  if (!trigger.goal?.trim()) return 'a trigger needs a goal';
  if (!trigger.cwd) return 'a trigger needs a working directory';
  if (!parseSchedule(trigger.schedule)) return `"${trigger.schedule}" is not a schedule this app understands`;
  return '';
}

// Triggers that should fire at `date`. `lastFired` maps trigger id to the
// minute it last ran, so a tick landing twice inside the same minute — or a
// tick that arrives slightly late — cannot fire the same trigger twice.
function dueTriggers(triggers, date, lastFired = {}) {
  const minuteKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}-${date.getHours()}-${date.getMinutes()}`;
  const due = [];
  for (const trigger of triggers) {
    if (trigger.enabled === false) continue;
    if (validateTrigger(trigger)) continue;
    if (lastFired[trigger.id] === minuteKey) continue;
    if (!matchesSchedule(parseSchedule(trigger.schedule), date)) continue;
    due.push({ trigger, minuteKey });
  }
  return due;
}

const EXAMPLE_CONFIG = {
  triggers: [
    {
      id: 'nightly-check',
      enabled: false,
      schedule: '0 2 * * *',
      cwd: '/absolute/path/to/your/project',
      goal: 'Run the test suite. If anything fails, diagnose and report — do not fix.',
      policy: 'guarded',
      maxIterations: 6,
    },
  ],
};

function ensureConfig(userDataDir) {
  const target = configPath(userDataDir);
  try {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(EXAMPLE_CONFIG, null, 2) + '\n', 'utf8');
    }
  } catch {}
  return target;
}

module.exports = {
  configPath, readTriggers, validateTrigger, dueTriggers,
  parseSchedule, matchesSchedule, ensureConfig, EXAMPLE_CONFIG,
};
