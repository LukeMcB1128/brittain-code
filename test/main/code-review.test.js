const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCodeReview } = require('../../src/main/code-review');

test('structured reviews normalize severity, confidence, location, and fixes', () => {
  const review = normalizeCodeReview({
    summary: 'One issue',
    findings: [{
      title: 'Crash on empty input',
      severity: 'HIGH',
      confidence: 96.6,
      file: './src/parser.js',
      line: 42,
      evidence: 'items[0] is read before the length check.',
      suggested_fix: 'Check the array length first.',
    }],
  }, 'main');

  assert.deepEqual(review.findings[0], {
    id: 'finding-1',
    title: 'Crash on empty input',
    severity: 'high',
    confidence: 97,
    file: 'src/parser.js',
    line: 42,
    evidence: 'items[0] is read before the length check.',
    suggestedFix: 'Check the array length first.',
  });
});

test('structured reviews drop findings without a project file', () => {
  const review = normalizeCodeReview({ findings: [{ severity: 'unknown' }, { file: '../outside.js' }] });
  assert.deepEqual(review.findings, []);
});
