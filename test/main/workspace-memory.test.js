const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initTools, memoryPath } = require('../../tools');
const workspace = require('../../src/main/workspace');

test('memory lives in app data until a project opts into .brittain/, then in-repo', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mem-user-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mem-proj-'));
  initTools(userDataDir);

  const appPath = memoryPath(project);
  assert.ok(appPath.startsWith(path.join(userDataDir, 'memory')), 'no workspace: app-data memory');

  workspace.initWorkspace(project);
  const repoPath = memoryPath(project);
  assert.equal(repoPath, workspace.memoryFile(project), 'workspace present: in-repo memory');
  assert.ok(repoPath.startsWith(fs.realpathSync(project)));
});

test('the in-repo secret refusal is wired into remember', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'tools.js'), 'utf8');
  assert.match(source, /workspace\.hasWorkspace\(cwd\) && workspace\.looksLikeSecret\(fact\)/,
    'remember must refuse key-shaped facts when memory is committed to the repository');
});
