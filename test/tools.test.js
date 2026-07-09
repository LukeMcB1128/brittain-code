const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  TOOL_DEFS,
  RISKY_TOOLS,
  SUBAGENT_TOOL_NAMES,
  executeTool,
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
