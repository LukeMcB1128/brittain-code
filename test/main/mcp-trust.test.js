const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const trust = require('../../src/main/mcp-trust');
const { decide } = require('../../src/main/autonomy');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bc-trust-'));
}

const gmail = {
  command: 'npx', args: ['-y', 'gmail-mcp'],
  trust: { search: 'allow', send: 'park', '*': 'ask' },
};

test('a per-tool grant applies; the wildcard and unknown tools stay untrusted', () => {
  const dir = tempDir();
  assert.equal(trust.effectiveTrust(dir, 'gmail', gmail, 'search').level, 'allow');
  assert.equal(trust.effectiveTrust(dir, 'gmail', gmail, 'send').level, 'park');
  // '*': 'ask' and an unlisted tool both resolve to the untrusted default.
  assert.equal(trust.effectiveTrust(dir, 'gmail', gmail, 'delete_all').level, '');
});

test('a changed command line voids every grant until re-affirmed', () => {
  const dir = tempDir();
  trust.effectiveTrust(dir, 'gmail', gmail, 'search'); // first sighting affirms
  const updated = { ...gmail, args: ['-y', 'gmail-mcp@2.0.0'] };
  const result = trust.effectiveTrust(dir, 'gmail', updated, 'search');
  assert.equal(result.level, '');
  assert.equal(result.stale, true);
  // Explicit re-affirmation restores the grant for the new command line.
  trust.affirm(dir, 'gmail', updated);
  assert.equal(trust.effectiveTrust(dir, 'gmail', updated, 'search').level, 'allow');
});

test('a server with no trust map has no grants and nothing recorded', () => {
  const dir = tempDir();
  assert.equal(trust.effectiveTrust(dir, 'files', { command: 'npx', args: ['fs-mcp'] }, 'read').level, '');
  assert.deepEqual(trust.readStore(dir), {});
});

// --- how a grant reaches the policy decision ---

const permissive = { allow: ['*'], allowRisky: true, network: true, writeScope: 'project' };


test('an explicit per-tool trust grant runs an MCP tool unattended', () => {
  assert.equal(decide(permissive, { name: 'mcp_gmail_search', mcp: true, mcpTrust: 'allow', attended: false }).verdict, 'allow');
});

test('a park-level grant still parks; no grant means the untrusted default', () => {
  assert.equal(decide(permissive, { name: 'mcp_gmail_send', mcp: true, mcpTrust: 'park', attended: false }).verdict, 'park');
  assert.equal(decide(permissive, { name: 'mcp_gmail_send', mcp: true, mcpTrust: 'park' }).verdict, 'ask');
  assert.equal(decide(permissive, { name: 'mcp_other', mcp: true, attended: false }).verdict, 'park');
});

test('trust cannot waive the financial or destructive invariants on an MCP call', () => {
  assert.equal(decide(permissive, { name: 'mcp_pay', mcp: true, mcpTrust: 'allow', financial: true, attended: false }).verdict, 'park');
  assert.equal(decide(permissive, { name: 'mcp_rm', mcp: true, mcpTrust: 'allow', destructive: true, attended: false }).verdict, 'park');
});
