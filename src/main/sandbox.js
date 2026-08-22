'use strict';

// OS-level containment for unattended shell commands (macOS only for now).
//
// Path confinement in tools.js is a code guarantee; this makes the same
// promise an OS guarantee for the one tool that escapes it by design:
// run_command. When a policy sets `"sandbox": true` and the run is unattended,
// shell commands execute under sandbox-exec with writes confined to the
// project, the temp dir, and /dev. Reads stay open — builds legitimately read
// toolchains from everywhere — so this is a blast-radius bound, not a secrecy
// bound; sensitive reads are already governed by the policy invariants.
//
// sandbox-exec is deprecated by Apple but present and functional on every
// current macOS; if it ever disappears the wrapper fails closed (the command
// errors rather than running unconfined). Windows has no equivalent shipped
// primitive — callers must treat sandboxing as unavailable there and say so.

const os = require('os');

function escapeForProfile(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function profileFor(projectDir) {
  const writable = [projectDir, os.tmpdir(), '/private/tmp', '/dev']
    .map((dir) => `(subpath "${escapeForProfile(dir)}")`)
    .join(' ');
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable})`,
  ].join(' ');
}

function available() {
  return process.platform === 'darwin';
}

// argv for a confined shell command, or null when sandboxing is unavailable.
function wrapCommand(command, projectDir) {
  if (!available()) return null;
  return ['sandbox-exec', '-p', profileFor(projectDir), '/bin/sh', '-c', String(command)];
}

module.exports = { available, wrapCommand, profileFor };
