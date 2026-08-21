const test = require('node:test');
const assert = require('node:assert/strict');

const {
  decide, checkPreconditions, listPolicies, getPolicy,
  policyForLegacyAutoApprove, BUILT_IN,
} = require('../../src/main/autonomy');

const verdict = (policyId, call) => decide(getPolicy(policyId), call).verdict;

test('supervised asks before every risky call, exactly as AUTO-APPROVE off did', () => {
  assert.equal(verdict('supervised', { name: 'write_file', risky: true }), 'ask');
  assert.equal(verdict('supervised', { name: 'run_command', risky: true }), 'ask');
  assert.equal(verdict('supervised', { name: 'read_file', risky: false }), 'allow');
});

test('trusted runs ordinary risky tools unattended, as AUTO-APPROVE on did', () => {
  assert.equal(verdict('trusted', { name: 'write_file', risky: true }), 'allow');
  assert.equal(verdict('trusted', { name: 'run_command', risky: true }), 'allow');
});

test('guarded reads freely but still asks before writing or running commands', () => {
  assert.equal(verdict('guarded', { name: 'read_file', risky: false }), 'allow');
  assert.equal(verdict('guarded', { name: 'run_project_check', risky: true }), 'allow');
  assert.equal(verdict('guarded', { name: 'write_file', risky: true }), 'ask');
  assert.equal(verdict('guarded', { name: 'run_command', risky: true }), 'ask');
});

test('the legacy checkbox maps onto the two stops that preserve its behaviour', () => {
  assert.equal(policyForLegacyAutoApprove(true), 'trusted');
  assert.equal(policyForLegacyAutoApprove(false), 'supervised');
});

// --- the invariants: no policy may waive these ---

const permissive = { allow: ['*'], allowRisky: true, network: true, writeScope: 'project' };

test('no policy can make a destructive operation automatic', () => {
  assert.equal(decide(permissive, { name: 'revert_to_last_commit', destructive: true }).verdict, 'ask');
  assert.equal(decide(permissive, { name: 'revert_to_last_commit', destructive: true, attended: false }).verdict, 'defer');
});

test('no policy can make an external MCP tool automatic', () => {
  assert.equal(decide(permissive, { name: 'mcp_github_create_issue', mcp: true }).verdict, 'ask');
  assert.equal(decide(permissive, { name: 'mcp_github_create_issue', mcp: true, attended: false }).verdict, 'defer');
});

test('no policy can make a sensitive read automatic', () => {
  assert.equal(decide(permissive, { name: 'read_file', sensitive: true }).verdict, 'ask');
  assert.equal(decide(permissive, { name: 'get_environment_variables', sensitive: true, attended: false }).verdict, 'defer');
});

test('online requests need both the app switch and a policy opt-in', () => {
  assert.equal(decide(permissive, { name: 'web_search', network: true, onlineResearch: false }).verdict, 'deny');
  assert.equal(decide(permissive, { name: 'web_search', network: true, onlineResearch: true }).verdict, 'allow');
  assert.equal(decide({ allowRisky: true }, { name: 'web_search', network: true, onlineResearch: true }).verdict, 'deny');
  assert.equal(decide({ network: 'ask' }, { name: 'web_search', network: true, onlineResearch: true }).verdict, 'ask');
});

// --- unattended behaviour ---

test('an ask with nobody watching becomes a defer, so the run continues', () => {
  assert.equal(verdict('supervised', { name: 'write_file', risky: true, attended: false }), 'defer');
  assert.equal(verdict('guarded', { name: 'run_command', risky: true, attended: false }), 'defer');
});

test('a deferred call is never executed, but never stalls the run either', () => {
  const result = decide(getPolicy('guarded'), { name: 'write_file', risky: true, attended: false });
  assert.equal(result.verdict, 'defer');
  assert.ok(result.reason);
  assert.notEqual(result.verdict, 'ask', 'an unattended ask would hang forever');
});

test('an explicit deny beats an allow list, however permissive', () => {
  const policy = { allow: ['*'], allowRisky: true, deny: ['run_command'] };
  assert.equal(decide(policy, { name: 'run_command', risky: true }).verdict, 'deny');
  assert.equal(decide(policy, { name: 'write_file', risky: true }).verdict, 'allow');
});

test('wildcards work in both allow and deny lists', () => {
  assert.equal(decide({ deny: ['mcp_*'], allow: ['*'] }, { name: 'mcp_github_x', risky: true }).verdict, 'deny');
  assert.equal(decide({ allow: ['find_*'] }, { name: 'find_symbol', risky: true }).verdict, 'allow');
  assert.equal(decide({ allow: ['find_*'] }, { name: 'write_file', risky: true }).verdict, 'ask');
});

test('a policy that permits no writes still asks before a risky tool', () => {
  const readOnly = { allowRisky: true, writeScope: 'none' };
  assert.equal(decide(readOnly, { name: 'write_file', risky: true }).verdict, 'ask');
  assert.equal(decide(readOnly, { name: 'write_file', risky: true, attended: false }).verdict, 'defer');
});

test('a spent tool-call budget stops the run whatever it is doing', () => {
  const policy = { allow: ['*'], allowRisky: true, maxToolCalls: 5 };
  assert.equal(decide(policy, { name: 'read_file', toolCalls: 4 }).verdict, 'allow');
  assert.equal(decide(policy, { name: 'read_file', toolCalls: 5 }).verdict, 'deny');
  assert.match(decide(policy, { name: 'read_file', toolCalls: 9 }).reason, /budget/);
});

// --- preconditions ---

test('an unattended run is refused without a repository to undo from', () => {
  const result = checkPreconditions(getPolicy('trusted'), { attended: false, isGitRepo: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /no undo without one/);
});

test('an attended run has no such requirement', () => {
  assert.equal(checkPreconditions(getPolicy('supervised'), { attended: true, isGitRepo: false }).ok, true);
});

test('a policy can require the work to sit on a generated branch', () => {
  const policy = { allowRisky: true, requireBranch: true };
  assert.equal(checkPreconditions(policy, { attended: false, isGitRepo: true, onBranch: 'main' }).ok, false);
  assert.equal(checkPreconditions(policy, { attended: false, isGitRepo: true, onBranch: 'brittain/fix-tests' }).ok, true);
});

test('custom policies join the built-ins without displacing them', () => {
  const all = listPolicies({ nightly: { label: 'Nightly', allow: ['read_file'] } });
  assert.deepEqual(Object.keys(all).sort(), ['guarded', 'nightly', 'supervised', 'trusted']);
  assert.equal(getPolicy('nightly', { nightly: { label: 'Nightly' } }).label, 'Nightly');
  assert.equal(getPolicy('missing'), null);
});

test('every built-in policy carries a label and a description for the dial', () => {
  for (const [id, policy] of Object.entries(BUILT_IN)) {
    assert.ok(policy.label, `${id} needs a label`);
    assert.ok(policy.description, `${id} needs a description`);
  }
});

test('a malformed policy is treated conservatively rather than permissively', () => {
  assert.equal(decide(null, { name: 'write_file', risky: true }).verdict, 'ask');
  assert.equal(decide({}, { name: 'write_file', risky: true, attended: false }).verdict, 'defer');
  assert.equal(decide({ allow: null, deny: null }, { name: 'write_file', risky: true }).verdict, 'ask');
});
