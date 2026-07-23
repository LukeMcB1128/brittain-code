const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { activeMissionPath, readActiveMission, writeActiveMission, interruptRunningMission } = require('../missions');

test('mission state persists atomically in the application data directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-missions-'));
  const mission = { id: 'mission-1', status: 'running', goal: 'Make tests pass' };
  try {
    writeActiveMission(dir, mission);
    assert.equal(fs.existsSync(activeMissionPath(dir) + '.tmp'), false);
    assert.deepEqual(readActiveMission(dir), mission);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a running mission is marked interrupted after an app restart', () => {
  const mission = { id: 'mission-1', status: 'running', currentPhase: 'verification' };
  const interrupted = interruptRunningMission(mission, '2026-07-23T12:00:00.000Z');
  assert.equal(interrupted.status, 'interrupted');
  assert.equal(interrupted.currentPhase, 'interrupted');
  assert.equal(interrupted.endedAt, '2026-07-23T12:00:00.000Z');
  assert.equal(mission.status, 'running');
});
