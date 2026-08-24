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

const LAUNCH_LABEL = 'com.brittain.code.daemon';

// launchctl argument lists, kept here so they can be checked without spawning
// anything. bootstrap/bootout rather than load/unload: the older verbs are
// deprecated and, more usefully, bootout actually stops a KeepAlive job —
// `launchctl stop` on one just gets it restarted a second later.
function launchctlArgs(action, { uid = process.getuid?.() ?? 0, plistPath = '' } = {}) {
  switch (action) {
    case 'stop': return ['bootout', `gui/${uid}/${LAUNCH_LABEL}`];
    case 'start': return ['bootstrap', `gui/${uid}`, plistPath];
    case 'status': return ['print', `gui/${uid}/${LAUNCH_LABEL}`];
    default: throw new Error(`unknown launchctl action "${action}"`);
  }
}

function launchAgentPath() {
  return path.join(require('os').homedir(), 'Library', 'LaunchAgents', 'com.brittain.code.daemon.plist');
}

// launchd hands a job a minimal PATH — /usr/bin:/bin:/usr/sbin:/sbin — which
// contains no node. MCP servers are spawned as `npx ...`, so under launchd they
// simply fail to start while working perfectly when the app is opened normally.
// The PATH the installer is running with is the one that works, so carry it
// over, with the usual node locations as a floor in case the installer's own
// PATH was inherited from launchd too.
function daemonPath(currentPath = process.env.PATH || '') {
  const floor = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const seen = new Set();
  return [...String(currentPath).split(':'), ...floor]
    .map((entry) => entry.trim())
    .filter((entry) => entry && !seen.has(entry) && seen.add(entry))
    .join(':');
}

// KeepAlive is unconditional on purpose. The first version restarted only on
// failure, so a single clean exit left the daemon dead — the job sat at
// "runs = 1, last exit code = 0" for days while the app still reported it as
// installed. A thing called a daemon should come back.
function launchAgentPlist(execPath, appPath, { logDir = '', env = process.env } = {}) {
  // Dev runs need the app path argument (electron <app> --headless); a
  // packaged app's binary takes --headless alone.
  const args = [execPath, ...(appPath ? [appPath] : []), '--headless']
    .map((value) => `    <string>${value}</string>`).join('\n');
  const logs = logDir ? `
  <key>StandardOutPath</key><string>${path.join(logDir, 'daemon.out.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logDir, 'daemon.err.log')}</string>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.brittain.code.daemon</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${daemonPath(env.PATH)}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <!-- Restart whenever it exits, for any reason. ThrottleInterval stops a
       broken build from spinning. -->
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>${logs}
</dict>
</plist>
`;
}

module.exports = { socketPath, daemonAlive, startServer, sendCommand, launchAgentPath, launchAgentPlist, daemonPath, launchctlArgs, LAUNCH_LABEL };
