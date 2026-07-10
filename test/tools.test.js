const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  initTools,
  TOOL_DEFS,
  RISKY_TOOLS,
  SUBAGENT_TOOL_NAMES,
  executeTool,
  memoryPath,
  readMemory,
} = require('../tools');

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-code-test-'));
}

test('tool definitions and implementations stay aligned for check_port_usage', () => {
  const names = new Set(TOOL_DEFS.map((definition) => definition.function.name));
  assert.equal(names.has('check_port_usage'), true);
  const environmentTool = TOOL_DEFS.find((definition) => definition.function.name === 'get_environment_variables');
  assert.deepEqual(environmentTool.function.parameters.required, ['name']);
  assert.equal(RISKY_TOOLS.has('get_environment_variables'), true);
});

test('mutating research tools require approval and are unavailable to subagents', () => {
  for (const name of ['initiate_research_session', 'record_observation', 'finalize_research']) {
    assert.equal(RISKY_TOOLS.has(name), true, `${name} should require approval`);
    assert.equal(SUBAGENT_TOOL_NAMES.has(name), false, `${name} should not be available to subagents`);
  }
});

test('file tools reject parent traversal and absolute paths outside the project', async (t) => {
  const cwd = tempProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  await assert.rejects(() => executeTool('read_file', { path: '../outside.txt' }, cwd), /escapes the working directory/);
  await assert.rejects(() => executeTool('read_file', { path: path.join(os.tmpdir(), 'outside.txt') }, cwd), /escapes the working directory/);
});

test('file tools reject symlinks that escape the project', async (t) => {
  const cwd = tempProject();
  const outside = tempProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(outside, path.join(cwd, 'escape'));

  await assert.rejects(() => executeTool('read_file', { path: 'escape/secret.txt' }, cwd), /through a symlink/);
});

test('write_file leaves an existing JavaScript file unchanged after invalid syntax', async (t) => {
  const cwd = tempProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const target = path.join(cwd, 'valid.js');
  fs.writeFileSync(target, 'const value = 1;\n');

  const result = await executeTool('write_file', { path: 'valid.js', content: 'const = ;\n' }, cwd);
  assert.match(result, /Write rejected/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'const value = 1;\n');
});

test('append_file and replace_in_file also roll back invalid JavaScript', async (t) => {
  const cwd = tempProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const target = path.join(cwd, 'valid.js');
  const original = 'const value = 1;\n';
  fs.writeFileSync(target, original);

  const appendResult = await executeTool('append_file', { path: 'valid.js', content: 'const = ;\n' }, cwd);
  assert.match(appendResult, /Append rejected/);
  assert.equal(fs.readFileSync(target, 'utf8'), original);

  const replaceResult = await executeTool('replace_in_file', {
    path: 'valid.js',
    pattern: 'const value = 1;',
    replacement: 'const = ;',
  }, cwd);
  assert.match(replaceResult, /Replacement rejected/);
  assert.equal(fs.readFileSync(target, 'utf8'), original);
});

test('remember stores isolated project memory outside both projects', async (t) => {
  const userData = tempProject();
  const firstProject = tempProject();
  const secondProject = tempProject();
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  t.after(() => fs.rmSync(firstProject, { recursive: true, force: true }));
  t.after(() => fs.rmSync(secondProject, { recursive: true, force: true }));
  initTools(userData);

  await executeTool('remember', { fact: 'First project uses tabs.' }, firstProject);
  await executeTool('remember', { fact: 'Second project uses spaces.' }, secondProject);

  assert.match(readMemory(firstProject), /uses tabs/);
  assert.doesNotMatch(readMemory(firstProject), /uses spaces/);
  assert.match(readMemory(secondProject), /uses spaces/);
  assert.notEqual(memoryPath(firstProject), memoryPath(secondProject));
  assert.equal(memoryPath(firstProject).startsWith(userData + path.sep), true);
  assert.equal(fs.existsSync(path.join(firstProject, 'memory.md')), false);
  assert.equal(fs.existsSync(path.join(secondProject, 'memory.md')), false);

  const index = JSON.parse(fs.readFileSync(path.join(userData, 'memory', 'projects.json'), 'utf8'));
  assert.equal(Object.values(index).some((entry) => entry.path === fs.realpathSync(firstProject)), true);
  assert.equal(Object.values(index).some((entry) => entry.path === fs.realpathSync(secondProject)), true);
});

test('write_file warns when an overwrite dramatically shrinks a file', async (t) => {
  const cwd = tempProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const big = '// line\n'.repeat(200); // ~1600 chars
  await executeTool('write_file', { path: 'app.js', content: big }, cwd);
  await executeTool('read_file', { path: 'app.js' }, cwd); // reset rewrite tracker
  const result = await executeTool('write_file', { path: 'app.js', content: 'const x = 1;' }, cwd);

  assert.match(result, /SHRANK the file from \d+ to \d+ chars/);
  // growing or same-size writes stay quiet
  await executeTool('read_file', { path: 'app.js' }, cwd);
  const grow = await executeTool('write_file', { path: 'app.js', content: big }, cwd);
  assert.doesNotMatch(grow, /SHRANK/);
});

test('written code containing conversational self-talk is flagged', async (t) => {
  const cwd = tempProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const leaked = 'const a = 1;\n// Wait, I missed an assignment!\n// I am so sorry. Let me fix this.\nconst b = 2;\n';
  const result = await executeTool('write_file', { path: 'leak.js', content: leaked }, cwd);
  assert.match(result, /self-talk/);

  // real comments must not trip it
  const clean = 'const a = 1;\n// Wait for the DB to initialize before querying.\nconst b = 2;\n';
  const ok = await executeTool('write_file', { path: 'clean.js', content: clean }, cwd);
  assert.doesNotMatch(ok, /self-talk/);
});

test('consecutive rewrites of the same file trigger the futility breaker', async (t) => {
  const cwd = tempProject();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const r1 = await executeTool('write_file', { path: 'spin.js', content: 'const v = 1;' }, cwd);
  const r2 = await executeTool('write_file', { path: 'spin.js', content: 'const v = 2;' }, cwd);
  assert.doesNotMatch(r1 + r2, /STOP: this is consecutive/);

  const r3 = await executeTool('write_file', { path: 'spin.js', content: 'const v = 3;' }, cwd);
  assert.match(r3, /STOP: this is consecutive rewrite #3/);

  // any other tool call resets the spiral counter
  await executeTool('read_file', { path: 'spin.js' }, cwd);
  const r4 = await executeTool('write_file', { path: 'spin.js', content: 'const v = 4;' }, cwd);
  assert.doesNotMatch(r4, /STOP: this is consecutive/);
});
