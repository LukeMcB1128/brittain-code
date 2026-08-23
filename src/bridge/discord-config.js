'use strict';

// The Discord bridge's configuration, shared by the two ways it can run: in
// process inside the app or daemon, and standalone from a checkout. Both read
// the same file so there is one place to configure and one thing to explain.

const fs = require('fs');
const path = require('path');

const CONFIG_TEMPLATE = {
  // The bridge does nothing until this is true. A config file that appears on
  // disk is not consent to expose the agent to a chat service.
  enabled: false,
  token: '',
  // Deny by default: with no ownerIds the bridge answers nobody. Your Discord
  // user id (Settings → Advanced → Developer Mode, then right-click yourself).
  ownerIds: [],
  // Empty means DMs with an owner only. Naming channels opts into a guild.
  channelIds: [],
  // Where unprompted messages go — a run parking at 3am, a heartbeat's result.
  // Left empty, the bridge opens a DM with the first owner and uses that, so it
  // always has somewhere to reach you without being spoken to first.
  notifyChannelId: '',
  // Where runs happen, and how much they may do without asking.
  //
  // "trusted" is the working setting: unattended, "guarded" defers writes AND
  // commands, so a bot on it reads the project, declines every edit, and
  // reports a list of deferrals having changed nothing. Every run still
  // branches and checkpoints first, and the invariants — money, destructive
  // ops, sensitive reads, untrusted MCP — still come back to you to approve.
  cwd: '',
  policy: 'trusted',
  // Empty means whatever the app has selected.
  model: '',
};

function configPath(userDataDir) {
  return path.join(userDataDir, 'discord.json');
}

function ensureConfig(userDataDir) {
  const target = configPath(userDataDir);
  try {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, JSON.stringify(CONFIG_TEMPLATE, null, 2) + '\n', 'utf8');
    }
  } catch {}
  return target;
}

function readConfig(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(userDataDir), 'utf8'));
    return { config: parsed && typeof parsed === 'object' ? parsed : null, error: '' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { config: null, error: '' };
    return { config: null, error: String(error.message || error) };
  }
}

// What is still missing before this can start. Returned as a list so the caller
// can name every gap at once rather than one per restart.
function validateConfig(config) {
  const missing = [];
  if (!config) return ['a discord.json to configure'];
  if (!config.enabled) missing.push('enabled: true');
  if (!config.token) missing.push('token');
  if (!(config.ownerIds || []).filter(Boolean).length) missing.push('ownerIds');
  if (!config.cwd) missing.push('cwd');
  return missing;
}

// Whether the bot has already introduced itself, so it does so exactly once
// per channel rather than on every restart. Kept beside the config because it
// is bridge bookkeeping, not something anyone edits.
function statePath(userDataDir) {
  return path.join(userDataDir, 'discord-state.json');
}

function greetStore(userDataDir) {
  const read = () => {
    try { return JSON.parse(fs.readFileSync(statePath(userDataDir), 'utf8')) || {}; }
    catch { return {}; }
  };
  return {
    hasGreeted: (channelId) => !!channelId && read().greeted === channelId,
    markGreeted: (channelId) => {
      try {
        const target = statePath(userDataDir);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify({ ...read(), greeted: channelId }, null, 2) + '\n', 'utf8');
      } catch {}
    },
  };
}

module.exports = { CONFIG_TEMPLATE, configPath, ensureConfig, readConfig, validateConfig, greetStore, statePath };
