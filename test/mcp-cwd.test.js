const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { McpServer } = require('../mcp');

test('a server writes into its own directory, not the app\'s', () => {
  // A child process with no cwd inherits the app's, which in development is the
  // source tree. Playwright saving screenshots scattered twenty PNGs through
  // the repository root.
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mcp-'));
  const server = new McpServer('playwright', { command: 'npx', args: ['-y', 'x'] }, userData);
  assert.equal(server.workingDirectory, path.join(userData, 'mcp', 'playwright'));
  assert.ok(fs.existsSync(server.workingDirectory), 'created on demand, so the spawn cannot fail on a missing dir');
  assert.notEqual(server.workingDirectory, process.cwd());
});

test('a server name cannot escape the directory it is given', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-mcp-'));
  const server = new McpServer('../../etc', { command: 'npx' }, userData);
  assert.ok(server.workingDirectory.startsWith(path.join(userData, 'mcp')),
    'the name is sanitised before it becomes a path');
});

test('a server that needs a specific directory can say so', () => {
  const server = new McpServer('fs', { command: 'npx', cwd: '/tmp/somewhere' }, '/unused');
  assert.equal(server.workingDirectory, '/tmp/somewhere');
});

test('the spawn actually uses it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'mcp.js'), 'utf8');
  const spawnCall = source.slice(source.indexOf('this.proc = spawn('), source.indexOf('this.proc = spawn(') + 260);
  assert.match(spawnCall, /cwd: this\.workingDirectory,/);
});

test('/mcp says where a server keeps its files', () => {
  // A screenshot the model took is only useful if you can find it.
  const app = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.match(app, /files: \$\{sv\.workingDirectory\}/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'mcp.js'), 'utf8'), /workingDirectory: s\.workingDirectory \|\| '',/);
});
