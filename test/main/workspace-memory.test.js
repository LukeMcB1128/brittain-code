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

// --- /workspace init ---

test('creating the workspace and migrating memory are one operation', () => {
  // Creating .brittain/ is what switches memoryPath from app data to the repo.
  // An init that skipped the migration would leave the old memory on disk but
  // invisible to the agent, which a user reads as memory loss — so both entry
  // points must run the same function.
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  assert.match(main, /function initProjectWorkspace\(cwd\)/);
  const init = main.slice(main.indexOf('function initProjectWorkspace'));
  assert.match(init.slice(0, 900), /const before = readMemory\(cwd\)/,
    'memory is read while the path still resolves to app data');
  assert.match(init.slice(0, 900), /fs\.appendFileSync\(target/);
  for (const channel of ["ipcMain.handle('workspace:init'", "ipcMain.handle('memory:move'"]) {
    const body = main.slice(main.indexOf(channel), main.indexOf(channel) + 320);
    assert.match(body, /return initProjectWorkspace\(cwd\)/, `${channel} must delegate, not reimplement`);
  }
});

test('nothing creates the workspace on its own — the hint writes no file', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  // initWorkspace is reachable only through the two deliberate entry points.
  assert.equal((main.match(/workspace\.initWorkspace\(/g) || []).length, 1,
    'only initProjectWorkspace may create the directory');
  // An unattended run mentions it once per project per session and stops there.
  assert.match(main, /const workspaceHintShown = new Set\(\);/);
  assert.match(main, /!workspace\.hasWorkspace\(cwd\) && !workspaceHintShown\.has\(cwd\)/);
});

test('/workspace is wired renderer → preload → main', () => {
  const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');
  assert.match(read('renderer/app.js'), /case 'workspace':/);
  assert.match(read('preload.js'), /workspaceInit: \(cwd\) => ipcRenderer\.invoke\('workspace:init', cwd\)/);
  assert.match(read('main.js'), /ipcMain\.handle\('workspace:state'/);
});
