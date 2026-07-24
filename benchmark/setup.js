#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { TASKS, getTask } = require('./tasks');

function defaultDirForTask(taskId) {
  const defaultName = taskId === 'cart' ? 'brittain-bench' : `brittain-bench-${taskId}`;
  return path.resolve(path.join(os.homedir(), defaultName));
}

function isOwnedBenchmarkDir(dir) {
  let legacyOwned = false;
  try {
    cp.execFileSync('git', ['rev-parse', '-q', '--verify', 'bench-baseline'], { cwd: dir, stdio: 'ignore' });
    legacyOwned = fs.existsSync(path.join(dir, 'test.js'));
  } catch {}
  return fs.existsSync(path.join(dir, '.brittain-benchmark.json')) || legacyOwned;
}

function initializeGitBaseline(dir, taskId) {
  const git = (args) => cp.execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git(['init', '-q']);
  git(['add', '-A']);
  git(['-c', 'user.name=bench', '-c', 'user.email=bench@local', 'commit', '-qm', `${taskId} benchmark baseline`]);
  git(['tag', '-f', 'bench-baseline']);
}

function prepareFixture(taskId, dir, { force = false } = {}) {
  const task = getTask(taskId);
  const targetDir = path.resolve(String(dir || defaultDirForTask(taskId)).replace(/^~/, os.homedir()));

  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length) {
    const owned = isOwnedBenchmarkDir(targetDir);
    if (!owned && !force) {
      throw new Error(`Refusing to replace non-benchmark directory: ${targetDir}\nPass --force only if you are certain this directory is disposable.`);
    }
    fs.rmSync(targetDir, { recursive: true, force: true });
  }

  fs.mkdirSync(targetDir, { recursive: true });
  for (const [file, content] of Object.entries(task.files)) {
    const target = path.join(targetDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
  }
  fs.writeFileSync(path.join(targetDir, '.brittain-benchmark.json'), JSON.stringify({ task: taskId, version: task.version }, null, 2));
  initializeGitBaseline(targetDir, taskId);
  return { dir: targetDir, task };
}

function resetFixture(dir) {
  const targetDir = path.resolve(String(dir).replace(/^~/, os.homedir()));
  cp.execFileSync('git', ['reset', '--hard', '-q', 'bench-baseline'], { cwd: targetDir, stdio: 'ignore' });
  cp.execFileSync('git', ['clean', '-fdq'], { cwd: targetDir, stdio: 'ignore' });
}

module.exports = { defaultDirForTask, prepareFixture, resetFixture };

if (require.main === module) {
  const argv = process.argv.slice(2);
  const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
  if (argv.includes('--list')) {
    for (const [id, task] of Object.entries(TASKS)) console.log(`${id.padEnd(10)} v${task.version}  ${task.title}`);
    process.exit(0);
  }

  const taskId = value('--task') || 'cart';
  const dir = value('--dir') || defaultDirForTask(taskId);
  const force = argv.includes('--force');

  try {
    const { dir: readyDir, task } = prepareFixture(taskId, dir, { force });
    console.log(`Benchmark ready: ${readyDir}`);
    console.log(`Task: ${taskId} v${task.version} — ${task.title}`);
    console.log(`Prompt: ${path.join(__dirname, task.promptFile)}`);
    console.log(`Reset: git -C "${readyDir}" reset --hard -q bench-baseline`);
    console.log(`       git -C "${readyDir}" clean -fdq`);
  } catch (err) {
    console.error(err.message || String(err));
    process.exit(2);
  }
}
