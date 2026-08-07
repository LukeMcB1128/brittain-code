const fs = require('fs');
const path = require('path');

function createCheckpointService({ gitRun, getTempDirectory, publishState, keep = 20 }) {
  let lastCheckpoint = null;

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
      if (!(await gitRun(['rev-parse', '--git-dir'], cwd)).ok) return null;
      const temporaryIndex = path.join(
        getTempDirectory(),
        'brittain-ckpt-' + Date.now() + '-' + Math.random().toString(36).slice(2),
      );
      const env = { ...process.env, GIT_INDEX_FILE: temporaryIndex };
      try {
        const add = await gitRun(['add', '-A', '--', '.'], cwd, env);
        if (!add.ok) return null;
        const tree = await gitRun(['write-tree'], cwd, env);
        if (!tree.ok) return null;
        const head = await gitRun(['rev-parse', 'HEAD'], cwd);
        const parentArgs = head.ok ? ['-p', head.out.trim()] : [];
        const commit = await gitRun([
          'commit-tree',
          tree.out.trim(),
          ...parentArgs,
          '-m',
          'brittain checkpoint ' + new Date().toISOString(),
        ], cwd, env);
        if (!commit.ok) return null;
        const ref = 'refs/brittain/checkpoints/' + Date.now();
        if (!(await gitRun(['update-ref', ref, commit.out.trim()], cwd)).ok) return null;
        lastCheckpoint = { ref, cwd, at: Date.now() };
        publishState({ available: true, cwd });
        prune(cwd);
        return lastCheckpoint;
      } finally {
        try { fs.unlinkSync(temporaryIndex); } catch {}
      }
    } catch {
      return null;
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

  return { create, current: () => lastCheckpoint, prune, undo };
}

module.exports = { createCheckpointService };
