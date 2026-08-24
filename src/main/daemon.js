'use strict';

// The headless control surface: a unix domain socket, deliberately not a port.
//
// OpenClaw's WebSocket control plane on a listening TCP port is the surface
// behind a good share of its reported incidents. A unix socket with filesystem
// permissions does everything this app needs — the daemon and the windowed app
// are the same user on the same machine — while being unreachable from the
// network by construction. (Windows gets a named pipe via the same net API.)
//
// Protocol: newline-delimited JSON both ways.
//   → { cmd: 'ping' }                     ← { ok: true, pid, startedAt }
//   → { cmd: 'run', payload: {...} }      ← { ok, ... }  (runAgentTask result)
//   → { cmd: 'status' }                   ← { ok: true, mission, queued }
//   → { cmd: 'attach' }                   ← run events stream to this client
//
// Exactly one scheduler may tick. The daemon owns it when running; a windowed
// app that finds a live daemon socket must not start its own.

const fs = require('fs');
const net = require('net');
const path = require('path');

function socketPath(userDataDir) {
  return process.platform === 'win32'
    ? '\\\\.\\pipe\\brittain-code-daemon'
    : path.join(userDataDir, 'daemon.sock');
}

// True if a daemon answers a ping within `timeoutMs`. A stale socket file with
// nobody behind it counts as dead, and is the caller's cue to take over.
function daemonAlive(userDataDir, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath(userDataDir));
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.on('connect', () => socket.write(JSON.stringify({ cmd: 'ping' }) + '\n'));
    socket.on('data', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

// Starts the control server. `handlers` maps cmd → async fn(payload) and is
// how this module stays free of any knowledge of runs, missions, or Electron.
// Returns { server, attachSink } — attachSink(emit) is wired into the run sink
// so attached clients receive the run narrative.
function startServer(userDataDir, handlers) {
  const target = socketPath(userDataDir);
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(target); } catch {} // a stale socket from a dead daemon
  }
  const attached = new Set();

  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', async (chunk) => {
      buffer += String(chunk);
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { socket.write(JSON.stringify({ ok: false, error: 'not JSON' }) + '\n'); continue; }
        if (message.cmd === 'attach') { attached.add(socket); socket.write(JSON.stringify({ ok: true, attached: true }) + '\n'); continue; }
        const handler = handlers[message.cmd];
        if (!handler) { socket.write(JSON.stringify({ ok: false, error: `unknown cmd "${message.cmd}"` }) + '\n'); continue; }
        try {
          const result = await handler(message.payload || {});
          socket.write(JSON.stringify(result ?? { ok: true }) + '\n');
        } catch (error) {
          socket.write(JSON.stringify({ ok: false, error: String(error?.message || error) }) + '\n');
        }
      }
    });
    socket.on('close', () => attached.delete(socket));
    socket.on('error', () => attached.delete(socket));
  });
  server.listen(target);

  function broadcast(channel, payload, metadata = null) {
    if (!attached.size) return;
    const line = JSON.stringify({ event: channel, payload, metadata }) + '\n';
    for (const socket of attached) {
      try { socket.write(line); } catch { attached.delete(socket); }
    }
  }

  return { server, broadcast, socketPath: target };
}

// One-shot client: send a command, await one reply line.
//
// A timeoutMs of 0 waits indefinitely, which is what `run` needs — its reply
// only arrives once the agent has finished, and that is measured in minutes.
// Progress in the meantime comes over an attached socket, not this one.
function sendCommand(userDataDir, message, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath(userDataDir));
    const timer = timeoutMs > 0
      ? setTimeout(() => { socket.destroy(); resolve({ ok: false, error: 'daemon did not answer' }); }, timeoutMs)
      : null;
    let buffer = '';
    socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
    socket.on('data', (chunk) => {
      buffer += String(chunk);
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      if (timer) clearTimeout(timer);
      socket.destroy();
      try { resolve(JSON.parse(buffer.slice(0, newline))); } catch { resolve({ ok: false, error: 'bad reply' }); }
    });
    socket.on('error', (error) => { if (timer) clearTimeout(timer); resolve({ ok: false, error: String(error.message || error) }); });
  });
}

// ---------- LaunchAgent install (macOS; opt-in, never on app install) ----------

function launchAgentPath() {
  return path.join(require('os').homedir(), 'Library', 'LaunchAgents', 'com.brittain.code.daemon.plist');
}

function launchAgentPlist(execPath, appPath) {
  // Dev runs need the app path argument (electron <app> --headless); a
  // packaged app's binary takes --headless alone.
  const args = [execPath, ...(appPath ? [appPath] : []), '--headless']
    .map((value) => `    <string>${value}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.brittain.code.daemon</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
`;
}

module.exports = { socketPath, daemonAlive, startServer, sendCommand, launchAgentPath, launchAgentPlist };
