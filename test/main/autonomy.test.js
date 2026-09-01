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
  // Unattended, an invariant call parks: frozen and held for a real decision,
  // with the run suspending — not skipped, and not a hang.
  assert.equal(decide(permissive, { name: 'revert_to_last_commit', destructive: true, attended: false }).verdict, 'park');
});

test('no policy can make an external MCP tool automatic', () => {
  assert.equal(decide(permissive, { name: 'mcp_github_create_issue', mcp: true }).verdict, 'ask');
  assert.equal(decide(permissive, { name: 'mcp_github_create_issue', mcp: true, attended: false }).verdict, 'park');
});

test('no policy can make a sensitive read automatic', () => {
  assert.equal(decide(permissive, { name: 'read_file', sensitive: true }).verdict, 'ask');
  assert.equal(decide(permissive, { name: 'get_environment_variables', sensitive: true, attended: false }).verdict, 'park');
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

test('an unattended run no longer requires a Git repository', () => {
  // Undo is the wrong safety model for a run that acts on the world, so a
  // repo-less folder is allowed; the disclosure is the guard.
  assert.equal(checkPreconditions(getPolicy('trusted'), { attended: false, isGitRepo: false }).ok, true);
  assert.equal(checkPreconditions(getPolicy('supervised'), { attended: true, isGitRepo: false }).ok, true);
});

test('a policy may still opt into requiring a generated branch', () => {
  const policy = { allowRisky: true, requireBranch: true };
  assert.equal(checkPreconditions(policy, { attended: false, isGitRepo: true, onBranch: 'main' }).ok, false);
  assert.equal(checkPreconditions(policy, { attended: false, isGitRepo: true, onBranch: 'brittain/fix-tests' }).ok, true);
});

test('requiring a branch without a repository is refused as the contradiction it is', () => {
  const result = checkPreconditions({ allowRisky: true, requireBranch: true }, { attended: false, isGitRepo: false });
  assert.equal(result.ok, false);
  assert.match(result.error, /needs a Git repository/);
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

test('the dial is wired end to end and the old checkbox is gone', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', '..');
  const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

  const html = read('renderer/index.html');
  const app = read('renderer/app.js');

  assert.match(html, /<select id="autonomy-select">/);
  assert.doesNotMatch(html, /id="auto-approve"/, 'two controls for one concept is how an unintended write happens');
  assert.doesNotMatch(html, /id="setting-auto-approve"/, 'the settings duplicate goes too');
  assert.doesNotMatch(app, /autoApprove\.checked/);

  assert.match(app, /window\.api\.autonomyState\(\)/);
  assert.match(app, /window\.api\.autonomySet\(wanted\)/);
  assert.match(app, /confirmDialog\(/, 'choosing an unattended policy is a deliberate act');
  assert.match(app, /document\.body\.dataset\.autonomy/, 'unattended runs must be visible at a glance');

  assert.match(read('preload.js'), /autonomyState: \(\) => ipcRenderer\.invoke\('autonomy:state'\)/);
  assert.match(read('main.js'), /ipcMain\.handle\('autonomy:state'/);
  assert.match(read('main.js'), /ipcMain\.handle\('autonomy:set'/);
});

test('every approval path in main.js goes through the policy', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');

  // requestApproval should only be reachable via resolveToolCall now, so the
  // policy cannot be bypassed by adding a branch that prompts directly.
  const direct = [...main.matchAll(/await requestApproval\(/g)].length;
  assert.equal(direct, 1, 'requestApproval should have exactly one caller: resolveToolCall');
  assert.match(main, /async function resolveToolCall\(/);
  assert.match(main, /decideAutonomy\(policy, \{/);
  assert.match(main, /recordDecision\(\{ name, verdict: decision\.verdict/, 'every verdict is recorded, not only the denials');
  assert.match(main, /function deferredFrom\(run\)/, 'the deferred subset is the tray a person reads afterwards');
});

// --- the financial fence: bounded-B's one carve-out ---

const autonomous = { allow: ['*'], allowRisky: true, network: true, writeScope: 'project', maxToolCalls: 300 };

test('no policy, however permissive, makes a money-moving call automatic', () => {
  assert.equal(decide(autonomous, { name: 'run_command', financial: true, risky: true }).verdict, 'ask');
  assert.equal(decide(autonomous, { name: 'run_command', financial: true, risky: true, attended: false }).verdict, 'park');
});

test('the financial fence outranks even a network allow', () => {
  // A financial web request must not slip through on the network opt-in.
  const result = decide(autonomous, { name: 'web_fetch', financial: true, network: true, onlineResearch: true });
  assert.equal(result.verdict, 'ask');
  assert.match(result.reason, /financial/);
});

test('an ordinary call under the same policy still runs unattended', () => {
  assert.equal(decide(autonomous, { name: 'write_file', risky: true, attended: false }).verdict, 'allow');
  assert.equal(decide(autonomous, { name: 'run_command', risky: true, attended: false }).verdict, 'allow');
});

test('the shipped autonomous example is bounded, not a raw waiver', () => {
  const { EXAMPLE_CONFIG } = require('../../src/main/autonomy');
  const policy = EXAMPLE_CONFIG.policies.autonomous;
  assert.ok(policy.maxToolCalls > 0, 'an autonomous policy needs a tool-call ceiling');
  // requireBranch is off by default so an autonomous run works in any folder;
  // the ceiling and the standing invariants are the fence.
  assert.equal(policy.requireBranch, false);
  // Even this policy holds money, destructive ops, sensitive reads, and MCP —
  // unattended they park: frozen for approval, the run suspends.
  assert.equal(decide(policy, { name: 'run_command', financial: true, risky: true, attended: false }).verdict, 'park');
  assert.equal(decide(policy, { name: 'revert_to_last_commit', destructive: true, attended: false }).verdict, 'park');
  assert.equal(decide(policy, { name: 'mcp_x', mcp: true, attended: false }).verdict, 'park');
});


// --- park: the third unattended outcome ---

test('an invariant call parks unattended while a merely-risky call defers', () => {
  // Park suspends the run for a decision that is genuinely a human's to make;
  // defer skips a call whose answer would be stale by morning anyway.
  assert.equal(decide(permissive, { name: 'mcp_x', mcp: true, attended: false }).verdict, 'park');
  assert.equal(verdict('guarded', { name: 'write_file', risky: true, attended: false }), 'defer');
});

test('a policy deny still beats a would-be park', () => {
  const policy = { ...permissive, deny: ['mcp_x'] };
  assert.equal(decide(policy, { name: 'mcp_x', mcp: true, attended: false }).verdict, 'deny');
});

// --- auto-approving online requests ---

const onlineCall = (extra = {}) => ({ name: 'web_search', network: true, onlineResearch: true, ...extra });

test('a plain online request can be auto-approved from Settings', () => {
  // The point of the setting: stop confirming every single search.
  const policy = { network: 'ask' };
  assert.equal(decide(policy, onlineCall()).verdict, 'ask');
  const on = decide(policy, onlineCall({ networkAutoApprove: true }));
  assert.equal(on.verdict, 'allow');
  assert.match(on.reason, /Settings/);
});

test('auto-approve does not turn online research on', () => {
  // The master switch is a separate decision and stays the outer gate.
  const decision = decide({ network: 'ask' }, {
    name: 'web_search', network: true, onlineResearch: false, networkAutoApprove: true,
  });
  assert.equal(decision.verdict, 'deny');
  assert.match(decision.reason, /online research is disabled/);
});

test('auto-approve cannot overrule a policy that denies online requests', () => {
  // A policy naming online requests specifically is a deliberate choice; a
  // convenience toggle is not allowed to reverse it.
  const decision = decide({ network: 'deny' }, onlineCall({ networkAutoApprove: true }));
  assert.equal(decision.verdict, 'deny');
});

test('a sensitive read is not auto-approved just because it goes online', () => {
  // The network branch sits above the sensitive invariant, so returning
  // 'allow' here would send a credential out over the wire without asking —
  // exactly what that invariant exists to prevent.
  for (const policy of [{ network: 'ask' }, { network: true }]) {
    const decision = decide(policy, onlineCall({ sensitive: true, networkAutoApprove: true }));
    assert.equal(decision.verdict, 'ask', JSON.stringify(policy));
    assert.match(decision.reason, /sensitive/);
  }
});

test('a destructive or MCP call is judged on that, not on being online', () => {
  const destructive = decide({ network: true }, onlineCall({ destructive: true, networkAutoApprove: true }));
  assert.equal(destructive.verdict, 'ask');
  assert.match(destructive.reason, /destructive/);

  const mcp = decide({ network: true }, onlineCall({ mcp: true, networkAutoApprove: true }));
  assert.equal(mcp.verdict, 'ask');
  assert.match(mcp.reason, /MCP/);
});

test('a financial call stays manual however online requests are configured', () => {
  const decision = decide({ network: true }, onlineCall({ financial: true, networkAutoApprove: true }));
  assert.equal(decision.verdict, 'ask');
  assert.match(decision.reason, /financial/);
});

test('unattended, an auto-approved online request still runs', () => {
  // Whereas an un-approved one defers rather than hanging on a prompt.
  const attended = { network: 'ask' };
  assert.equal(decide(attended, onlineCall({ attended: false })).verdict, 'park');
  assert.equal(decide(attended, onlineCall({ attended: false, networkAutoApprove: true })).verdict, 'allow');
});

test('the setting is off by default and reaches the policy engine', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
  assert.match(read('settings.js'), /onlineAutoApprove: false,/);
  assert.match(read('main.js'), /networkAutoApprove: !!runtimeSettings\.onlineAutoApprove/);
  assert.ok(read('renderer/index.html').includes('id="setting-online-auto-approve"'));
});
