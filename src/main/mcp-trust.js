'use strict';

// Graduated, per-tool MCP trust — the pure half.
//
// "MCP is never automatic" is right for a server installed five minutes ago
// and wrong forever after. A user may grant a specific tool on a specific
// server 'allow' (runs unattended) or 'park' (suspends for approval) in
// mcp.json:
//
//   { "mcpServers": { "gmail": {
//       "command": "npx", "args": ["-y", "gmail-mcp"],
//       "trust": { "search": "allow", "send": "park", "*": "ask" } } } }
//
// The grant is keyed to the server's command line. If the command or args
// change — a different binary, a different package, new flags — the trust no
// longer applies: a server that silently updated has not earned what the old
// one had. The fingerprint recorded at grant time lives in
// userData/mcp-trust.json; a mismatch drops every grant on that server back to
// 'ask' until the user re-affirms.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEVELS = new Set(['allow', 'park', 'ask']);

function fingerprint(serverConfig) {
  const identity = JSON.stringify({
    command: String(serverConfig?.command || ''),
    args: (serverConfig?.args || []).map(String),
  });
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 20);
}

function storePath(userDataDir) {
  return path.join(userDataDir, 'mcp-trust.json');
}

function readStore(userDataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(userDataDir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStore(userDataDir, store) {
  const target = storePath(userDataDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = target + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, target);
}

// Records the current fingerprint as affirmed — called when trust first
// appears for a server, and again when the user explicitly re-affirms after a
// command-line change (/mcp trust accept <server>).
function affirm(userDataDir, serverName, serverConfig) {
  const store = readStore(userDataDir);
  store[serverName] = { fingerprint: fingerprint(serverConfig), at: new Date().toISOString() };
  writeStore(userDataDir, store);
}

// The effective trust level for one tool on one server, or '' when no valid
// grant applies (callers treat '' as the untrusted default).
// `stale` reports a trust map ignored because the command line changed.
function effectiveTrust(userDataDir, serverName, serverConfig, toolName) {
  const trust = serverConfig?.trust;
  if (!trust || typeof trust !== 'object') return { level: '', stale: false };
  const recorded = readStore(userDataDir)[serverName];
  if (!recorded) {
    // First sighting of a trust map: affirm the current command line so a
    // LATER change is detectable. The user wrote this config; it is theirs.
    affirm(userDataDir, serverName, serverConfig);
  } else if (recorded.fingerprint !== fingerprint(serverConfig)) {
    return { level: '', stale: true };
  }
  const level = trust[toolName] ?? trust['*'] ?? '';
  return { level: LEVELS.has(level) && level !== 'ask' ? level : '', stale: false };
}

module.exports = { fingerprint, effectiveTrust, affirm, readStore, storePath, LEVELS };
