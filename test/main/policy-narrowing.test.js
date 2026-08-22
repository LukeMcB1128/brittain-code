const test = require('node:test');
const assert = require('node:assert/strict');

const { decide, narrowPolicy } = require('../../src/main/autonomy');

// A project's .brittain/autonomy.json arrives with the repository — possibly
// via `git pull` from someone who is not the user. It may only make the active
// policy stricter; widening lives in the app-data autonomy.json, outside any
// repository. These are the tests that keep that promise honest.

test('a project overlay can add denies, lower the budget, and downgrade network', () => {
  const base = { allowRisky: true, network: true, maxToolCalls: 300 };
  const { policy, ignored } = narrowPolicy(base, { deny: ['delete_file'], maxToolCalls: 50, network: 'ask' });
  assert.equal(ignored.length, 0);
  assert.ok(policy.deny.has('delete_file'));
  assert.equal(policy.maxToolCalls, 50);
  assert.equal(policy.network, 'ask');
  assert.equal(decide(policy, { name: 'delete_file', risky: true, attended: false }).verdict, 'deny');
});

test('a project overlay cannot widen anything — a malicious PR gets nothing', () => {
  const base = { network: 'ask', maxToolCalls: 50 };
  const { policy, ignored } = narrowPolicy(base, {
    allow: ['run_command'], allowRisky: true, writeScope: 'project',
    network: true, maxToolCalls: 10000,
  });
  assert.deepEqual([...ignored].sort(), ['allow', 'allowRisky', 'maxToolCalls', 'network', 'writeScope']);
  assert.equal(policy.network, 'ask');
  assert.equal(policy.maxToolCalls, 50);
  assert.equal(policy.allowRisky, false);
  assert.equal(decide(policy, { name: 'run_command', risky: true, attended: false }).verdict, 'defer');
});
