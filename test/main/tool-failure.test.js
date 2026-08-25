'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { callSignature, createToolFailureTracker, isToolErrorResult } = require('../../src/main/tool-failure');

test('tool call signatures are stable when object key order changes', () => {
  assert.equal(
    callSignature('click', { selector: '#save', exact: true }),
    callSignature('click', { exact: true, selector: '#save' }),
  );
});

test('the third identical failed tool call is blocked', () => {
  const tracker = createToolFailureTracker(2);
  const args = { selector: 'a[href="bad"]' };
  assert.equal(tracker.shouldBlock('browser_click', args), false);
  assert.deepEqual(tracker.record('browser_click', args, 'Error: not found'), { count: 1, reachedLimit: false });
  assert.equal(tracker.shouldBlock('browser_click', args), false);
  assert.deepEqual(tracker.record('browser_click', args, 'Error: not found'), { count: 2, reachedLimit: true });
  assert.equal(tracker.shouldBlock('browser_click', args), true);
  assert.equal(tracker.shouldBlock('browser_click', { selector: 'button[name="Save"]' }), false);
});

test('MCP error wrappers count as errors and success clears a call failure count', () => {
  assert.equal(isToolErrorResult('[MCP auto-approved] MCP tool error: selector did not match'), true);
  const tracker = createToolFailureTracker(2);
  const args = { ref: 'e12' };
  tracker.record('mcp_playwright_browser_click', args, 'Error: detached');
  tracker.record('mcp_playwright_browser_click', args, '[MCP auto-approved] clicked');
  tracker.record('mcp_playwright_browser_click', args, 'Error: detached');
  assert.equal(tracker.shouldBlock('mcp_playwright_browser_click', args), false);
});
