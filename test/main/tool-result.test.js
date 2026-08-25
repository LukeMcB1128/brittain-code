'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MAX_TOOL_RESULT_CHARS, boundToolResult, isUnboundedBrowserEvaluation } = require('../../src/main/tool-result');

test('tool results keep normal output unchanged and bound large output', () => {
  assert.deepEqual(boundToolResult('small result'), {
    content: 'small result', truncated: false, originalChars: 12, omittedChars: 0,
  });

  const source = 'start-' + 'x'.repeat(MAX_TOOL_RESULT_CHARS * 2) + '-end';
  const bounded = boundToolResult(source, { toolName: 'browser_evaluate' });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.content.length, MAX_TOOL_RESULT_CHARS);
  assert.match(bounded.content, /^start-/);
  assert.match(bounded.content, /result shortened/);
  assert.match(bounded.content, /-end$/);
  assert.ok(bounded.omittedChars > 0);
});

test('full DOM evaluate is blocked but targeted browser evaluate stays available', () => {
  assert.equal(isUnboundedBrowserEvaluation('mcp_playwright_browser_evaluate', {
    function: '() => document.documentElement.outerHTML',
  }), true);
  assert.equal(isUnboundedBrowserEvaluation('mcp_playwright_browser_evaluate', {
    function: '() => document.body.innerHTML',
  }), true);
  assert.equal(isUnboundedBrowserEvaluation('mcp_playwright_browser_evaluate', {
    function: '() => document.querySelector("h1")?.textContent',
  }), false);
  assert.equal(isUnboundedBrowserEvaluation('read_file', {
    path: 'document.documentElement.outerHTML',
  }), false);
});

test('the agent bounds saved and new tool results and measures context after tools', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'main.js'), 'utf8');
  assert.match(main, /if \(message\.role === 'tool'\)[\s\S]{0,300}boundToolResult\(message\.content/);
  assert.match(main, /conversation\.push\(\{ role: 'tool',[\s\S]{0,100}content: bounded\.content/);
  assert.match(main, /const estimatedNow = estimateTokens\(messages\(\)\) \+ estimateTokens\(agentTools \|\| \[\]\)/);
  assert.match(main, /const used = Math\.max\(measured, estimatedNow\)/);
});
