'use strict';

// Project-scoped triggers, disabled on arrival.
//
// A trigger in <project>/.brittain/triggers.json arrives the way any repository
// file does — possibly via `git pull` from someone who is not the user. So a
// project trigger NEVER fires merely by existing: it must be enabled locally,
// and the enablement records a hash of the trigger's definition. If the
// definition later changes (a pulled edit to its goal, schedule, or policy),
// the hash no longer matches and the trigger drops back to disabled until the
// user re-enables it, with a warning saying why.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function registryPath(userDataDir) {
  return path.join(userDataDir, 'project-triggers.json');
}

function readRegistry(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath(userDataDir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeRegistry(userDataDir, registry) {
  const target = registryPath(userDataDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(registry, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, target);
}

function definitionHash(trigger) {
  return crypto.createHash('sha256').update(JSON.stringify(trigger)).digest('hex').slice(0, 16);
}

function registryKey(projectPath, triggerId) {
  let canonicalPath = projectPath;
  try { canonicalPath = fs.realpathSync(projectPath); } catch {}
  return `${canonicalPath}::${triggerId}`;
}

function readProjectTriggers(projectPath) {
  const file = path.join(projectPath, '.brittain', 'triggers.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { triggers: Array.isArray(parsed?.triggers) ? parsed.triggers : [], error: '' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { triggers: [], error: '' };
    return { triggers: [], error: String(error.message || error) };
  }
}

// The enablement state of one project trigger: 'enabled', 'disabled', or
// 'changed' — enabled once, but the definition has since changed underneath.
function enablement(userDataDir, projectPath, trigger) {
  const entry = readRegistry(userDataDir)[registryKey(projectPath, trigger.id)];
  if (!entry) return 'disabled';
  return entry.hash === definitionHash(trigger) ? 'enabled' : 'changed';
}

function enable(userDataDir, projectPath, trigger) {
  const registry = readRegistry(userDataDir);
  registry[registryKey(projectPath, trigger.id)] = {
    hash: definitionHash(trigger),
    enabledAt: new Date().toISOString(),
  };
  writeRegistry(userDataDir, registry);
}

function disable(userDataDir, projectPath, triggerId) {
  const registry = readRegistry(userDataDir);
  delete registry[registryKey(projectPath, triggerId)];
  writeRegistry(userDataDir, registry);
}

// Project triggers that may actually fire: defined in the project file,
// enabled locally, definition unchanged since enablement. Every trigger is
// stamped with its project so downstream code needs no second lookup.
function firableProjectTriggers(userDataDir, projectPaths) {
  const firable = [];
  const warnings = [];
  for (const projectPath of projectPaths) {
    const { triggers, error } = readProjectTriggers(projectPath);
    if (error) { warnings.push(`${projectPath}: ${error}`); continue; }
    for (const trigger of triggers) {
      if (!trigger?.id) continue;
      const state = enablement(userDataDir, projectPath, trigger);
      if (state === 'enabled') firable.push({ ...trigger, cwd: trigger.cwd || projectPath, projectPath });
      else if (state === 'changed') warnings.push(`"${trigger.id}" in ${projectPath} changed since it was enabled — re-enable it to let it fire again.`);
    }
  }
  return { firable, warnings };
}

module.exports = {
  readProjectTriggers, enablement, enable, disable,
  firableProjectTriggers, definitionHash, registryPath,
};
