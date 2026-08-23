const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { normalizePolicy, normalizeRoots, expandRoot, narrowPolicy } = require('../../src/main/autonomy');

// File tools are confined to the working directory. Roots are how a policy
// widens that for an assistant that should reach a notes folder — which makes
// them the most safety-relevant piece of configuration in the app.

test('a root must be an absolute path; a relative one grants nothing', () => {
  assert.equal(expandRoot('notes'), '');
  assert.equal(expandRoot('../escape'), '');
  assert.equal(expandRoot(''), '');
  assert.equal(expandRoot(null), '');
});

test('~ expands to the home directory', () => {
  assert.equal(expandRoot('~/Documents'), path.join(os.homedir(), 'Documents'));
  assert.equal(expandRoot('~'), os.homedir());
});

test('the filesystem root is refused — it is never a considered choice', () => {
  assert.equal(expandRoot(path.parse(os.homedir()).root), '');
});

test('unusable roots are reported rather than silently dropped', () => {
  const { roots, rejected } = normalizeRoots(['~/Documents', 'relative/path', '']);
  assert.deepEqual(roots, [path.join(os.homedir(), 'Documents')]);
  assert.deepEqual(rejected, ['relative/path', '']);
});

test('duplicate roots collapse', () => {
  const { roots } = normalizeRoots(['~/Documents', '~/Documents']);
  assert.equal(roots.length, 1);
});

test('a project autonomy.json cannot grant itself roots', () => {
  // The whole point of the narrowing rule: a file that can arrive in a pull
  // request must not be able to hand the agent the rest of the disk.
  const base = normalizePolicy({ allowRisky: true, roots: ['~/Documents'] });
  const { policy, ignored } = narrowPolicy(base, { roots: [os.tmpdir()], deny: ['delete_file'] });
  assert.ok(ignored.includes('roots'), 'roots in an overlay must be ignored');
  assert.deepEqual(policy.roots, [path.join(os.homedir(), 'Documents')], 'the base policy keeps its own roots');
  assert.ok(policy.deny.has('delete_file'), 'genuine narrowing still applies');
});

// --- enforcement ---

const { initTools, setRootProvider } = require('../../tools');

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-roots-'));
  const project = path.join(base, 'project');
  const granted = path.join(base, 'notes');
  const outside = path.join(base, 'private');
  for (const dir of [project, granted, outside]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(granted, 'note.md'), 'granted\n');
  fs.writeFileSync(path.join(outside, 'secret.md'), 'not granted\n');
  return { base, project, granted, outside };
}

test('a granted root is reachable by absolute path; everything else is not', async (t) => {
  const { project, granted, outside } = sandbox();
  initTools(fs.mkdtempSync(path.join(os.tmpdir(), 'bc-roots-user-')));
  t.after(() => setRootProvider(null));

  const { executeTool } = require('../../tools');
  setRootProvider(() => [granted]);

  const allowed = await executeTool('read_file', { path: path.join(granted, 'note.md') }, project);
  assert.match(allowed, /granted/);

  // executeTool throws; main.js's safeExecute is what turns that into a tool
  // result the model reads.
  await assert.rejects(
    () => executeTool('read_file', { path: path.join(outside, 'secret.md') }, project),
    /escapes/, 'a directory that was not granted stays out of reach');
});

test('with no roots granted, the project is the only reachable place', async (t) => {
  const { project, granted } = sandbox();
  t.after(() => setRootProvider(null));
  const { executeTool } = require('../../tools');
  setRootProvider(() => []);
  await assert.rejects(
    () => executeTool('read_file', { path: path.join(granted, 'note.md') }, project),
    /escapes the working directory/);
});

test('a provider that throws grants nothing', async (t) => {
  const { project, granted } = sandbox();
  t.after(() => setRootProvider(null));
  const { executeTool } = require('../../tools');
  setRootProvider(() => { throw new Error('policy blew up'); });
  await assert.rejects(
    () => executeTool('read_file', { path: path.join(granted, 'note.md') }, project),
    /escapes/, 'failing closed is the only safe direction');
});

test('relative paths still mean the project, never a granted root', async (t) => {
  const { project, granted } = sandbox();
  t.after(() => setRootProvider(null));
  const { executeTool } = require('../../tools');
  setRootProvider(() => [granted]);
  fs.writeFileSync(path.join(project, 'note.md'), 'project copy\n');
  const result = await executeTool('read_file', { path: 'note.md' }, project);
  assert.match(result, /project copy/, 'a bare filename must not silently resolve into a granted root');
});

test('a granted root that no longer exists grants nothing and breaks nothing', async (t) => {
  const { project, granted, base } = sandbox();
  t.after(() => setRootProvider(null));
  const { executeTool } = require('../../tools');
  setRootProvider(() => [path.join(base, 'deleted-since-configured'), granted]);
  const stillWorks = await executeTool('read_file', { path: path.join(granted, 'note.md') }, project);
  assert.match(stillWorks, /granted/);
});
