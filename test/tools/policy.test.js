const test = require('node:test');
const assert = require('node:assert/strict');

const { createToolPolicy } = require('../../src/tools/policy');

function definition(name) {
  return { type: 'function', function: { name, parameters: { type: 'object' } } };
}

test('tool policy derives each role from one definition registry', () => {
  const policy = createToolPolicy([
    definition('read_file'),
    definition('write_file'),
    definition('ask_user'),
    definition('calculate'),
    definition('web_search'),
    definition('run_subagent'),
  ]);

  assert.deepEqual(policy.SUBAGENT_TOOLS.map((item) => item.function.name), ['read_file']);
  assert.deepEqual(policy.CODER_TOOLS.map((item) => item.function.name), ['read_file', 'write_file']);
  assert.deepEqual(policy.CHAT_TOOLS.map((item) => item.function.name), ['ask_user', 'calculate', 'web_search']);
  assert.deepEqual(policy.ORCHESTRATOR_TOOLS.map((item) => item.function.name), [
    'read_file',
    'web_search',
    'run_subagent',
    'submit_implementation_plan',
  ]);
  assert.equal(policy.RISKY_TOOLS.has('web_search'), true);
  assert.equal(policy.NETWORK_TOOLS.has('web_search'), true);
});
