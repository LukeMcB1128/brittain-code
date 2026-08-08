const test = require('node:test');
const assert = require('node:assert/strict');

const { parsePatchLines } = require('../../renderer/features/diff-viewer');

test('Diff v2 assigns old and new line numbers to patch rows', () => {
  const rows = parsePatchLines([
    'diff --git a/a.js b/a.js',
    '@@ -10,3 +10,3 @@',
    ' same',
    '-old',
    '+new',
    ' end',
  ].join('\n'));

  assert.deepEqual(rows.slice(2).map((row) => [row.type, row.oldNumber, row.newNumber]), [
    ['context', 10, 10],
    ['delete', 11, ''],
    ['add', '', 11],
    ['context', 12, 12],
  ]);
});
