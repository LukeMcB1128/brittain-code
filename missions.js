// Durable, single-mission state for Brittain Code. This module deliberately
// contains no Electron dependencies so its storage behavior is testable on
// every supported platform.
const fs = require('fs');
const path = require('path');

function missionsDir(userDataDir) {
  return path.join(userDataDir, 'missions');
}

function activeMissionPath(userDataDir) {
  return path.join(missionsDir(userDataDir), 'active.json');
}

function readActiveMission(userDataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(activeMissionPath(userDataDir), 'utf8'));
    return value && typeof value === 'object' && typeof value.id === 'string' ? value : null;
  } catch {
    return null;
  }
}

function writeActiveMission(userDataDir, mission) {
  const target = activeMissionPath(userDataDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(mission, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, target);
  return mission;
}

function interruptRunningMission(mission, now = new Date().toISOString()) {
  if (!mission || mission.status !== 'running') return mission;
  return {
    ...mission,
    status: 'interrupted',
    currentPhase: 'interrupted',
    lastEvent: 'Brittain Code closed before this mission finished.',
    endedAt: now,
  };
}

module.exports = { missionsDir, activeMissionPath, readActiveMission, writeActiveMission, interruptRunningMission };
