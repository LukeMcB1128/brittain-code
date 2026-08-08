const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function canonicalProjectPath(value) {
  try { return fs.realpathSync(value); }
  catch { return path.resolve(String(value || '')); }
}

function safeFilePath(cwd, relativePath) {
  const root = canonicalProjectPath(cwd);
  const absolute = path.resolve(root, relativePath);
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null;
  return absolute;
}

async function hashFile(hash, absolute) {
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) {
    hash.update('symlink\0' + fs.readlinkSync(absolute));
    return;
  }
  hash.update(`mode\0${stat.mode}\0size\0${stat.size}\0`);
  if (!stat.isFile()) return;
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(absolute);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
}

async function captureMissionRecovery({ cwd, checkpointRef, gitRun }) {
  const projectPath = canonicalProjectPath(cwd);
  const [head, checkpoint, staged, unstaged, untracked] = await Promise.all([
    gitRun(['rev-parse', 'HEAD'], cwd),
    checkpointRef ? gitRun(['rev-parse', '--verify', `${checkpointRef}^{commit}`], cwd) : Promise.resolve({ ok: false, out: '' }),
    gitRun(['diff', '--cached', '--binary', '--no-ext-diff', '--', '.'], cwd),
    gitRun(['diff', '--binary', '--no-ext-diff', '--', '.'], cwd),
    gitRun(['ls-files', '--others', '--exclude-standard', '-z', '--', '.'], cwd),
  ]);
  if (!head.ok) throw new Error('Mission recovery requires a Git commit.');
  if (!checkpoint.ok) throw new Error('The mission checkpoint could not be resolved.');
  if (!staged.ok || !unstaged.ok || !untracked.ok) throw new Error('Could not capture the mission working tree.');
  const hash = crypto.createHash('sha256');
  hash.update('head\0' + head.out.trim() + '\0');
  hash.update('staged\0' + staged.out + '\0unstaged\0' + unstaged.out + '\0');
  const untrackedFiles = untracked.out.split('\0').filter(Boolean).sort();
  for (const file of untrackedFiles) {
    hash.update('untracked\0' + file + '\0');
    const absolute = safeFilePath(projectPath, file);
    if (!absolute) throw new Error(`Unsafe untracked path: ${file}`);
    await hashFile(hash, absolute);
  }
  return {
    version: 1,
    projectPath,
    head: head.out.trim(),
    diffFingerprint: hash.digest('hex'),
    checkpointRef: String(checkpointRef || ''),
    checkpointCommit: checkpoint.out.trim(),
    capturedAt: new Date().toISOString(),
  };
}

async function validateMissionRecovery({ mission, cwd, gitRun }) {
  const saved = mission?.recovery;
  if (!saved?.projectPath || !saved?.head || !saved?.diffFingerprint || !saved?.checkpointRef || !saved?.checkpointCommit) {
    return { ok: false, errors: ['This mission does not have complete recovery data.'] };
  }
  const errors = [];
  const currentPath = canonicalProjectPath(cwd);
  if (currentPath !== saved.projectPath) errors.push(`Project path changed: expected ${saved.projectPath}.`);
  if (!fs.existsSync(currentPath)) errors.push('The saved project path no longer exists.');

  const checkpoint = await gitRun(['show-ref', '--verify', '--quiet', saved.checkpointRef], cwd);
  if (!checkpoint.ok) errors.push('The saved mission checkpoint no longer exists.');

  let current = null;
  try {
    current = await captureMissionRecovery({ cwd, checkpointRef: saved.checkpointRef, gitRun });
    if (current.checkpointCommit !== saved.checkpointCommit) errors.push('The saved mission checkpoint points to a different commit.');
    if (current.head !== saved.head) errors.push(`Commit changed: expected ${saved.head.slice(0, 12)}, found ${current.head.slice(0, 12)}.`);
    if (current.diffFingerprint !== saved.diffFingerprint) errors.push('The working-tree diff changed after the last saved mission event.');
  } catch (error) {
    errors.push(String(error.message || error));
  }
  return { ok: errors.length === 0, errors, current };
}

module.exports = { canonicalProjectPath, captureMissionRecovery, validateMissionRecovery };
