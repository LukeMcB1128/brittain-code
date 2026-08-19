const test = require('node:test');
const assert = require('node:assert/strict');

const { sortedFindings } = require('../../renderer/features/review-findings');

test('review findings sort by severity and confidence', () => {
  const sorted = sortedFindings([
    { id: 'low', severity: 'low', confidence: 99, file: 'b', line: 1 },
    { id: 'high-low-confidence', severity: 'high', confidence: 70, file: 'a', line: 1 },
    { id: 'high-high-confidence', severity: 'high', confidence: 95, file: 'c', line: 1 },
  ]);
  assert.deepEqual(sorted.map((finding) => finding.id), ['high-high-confidence', 'high-low-confidence', 'low']);
});
