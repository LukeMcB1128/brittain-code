const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatTokens,
  parseTextLines,
  filterRows,
  roleInitial,
} = require('../../renderer/features/context-viewer');

test('ContextViewer parses text lines with 1-based line numbers', () => {
  const lines = parseTextLines('first line\nsecond line\nthird line');
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], { lineNumber: 1, text: 'first line' });
  assert.deepEqual(lines[1], { lineNumber: 2, text: 'second line' });
  assert.deepEqual(lines[2], { lineNumber: 3, text: 'third line' });
});

test('ContextViewer handles empty or null text safely', () => {
  const lines = parseTextLines('');
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], { lineNumber: 1, text: ' ' });

  const nullLines = parseTextLines(null);
  assert.equal(nullLines.length, 1);
  assert.deepEqual(nullLines[0], { lineNumber: 1, text: ' ' });
});

test('ContextViewer filters rows by role and search query', () => {
  const rows = [
    { index: 0, role: 'user', content: 'hello world', preview: 'hello world', tokens: 10 },
    { index: 1, role: 'assistant', content: 'let me check', preview: 'let me check', tokens: 20 },
    { index: 2, role: 'tool', toolName: 'browse_files', content: 'package.json', preview: 'package.json', tokens: 30 },
    { index: 3, role: 'user', content: 'show me diff', preview: 'show me diff', pinned: true, tokens: 15 },
    { index: 4, role: 'tool', toolName: 'read_file', content: 'large content', preview: 'large content', excluded: true, tokens: 50 },
  ];

  // All filter
  assert.equal(filterRows(rows, { role: 'all' }).length, 5);

  // Role filters
  assert.deepEqual(
    filterRows(rows, { role: 'user' }).map((r) => r.index),
    [0, 3]
  );
  assert.deepEqual(
    filterRows(rows, { role: 'assistant' }).map((r) => r.index),
    [1]
  );
  assert.deepEqual(
    filterRows(rows, { role: 'tool' }).map((r) => r.index),
    [2, 4]
  );
  assert.deepEqual(
    filterRows(rows, { role: 'pinned' }).map((r) => r.index),
    [3]
  );
  assert.deepEqual(
    filterRows(rows, { role: 'excluded' }).map((r) => r.index),
    [4]
  );

  // Search query filter
  assert.deepEqual(
    filterRows(rows, { role: 'all', query: 'diff' }).map((r) => r.index),
    [3]
  );
  assert.deepEqual(
    filterRows(rows, { role: 'all', query: 'browse_files' }).map((r) => r.index),
    [2]
  );
});

test('ContextViewer formats tokens with locale commas', () => {
  assert.equal(formatTokens(13495), '13,495');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(null), '0');
});

test('ContextViewer returns appropriate role initial character', () => {
  assert.equal(roleInitial('user'), 'U');
  assert.equal(roleInitial('assistant'), 'A');
  assert.equal(roleInitial('tool'), 'T');
  assert.equal(roleInitial('system'), 'S');
  assert.equal(roleInitial('unknown'), 'M');
});
