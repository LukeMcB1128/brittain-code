#!/usr/bin/env node
'use strict';

// Reach the agent from anywhere: a Discord bot that speaks to the headless
// daemon over its unix socket.
//
// No dependencies. Node 22 ships a WebSocket global, and the Discord gateway
// is a documented JSON protocol, so this is hand-rolled for the same reason
// mcp.js is: the most security-sensitive component of the app should not carry
// a supply chain. Roughly the whole protocol surface used here is IDENTIFY,
// HEARTBEAT, and MESSAGE_CREATE.
//
// The bridge holds no authority of its own. It turns an allowlisted person's
// message into the same runAgentTask the app calls, under the same autonomy
// policy — so every invariant, every park, and every decision record still
// applies. What it adds is that the approval can now travel: a run parks on
// your desktop and you decide from your phone.
//
// Run:  node scripts/discord-bridge.js
// Config: <userData>/discord.json  (created on first run, disabled until filled)

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const {
  authorize, parseCommand, chunk, renderPending, renderEvent, HELP,
} = require('../src/bridge/discord-protocol');
const daemon = require('../src/main/daemon');

const API = 'https://discord.com/api/v10';
// GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

function userDataDir() {
  if (process.env.BRITTAIN_USER_DATA) return process.env.BRITTAIN_USER_DATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Brittain Code');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'Brittain Code');
  return path.join(os.homedir(), '.config', 'Brittain Code');
}

const CONFIG_TEMPLATE = {
  enabled: false,
  token: '',
  // Deny by default: with no ownerIds the bridge answers nobody. Your Discord
  // user id (Settings → Advanced → Developer Mode, then right-click yourself).
  ownerIds: [],
  // Empty means DMs with an owner only. Naming channels opts into a guild.
  channelIds: [],
  // Where unprompted messages go — a run parking at 3am, a heartbeat's result.
  // Left empty, the bridge opens a DM with the first owner and uses that, so
  // it always has somewhere to reach you without being spoken to first.
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
  model: '',
};

function loadConfig() {
  const file = path.join(userDataDir(), 'discord.json');
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(CONFIG_TEMPLATE, null, 2) + '\n', 'utf8');
    console.log(`Wrote a disabled config to ${file}. Fill in token, ownerIds and cwd, set enabled: true, then run this again.`);
    process.exit(0);
  }
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const missing = ['token', 'cwd'].filter((key) => !config[key]);
  if (!config.enabled) missing.push('enabled: true');
  if (!(config.ownerIds || []).length) missing.push('ownerIds');
  if (missing.length) {
    console.error(`${file} is not ready: missing ${missing.join(', ')}.`);
    process.exit(1);
  }
  return config;
}

// ---------- Discord REST ----------

async function send(config, channelId, text) {
  for (const part of chunk(text)) {
    if (!part.trim()) continue;
    const res = await fetch(`${API}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: part }),
    });
    if (res.status === 429) {
      const retry = Number((await res.json())?.retry_after || 1);
      await new Promise((r) => setTimeout(r, retry * 1000));
      continue;
    }
    if (!res.ok) console.error('Discord send failed:', res.status, await res.text());
  }
}

// A bot cannot message someone out of the blue without a channel to do it in,
// and the interesting notifications are exactly the unprompted ones — a run
// parking overnight. So resolve one at startup rather than waiting to be
// spoken to: an explicit channel if configured, otherwise a DM with the first
// owner. Opening a DM requires the bot and the owner to share a server, which
// is why setup asks you to invite it to one.
async function resolveNotifyChannel(config) {
  if (config.notifyChannelId) return String(config.notifyChannelId);
  const owner = String((config.ownerIds || [])[0] || '');
  if (!owner) return '';
  const res = await fetch(`${API}/users/@me/channels`, {
    method: 'POST',
    headers: { Authorization: `Bot ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ recipient_id: owner }),
  });
  if (!res.ok) {
    console.error(`Could not open a DM with owner ${owner} (${res.status}). Unprompted notifications will go to the last channel you used.`);
    console.error('A bot can only DM someone it shares a server with — invite it to one, or set notifyChannelId.');
    return '';
  }
  return String((await res.json()).id || '');
}

// ---------- the daemon side ----------

const dir = userDataDir();
const ask = (message, timeoutMs) => daemon.sendCommand(dir, message, timeoutMs);

// Streams run output back into the channel the last command came from. A
// separate connection from the request/reply ones, held open for the session.
function attach(config, currentChannel) {
  const socket = net.connect(daemon.socketPath(dir));
  let buffer = '';
  socket.on('connect', () => socket.write(JSON.stringify({ cmd: 'attach' }) + '\n'));
  socket.on('data', async (data) => {
    buffer += String(data);
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!message.event) continue;
      const text = renderEvent(message.event, message.payload);
      if (text && currentChannel()) await send(config, currentChannel(), text);
    }
  });
  // A dropped attach costs progress messages, not correctness — the run keeps
  // going on the daemon regardless, so reconnect quietly.
  socket.on('error', () => {});
  socket.on('close', () => setTimeout(() => attach(config, currentChannel), 5_000));
}

