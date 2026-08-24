#!/usr/bin/env node
'use strict';

// Run the Discord bridge standalone, against a daemon that is already running.
//
// The packaged app does not need this: it starts the bridge in process, in
// whichever process owns the trigger scheduler. This exists for a checkout —
// running the bridge without the app in front of you, or watching its log while
// developing it. Both paths share src/bridge/discord-client.js, so the two
// cannot drift apart.
//
// Run:  npm run discord

const os = require('os');
const path = require('path');
const net = require('net');

const { createDiscordBridge } = require('../src/bridge/discord-client');
const { ensureConfig, readConfig, validateConfig, configPath, greetStore } = require('../src/bridge/discord-config');
const daemon = require('../src/main/daemon');

function userDataDir() {
  if (process.env.BRITTAIN_USER_DATA) return process.env.BRITTAIN_USER_DATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Brittain Code');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || os.homedir(), 'Brittain Code');
  return path.join(os.homedir(), '.config', 'Brittain Code');
}

const dir = userDataDir();

// Run events arrive over a socket held open for the session. A dropped attach
// costs progress messages, not correctness — the run continues on the daemon
// regardless — so it reconnects quietly.
function subscribeOverSocket(listener) {
  let closed = false;
  const open = () => {
    const socket = net.connect(daemon.socketPath(dir));
    let buffer = '';
    socket.on('connect', () => socket.write(JSON.stringify({ cmd: 'attach' }) + '\n'));
    socket.on('data', (data) => {
      buffer += String(data);
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.event) listener(message.event, message.payload, message.metadata || null);
        } catch {}
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => { if (!closed) setTimeout(open, 5_000); });
  };
  open();
  return () => { closed = true; };
}

async function main() {
  const file = ensureConfig(dir);
  const { config, error } = readConfig(dir);
  if (error) {
    console.error(`${file} could not be read: ${error}`);
    process.exit(1);
  }
  const missing = validateConfig(config);
  if (missing.length) {
    console.error(`${configPath(dir)} is not ready: missing ${missing.join(', ')}.`);
    process.exit(1);
  }
  if (!await daemon.daemonAlive(dir)) {
    console.error('The Brittain Code daemon is not running. Start it with /agent daemon install, or run the app with --headless.');
    console.error('(The packaged app runs the bridge itself — this script is only for running it separately.)');
    process.exit(1);
  }

  console.log(`Daemon alive at ${daemon.socketPath(dir)}. Connecting to Discord…`);
  const bridge = createDiscordBridge({
    config,
    ask: (message, timeoutMs) => daemon.sendCommand(dir, message, timeoutMs),
    greetStore: greetStore(dir),
    subscribe: subscribeOverSocket,
  });
  const { notifyChannel } = await bridge.start();
  if (notifyChannel) console.log(`Unprompted notifications go to channel ${notifyChannel}.`);
}

main();
