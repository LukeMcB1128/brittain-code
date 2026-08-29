const fs = require('fs');
const path = require('path');

function createCheckpointService({ gitRun, getTempDirectory, publishState, keep = 20 }) {
  let lastCheckpoint = null;

  function invalidate(cwd) {
    lastCheckpoint = null;
    publishState({ available: false, cwd });
    return null;
  }

  async function prune(cwd) {
    const list = await gitRun(['for-each-ref', '--format=%(refname)', 'refs/brittain/checkpoints/'], cwd);
    if (!list.ok) return;
    const refs = list.out.split('\n').filter(Boolean).sort();
    for (const ref of refs.slice(0, Math.max(0, refs.length - keep))) {
      await gitRun(['update-ref', '-d', ref], cwd);
    }
  }

  async function create(cwd) {
    try {
      if (!(await gitRun(['rev-parse', '--git-dir'], cwd)).ok) return invalidate(cwd);
      const temporaryIndex = path.join(
        getTempDirectory(),
        'brittain-ckpt-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      );
      const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
      try {
        const add = await gitRun(['add', '-A', '--', '.'], cwd, env);
        if (!add.ok) return invalidate(cwd);
        const tree = await gitRun(['write-tree'], cwd, env);
        if (!tree.ok) return invalidate(cwd);
        const head = await gitRun(['rev-parse', 'HEAD'], cwd);
        const parentArgs = head.ok ? ['-p', head.out.trim()] : [];
        const commit = await gitRun([
          'commit-tree',
          tree.out.trim(),
          ...parentArgs,
          '-m',
          'brittain checkpoint ' + new Date().toISOString(),
        ], cwd, env);
        if (!commit.ok) return invalidate(cwd);
        const ref = 'refs/brittain/checkpoints/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
        if (!(await gitRun(['update-ref', ref, commit.out.trim()], cwd)).ok) return invalidate(cwd);
        lastCheckpoint = { ref, cwd, at: Date.now() };
        publishState({ available: true, cwd });
        prune(cwd);
        return lastCheckpoint;
      } finally {
        try { fs.unlinkSync(temporaryIndex); } catch {}
      }
    } catch {
      return invalidate(cwd);
    }
  }

  // Compare the current files with the checkpoint through a temporary index.
  // A checkpoint includes files that were untracked when the run started. A
  // normal `git diff <checkpoint>` uses the real index, where those files are
  // still untracked, so Git reports each one twice: deleted from the checkpoint
  // and new in the working tree. Seeding a temporary index from the checkpoint
  // and adding the current files gives Git two complete snapshots to compare.
  async function diffStat(cwd, checkpoint = lastCheckpoint) {
    const target = checkpoint;
    if (!target || target.cwd !== cwd) {
      return { ok: false, out: '', err: 'No checkpoint for this folder in this session.' };
    }
    const temporaryIndex = path.join(
      getTempDirectory(),
      'brittain-diff-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    );
    const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
    try {
      const read = await gitRun(['read-tree', target.ref], cwd, env);
      if (!read.ok) return read;
      const add = await gitRun(['add', '-A', '--', '.'], cwd, env);
      if (!add.ok) return add;
      return gitRun(['diff', '--cached', '--stat', target.ref, '--', '.'], cwd, env);
    } catch (error) {
      return { ok: false, out: '', err: String(error.message || error) };
    } finally {
      try { fs.unlinkSync(temporaryIndex); } catch {}
    }
  }

  async function undo(cwd) {
    const target = lastCheckpoint;
    if (!target || target.cwd !== cwd) {
      return { ok: false, error: 'No checkpoint for this folder in this session.' };
    }
    try {
      const stat = await gitRun(['diff', '--shortstat', target.ref, '--', '.'], cwd);
      await create(cwd);
      const restore = await gitRun(['restore', '--source=' + target.ref, '--worktree', '--', '.'], cwd);
      if (!restore.ok) return { ok: false, error: restore.err || 'restore failed' };
      const inRef = await gitRun(['ls-tree', '-r', '--name-only', target.ref], cwd);
      const currentFiles = await gitRun(['ls-files', '--cached', '--others', '--exclude-standard'], cwd);
      if (inRef.ok && currentFiles.ok) {
        const keepFiles = new Set(inRef.out.split('\n').filter(Boolean));
        for (const file of currentFiles.out.split('\n').filter(Boolean)) {
          if (!keepFiles.has(file)) {
            try { fs.unlinkSync(path.join(cwd, file)); } catch {}
          }
        }
      }
      return {
        ok: true,
        restoredFrom: new Date(target.at).toLocaleTimeString(),
        changes: (stat.out || '').trim() || 'no differences detected',
      };
    } catch (err) {
      return { ok: false, error: String(err.message || err) };
    }
  }

  function adopt(checkpoint) {
    if (!checkpoint?.ref || !checkpoint?.cwd) return false;
    lastCheckpoint = { ref: checkpoint.ref, cwd: checkpoint.cwd, at: Number(checkpoint.at) || Date.now() };
    publishState({ available: true, cwd: checkpoint.cwd });
    return true;
  }

  return { adopt, create, current: () => lastCheckpoint, diffStat, prune, undo };
}

module.exports = { createCheckpointService };
