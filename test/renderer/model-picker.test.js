const test = require('node:test');
const assert = require('node:assert/strict');
const { filterModels, groupModels, formatContext, formatPrice } = require('../../renderer/features/model-picker');

const models = [
  { id: 'openai/gpt-5', name: 'GPT-5', group: 'openai', contextLength: 200_000, modalities: ['text', 'image'] },
  { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', group: 'anthropic', modalities: ['text'] },
  { id: 'qwen/qwen3-coder', name: 'Qwen3 Coder', group: 'qwen', modalities: ['text'] },
];

test('model search matches several words across provider, name, and capability', () => {
  assert.deepEqual(filterModels(models, 'openai image').map((model) => model.id), ['openai/gpt-5']);
  assert.deepEqual(filterModels(models, '200k').map((model) => model.id), ['openai/gpt-5']);
  assert.deepEqual(filterModels(models, 'qwen coder').map((model) => model.id), ['qwen/qwen3-coder']);
});

test('model rows group by provider and format useful metadata', () => {
  assert.deepEqual(groupModels(models).map(([group]) => group), ['anthropic', 'openai', 'qwen']);
  assert.equal(formatContext(200_000), '200K ctx');
  assert.equal(formatPrice(3, 15), '$3.00 in · $15.00 out / 1M');
  assert.equal(formatPrice(null, null), '');
});
