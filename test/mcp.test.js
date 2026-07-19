const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { McpManager, McpServer, sanitizeName } = require('../mcp');

const FAKE = path.join(__dirname, '..', 'test-fixtures', 'fake-mcp-server.js');

test('mcp: handshake, tool listing, and calls against a real stdio server', async (t) => {
  const server = new McpServer('fake', { command: process.execPath, args: [FAKE] });
  t.after(() => server.stop());

  const count = await server.start();
  assert.equal(count, 4);
  assert.equal(server.status, 'running');

  const out = await server.callTool('echo', { message: 'hello mcp' });
  assert.equal(out, 'echo: hello mcp');

  const err = await server.callTool('fail', {});
  assert.match(err, /MCP tool error: something broke/);
});

test('mcp: call timeout fires and does not wedge the client', async (t) => {
  const server = new McpServer('fake', { command: process.execPath, args: [FAKE] });
  t.after(() => server.stop());
  await server.start();

  // ask for a 2s sleep with a 300ms budget via the low-level request
  await assert.rejects(
    server.request('tools/call', { name: 'slow', arguments: { ms: 2000 } }, 300),
    /timed out/
  );
  // client still healthy afterwards
  const out = await server.callTool('echo', { message: 'still alive' });
  assert.equal(out, 'echo: still alive');
});

test('mcp: server crash rejects pending calls and reports failed status', async (t) => {
  const server = new McpServer('fake', { command: process.execPath, args: [FAKE] });
  t.after(() => server.stop());
  await server.start();

  await assert.rejects(server.callTool('die', {}), /exited|stopped|error/i);
  assert.equal(server.status, 'failed');
});

test('mcp: manager loads config, namespaces tools, routes calls, and toggles', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mcp-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));
  fs.writeFileSync(path.join(userData, 'mcp.json'), JSON.stringify({
    mcpServers: { 'my-server.v2': { command: process.execPath, args: [FAKE] } },
  }));

  const mgr = new McpManager();
  t.after(() => mgr.stopAll());
  const results = await mgr.startAll(userData);
  assert.equal(results[0].ok, true);

  const defs = mgr.toolDefs();
  const names = defs.map((d) => d.function.name);
  assert.ok(names.includes('mcp_my_server_v2_echo'), names.join(','));
  assert.ok(defs.every((d) => /requires user approval/.test(d.function.description)));
  assert.ok(defs.every((d) => /^[a-zA-Z0-9_]+$/.test(d.function.name)), 'ollama-safe names');

  assert.equal(mgr.owns('mcp_my_server_v2_echo'), true);
  assert.equal(mgr.owns('write_file'), false);
  assert.equal(await mgr.call('mcp_my_server_v2_echo', { message: 'routed' }), 'echo: routed');

  // disable → defs disappear and calls refuse
  mgr.setEnabled('my-server.v2', false);
  assert.equal(mgr.toolDefs().length, 0);
  assert.match(await mgr.call('mcp_my_server_v2_echo', { message: 'x' }), /disabled/);

  mgr.setEnabled('my-server.v2', true);
  assert.equal(mgr.toolDefs().length, 4);
});

test('mcp: missing config and broken server are graceful no-ops', async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mcp2-'));
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }));

  const mgr = new McpManager();
  assert.deepEqual(await mgr.startAll(userData), []); // no config file
  assert.equal(mgr.toolDefs().length, 0);

  fs.writeFileSync(path.join(userData, 'mcp.json'), JSON.stringify({
    mcpServers: { broken: { command: '/nonexistent/binary' } },
  }));
  const mgr2 = new McpManager();
  t.after(() => mgr2.stopAll());
  const results = await mgr2.startAll(userData);
  assert.equal(results[0].ok, false);
  assert.equal(mgr2.toolDefs().length, 0);
  assert.equal(mgr2.status()[0].status, 'failed');
});
