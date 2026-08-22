const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectTriggers = require('../../src/main/project-triggers');

function setup() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pt-user-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-pt-proj-'));
  fs.mkdirSync(path.join(project, '.brittain'));
  return { userDataDir, project };
}

function writeTriggers(project, triggers) {
  fs.writeFileSync(path.join(project, '.brittain', 'triggers.json'), JSON.stringify({ triggers }), 'utf8');
}

const nightly = { id: 'nightly', schedule: '0 2 * * *', goal: 'run tests', cwd: '' };

test('a trigger arriving in the repository is disabled until enabled locally', () => {
  const { userDataDir, project } = setup();
  writeTriggers(project, [nightly]);
  assert.equal(projectTriggers.enablement(userDataDir, project, nightly), 'disabled');
  assert.deepEqual(projectTriggers.firableProjectTriggers(userDataDir, [project]).firable, []);

  projectTriggers.enable(userDataDir, project, nightly);
  assert.equal(projectTriggers.enablement(userDataDir, project, nightly), 'enabled');
  const { firable } = projectTriggers.firableProjectTriggers(userDataDir, [project]);
  assert.equal(firable.length, 1);
  assert.equal(firable[0].cwd, project, 'a trigger without its own cwd runs in its project');
});

test('a pulled change to an enabled trigger drops it back to disabled, with a warning', () => {
  const { userDataDir, project } = setup();
  writeTriggers(project, [nightly]);
  projectTriggers.enable(userDataDir, project, nightly);

  // Someone edits the goal upstream; the pull changes the definition.
  const edited = { ...nightly, goal: 'run tests and push a fix' };
  writeTriggers(project, [edited]);
  assert.equal(projectTriggers.enablement(userDataDir, project, edited), 'changed');
  const { firable, warnings } = projectTriggers.firableProjectTriggers(userDataDir, [project]);
  assert.deepEqual(firable, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /changed since it was enabled/);

  // Re-enabling the new definition restores it.
  projectTriggers.enable(userDataDir, project, edited);
  assert.equal(projectTriggers.firableProjectTriggers(userDataDir, [project]).firable.length, 1);
});

test('disable removes the enablement; missing files and projects are quiet no-ops', () => {
  const { userDataDir, project } = setup();
  writeTriggers(project, [nightly]);
  projectTriggers.enable(userDataDir, project, nightly);
  projectTriggers.disable(userDataDir, project, 'nightly');
  assert.equal(projectTriggers.enablement(userDataDir, project, nightly), 'disabled');
  assert.deepEqual(projectTriggers.firableProjectTriggers(userDataDir, ['/nowhere/at/all']).firable, []);
});
