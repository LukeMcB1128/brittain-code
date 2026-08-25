const test = require('node:test');
const assert = require('node:assert/strict');

const { displayToolName } = require('../../renderer/features/tool-names');

test('ToolNames maps built-in tools to friendly labels', () => {
  assert.equal(displayToolName('edit_file'), 'Edit File');
  assert.equal(displayToolName('run_command'), 'Run Command');
  assert.equal(displayToolName('web_search'), 'Web Search');
  assert.equal(displayToolName('run_subagent'), 'Subagent');
});

test('ToolNames falls back to Title Case for unmapped tools', () => {
  assert.equal(displayToolName('my_mcp_tool'), 'My Mcp Tool');
  assert.equal(displayToolName('custom-tool'), 'Custom Tool');
});

test('ToolNames handles empty or null input safely', () => {
  assert.equal(displayToolName(''), '');
  assert.equal(displayToolName(null), '');
  assert.equal(displayToolName(undefined), '');
});