async function handle(config, message, channelId) {
  const command = parseCommand(message.content);
  switch (command.kind) {
    case 'ignore': return;
    case 'help': return send(config, channelId, HELP);
    case 'error': return send(config, channelId, command.error);

    case 'status': {
      const res = await ask({ cmd: 'status' });
      if (!res.ok) return send(config, channelId, `Daemon: ${res.error}`);
      const mission = res.mission;
      return send(config, channelId, mission?.status === 'running'
        ? `Running: ${mission.goal || '(no goal)'}`
        : `Idle.${res.queued?.length ? ` ${res.queued.length} queued.` : ''}`);
    }

    case 'pending': {
      const res = await ask({ cmd: 'pending' });
      return send(config, channelId, res.ok ? renderPending(res.records) : `Could not read parked calls: ${res.error}`);
    }

    case 'resolve': {
      const listed = await ask({ cmd: 'pending' });
      if (!listed.ok || !listed.records.length) return send(config, channelId, 'Nothing parked.');
      if (listed.records.length > 1) {
        return send(config, channelId, 'Several runs are suspended; approving from here handles one at a time — use the app, or `!resume` them in order.');
      }
      const record = listed.records[0];
      const indexes = command.selector === 'all'
        ? record.parked.map((entry) => entry.index)
        : [parseInt(command.selector, 10)].filter((n) => Number.isInteger(n));
      if (!indexes.length) return send(config, channelId, `"${command.selector}" is not one of the parked calls. \`!pending\` lists them.`);
      for (const index of indexes) {
        const res = await ask({ cmd: 'resolve', payload: { runId: record.runId, index, approved: command.approved } });
        if (!res.ok) return send(config, channelId, `Failed: ${res.error}`);
      }
      return send(config, channelId, `${command.approved ? 'Approved' : 'Denied'} ${indexes.length} call(s). \`!resume\` to continue the run.`);
    }

    case 'resume': {
      const listed = await ask({ cmd: 'pending' });
      const record = command.runId
        ? listed.records?.find((entry) => entry.runId.endsWith(command.runId))
        : listed.records?.[0];
      if (!record) return send(config, channelId, 'No suspended run to resume.');
      await send(config, channelId, `▶️ Resuming ${record.runId}…`);
      const res = await ask({ cmd: 'resume', payload: { runId: record.runId } }, 0);
      return send(config, channelId, res.ok ? `Finished: ${res.status}` : `Resume failed: ${res.error}`);
    }

    case 'stop': {
      const res = await ask({ cmd: 'stop' });
      return send(config, channelId, res.ok ? 'Stopping after the current operation.' : res.error);
    }

    case 'run': {
      await send(config, channelId, `🤖 Running unattended under **${config.policy}** in \`${config.cwd}\`…`);
      const res = await ask({
        cmd: 'run',
        payload: {
          goal: command.goal,
          cwd: config.cwd,
          policy: config.policy,
          model: config.model || undefined,
          chatId: `discord-${channelId}`,
        },
      }, 0);
      if (!res.ok) return send(config, channelId, `Could not start: ${res.error}`);
      if (res.queued) return send(config, channelId, `Busy — queued (${res.depth} waiting).`);
      // A suspension already announced itself over the attached stream.
      if (res.status === 'suspended') return;
      return send(config, channelId, `✅ ${res.status}`);
    }
    default: return;
  }
}

// ---------- gateway ----------

function connect(config, notifyChannel) {
  // Replies land where you spoke; unprompted messages fall back to the
  // notification channel, so a run that parks while you are asleep still
  // reaches you.
  let lastChannel = notifyChannel || '';
  attach(config, () => lastChannel || notifyChannel);

  let sequence = null;
  let heartbeat = null;
  const socket = new WebSocket('wss://gateway.discord.gg/?v=10&encoding=json');

  socket.addEventListener('open', () => console.log('Discord gateway connected.'));

  socket.addEventListener('message', async (event) => {
    const frame = JSON.parse(event.data);
    if (frame.s !== null && frame.s !== undefined) sequence = frame.s;

    if (frame.op === 10) {
      heartbeat = setInterval(() => socket.send(JSON.stringify({ op: 1, d: sequence })), frame.d.heartbeat_interval);
      socket.send(JSON.stringify({
        op: 2,
        d: {
          token: config.token,
          intents: INTENTS,
          properties: { os: process.platform, browser: 'brittain-code', device: 'brittain-code' },
        },
      }));
      return;
    }
    if (frame.op === 7 || frame.op === 9) { socket.close(); return; }
    if (frame.op !== 0) return;

    if (frame.t === 'READY') {
      console.log(`Logged in as ${frame.d.user.username}. Owners: ${config.ownerIds.join(', ')}.`);
      return;
    }
    if (frame.t !== 'MESSAGE_CREATE') return;

    const message = frame.d;
    // Authorization first, before the content is even looked at. A message
    // that fails is logged and dropped in silence: replying "you are not
    // allowed" to strangers only confirms the bot is listening.
    const allowed = authorize(config, message);
    if (!allowed.ok) {
      console.log(`ignored message: ${allowed.reason}`);
      return;
    }
    lastChannel = message.channel_id;
    try {
      await handle(config, message, message.channel_id);
    } catch (error) {
      console.error('handler failed:', error);
      await send(config, message.channel_id, `Bridge error: ${String(error.message || error)}`);
    }
  });

  socket.addEventListener('close', () => {
    if (heartbeat) clearInterval(heartbeat);
    console.log('Gateway closed; reconnecting in 5s.');
    setTimeout(() => connect(config), 5_000);
  });
  socket.addEventListener('error', (error) => console.error('gateway error:', error.message || error));
}

async function main() {
  const config = loadConfig();
  if (!await daemon.daemonAlive(dir)) {
    console.error('The Brittain Code daemon is not running. Start it with /agent daemon install, or run the app with --headless.');
    process.exit(1);
  }
  console.log(`Daemon alive at ${daemon.socketPath(dir)}. Connecting to Discord…`);
  const notifyChannel = await resolveNotifyChannel(config);
  if (notifyChannel) console.log(`Unprompted notifications go to channel ${notifyChannel}.`);
  connect(config, notifyChannel);
}

main();
