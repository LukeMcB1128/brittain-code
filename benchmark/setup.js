#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { TASKS, getTask } = require('./tasks');

const argv = process.argv.slice(2);
const value = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
if (argv.includes('--list')) {
  for (const [id, task] of Object.entries(TASKS)) console.log(`${id.padEnd(10)} v${task.version}  ${task.title}`);
  process.exit(0);
}

const taskId = value('--task') || 'cart';
const task = getTask(taskId);
const defaultName = taskId === 'cart' ? 'brittain-bench' : `brittain-bench-${taskId}`;
const dir = path.resolve((value('--dir') || path.join(os.homedir(), defaultName)).replace(/^~/, os.homedir()));
const force = argv.includes('--force');

if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
  let legacyOwned = false;
  try {
    cp.execFileSync('git', ['rev-parse', '-q', '--verify', 'bench-baseline'], { cwd: dir, stdio: 'ignore' });
    legacyOwned = fs.existsSync(path.join(dir, 'test.js'));
  } catch {}
  const owned = fs.existsSync(path.join(dir, '.brittain-benchmark.json')) || legacyOwned;
  if (!owned && !force) {
    console.error(`Refusing to replace non-benchmark directory: ${dir}\nPass --force only if you are certain this directory is disposable.`);
    process.exit(2);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
fs.mkdirSync(dir, { recursive: true });
for (const [file, content] of Object.entries(task.files)) {
  const target = path.join(dir, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
}
fs.writeFileSync(path.join(dir, '.brittain-benchmark.json'), JSON.stringify({ task: taskId, version: task.version }, null, 2));

const git = (args) => cp.execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
git(['init', '-q']);
git(['add', '-A']);
git(['-c', 'user.name=bench', '-c', 'user.email=bench@local', 'commit', '-qm', `${taskId} benchmark baseline`]);
git(['tag', '-f', 'bench-baseline']);

console.log(`Benchmark ready: ${dir}`);
console.log(`Task: ${taskId} v${task.version} — ${task.title}`);
console.log(`Prompt: ${path.join(__dirname, task.promptFile)}`);
console.log(`Reset: git -C "${dir}" reset --hard -q bench-baseline`);
console.log(`       git -C "${dir}" clean -fdq`);
