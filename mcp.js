// Brittain Code — minimal Model Context Protocol client (stdio transport).
// Hand-rolled JSON-RPC 2.0 over newline-delimited stdio: no dependencies, no
// supply chain in the most security-sensitive component of the app. Servers
// are configured in <userData>/mcp.json using the same shape as Claude
// Desktop's config:
//   { "mcpServers": { "name": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"], "env": {} } } }
//
// Every MCP tool surfaced to the model is namespaced mcp_<server>_<tool> and
// ALWAYS requires user approval (enforced in main.js) — third-party tools are
// untrusted by default, regardless of AUTO-APPROVE.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const PROTOCOL_VERSION = '2025-06-18';
const START_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 60_000;

function sanitizeName(s) {
  return String(s).replace(/[^a-zA-Z0-9_]/g, '_');
}

class McpServer {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject, timer }
    this.tools = [];
    this.status = 'stopped'; // stopped | starting | running | failed
    this.lastError = '';
    this.stderrTail = '';
  }

  send(msg) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error('server not running');
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${this.name}: "${method}" timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  notify(method, params) {
    try { this.send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); } catch {}
  }

  handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; } // ignore non-JSON noise
    if (msg.id === undefined || !this.pending.has(msg.id)) return; // notification or unknown
    const { resolve, reject, timer } = this.pending.get(msg.id);
    clearTimeout(timer);
    this.pending.delete(msg.id);
    if (msg.error) reject(new Error(`MCP ${this.name}: ${msg.error.message || JSON.stringify(msg.error)}`));
    else resolve(msg.result);
  }

  failAllPending(reason) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`MCP ${this.name}: ${reason}`));
    }
    this.pending.clear();
  }

  async start() {
    this.status = 'starting';
    try {
      this.proc = spawn(this.config.command, this.config.args || [], {
        env: { ...process.env, ...(this.config.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this.status = 'failed';
      this.lastError = err.message;
      throw err;
    }

    readline.createInterface({ input: this.proc.stdout }).on('line', (l) => this.handleLine(l));
    this.proc.stderr.on('data', (d) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    this.proc.on('error', (err) => {
      this.status = 'failed';
      this.lastError = err.message;
      this.failAllPending('process error: ' + err.message);
    });
    this.proc.on('exit', (code) => {
      if (this.status !== 'stopped') {
        this.status = 'failed';
        this.lastError = `exited with code ${code}` + (this.stderrTail ? ` — stderr: ${this.stderrTail.slice(-300)}` : '');
      }
      this.failAllPending('server exited');
    });

    await this.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'brittain-code', version: '1.0' },
    }, START_TIMEOUT_MS);
    this.notify('notifications/initialized');

    const listed = await this.request('tools/list', {}, START_TIMEOUT_MS);
    this.tools = Array.isArray(listed?.tools) ? listed.tools : [];
    this.status = 'running';
    return this.tools.length;
  }

  async callTool(toolName, args) {
    const result = await this.request('tools/call', { name: toolName, arguments: args || {} });
    // result.content is an array of typed blocks; flatten text, describe the rest
    const parts = (result?.content || []).map((c) => {
      if (c.type === 'text') return c.text;
      return `[${c.type} content omitted]`;
    });
    const text = parts.join('\n') || '(empty result)';
    return result?.isError ? `MCP tool error: ${text}` : text;
  }

  stop() {
    this.status = 'stopped';
    this.failAllPending('server stopped');
    try { this.proc?.kill(); } catch {}
    this.proc = null;
  }
}

class McpManager {
  constructor() {
    this.servers = new Map();   // name -> McpServer
    this.enabled = new Set();   // session-toggleable via /mcp
    this.routes = new Map();    // qualified tool name -> { server, tool }
    this.configPath = '';
  }

  loadConfig(userDataDir) {
    this.configPath = path.join(userDataDir, 'mcp.json');
    try {
      const cfg = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
      return cfg.mcpServers || {};
    } catch {
      return {}; // no config = no servers, everything no-ops
    }
  }

  async startAll(userDataDir) {
    const entries = Object.entries(this.loadConfig(userDataDir));
    const results = [];
    for (const [name, config] of entries) {
      const server = new McpServer(name, config);
      this.servers.set(name, server);
      this.enabled.add(name);
      try {
        const count = await server.start();
        results.push({ name, ok: true, tools: count });
      } catch (err) {
        server.lastError = server.lastError || err.message;
        server.status = 'failed';
        results.push({ name, ok: false, error: server.lastError });
      }
    }
    this.rebuildRoutes();
    return results;
  }

  rebuildRoutes() {
    this.routes.clear();
    for (const [name, server] of this.servers) {
      if (server.status !== 'running') continue;
      for (const tool of server.tools) {
        this.routes.set(`mcp_${sanitizeName(name)}_${sanitizeName(tool.name)}`, { server: name, tool: tool.name });
      }
    }
  }

  // TOOL_DEFS-shaped definitions for all tools on enabled, running servers
  toolDefs() {
    const defs = [];
    for (const [qualified, route] of this.routes) {
      if (!this.enabled.has(route.server)) continue;
      const server = this.servers.get(route.server);
      const tool = server.tools.find((t) => t.name === route.tool);
      if (!tool) continue;
      defs.push({
        type: 'function',
        function: {
          name: qualified,
          description: `[MCP: ${route.server}] ${tool.description || tool.name} (external tool — every call requires user approval)`,
          parameters: tool.inputSchema && tool.inputSchema.type ? tool.inputSchema : { type: 'object', properties: {} },
        },
      });
    }
    return defs;
  }

  owns(name) {
    return this.routes.has(name);
  }

  async call(qualifiedName, args) {
    const route = this.routes.get(qualifiedName);
    if (!route) return `Error: unknown MCP tool "${qualifiedName}".`;
    if (!this.enabled.has(route.server)) return `Error: MCP server "${route.server}" is disabled (/mcp on ${route.server} to enable).`;
    const server = this.servers.get(route.server);
    if (!server || server.status !== 'running') return `Error: MCP server "${route.server}" is not running (${server?.lastError || 'unknown state'}).`;
    try {
      return await server.callTool(route.tool, args);
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }

  status() {
    return [...this.servers.entries()].map(([name, s]) => ({
      name,
      status: s.status,
      tools: s.tools.length,
      enabled: this.enabled.has(name),
      error: s.lastError || undefined,
    }));
  }

  setEnabled(name, on) {
    if (!this.servers.has(name)) return false;
    if (on) this.enabled.add(name);
    else this.enabled.delete(name);
    return true;
  }

  stopAll() {
    for (const s of this.servers.values()) s.stop();
  }
}

module.exports = { McpManager, McpServer, sanitizeName };
