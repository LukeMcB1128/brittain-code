const test = require('node:test');
const assert = require('node:assert/strict');

const { selectAutoModel } = require('../../src/main/model-router');

function model(name, overrides = {}) {
  return {
    name,
    capabilities: { tools: true, vision: false },
    fit: { level: 'good', label: 'GPU FIT' },
    recommended: false,
    ...overrides,
  };
}

test('AUTO selects the recommended compatible model', () => {
  const result = selectAutoModel([
    model('fast:8b'),
    model('quality:27b', {
      recommended: true,
      brittainmark: { score: 91 },
      speed: { tokensPerSecond: 18 },
    }),
  ], { mode: 'code' });

  assert.equal(result.ok, true);
  assert.equal(result.model, 'quality:27b');
  assert.match(result.reason, /tool support/);
  assert.match(result.reason, /Brittainmark 91/);
  assert.match(result.reason, /18 t\/s measured/);
});

test('AUTO requires reported tool support in Code mode when possible', () => {
  const result = selectAutoModel([
    model('chat-only:20b', { capabilities: { tools: false, vision: false }, recommended: true }),
    model('coder:8b'),
  ], { mode: 'code' });

  assert.equal(result.model, 'coder:8b');
});

test('AUTO filters for image support when an image is attached', () => {
  const result = selectAutoModel([
    model('text:27b', { recommended: true }),
    model('vision:12b', { capabilities: { tools: true, vision: true } }),
  ], { mode: 'code', needsVision: true });

  assert.equal(result.model, 'vision:12b');
  assert.match(result.reason, /image support/);
});

test('AUTO reports when no image-capable model is installed', () => {
  const result = selectAutoModel([model('text:8b')], { mode: 'chat', needsVision: true });
  assert.deepEqual(result, { ok: false, error: 'No installed model reports image support.' });
});

test('AUTO avoids a memory-risk model when a compatible safe model exists', () => {
  const result = selectAutoModel([
    model('too-large:70b', { fit: { level: 'risk', label: 'MEMORY RISK' }, recommended: true }),
    model('usable:14b'),
  ], { mode: 'code' });

  assert.equal(result.model, 'usable:14b');
  assert.equal(result.warning, null);
});

test('AUTO can use the only compatible model and reports its memory warning', () => {
  const result = selectAutoModel([
    model('vision-risk:32b', {
      capabilities: { tools: true, vision: true },
      fit: { level: 'risk', label: 'MEMORY RISK' },
    }),
  ], { mode: 'code', needsVision: true });

  assert.equal(result.model, 'vision-risk:32b');
  assert.match(result.warning, /only compatible choice/);
});
