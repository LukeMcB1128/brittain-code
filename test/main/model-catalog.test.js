const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOpenAIModels, normalizeOllamaModels } = require('../../src/main/model-catalog');

test('OpenAI-compatible model metadata is kept for a large model picker', () => {
  const models = normalizeOpenAIModels({ data: [{
    id: 'anthropic/claude-sonnet-4',
    name: 'Claude Sonnet 4',
    context_length: 200_000,
    pricing: { prompt: '0.000003', completion: '0.000015' },
    architecture: { input_modalities: ['text', 'image'] },
  }] });

  assert.deepEqual(models[0], {
    id: 'anthropic/claude-sonnet-4',
    name: 'Claude Sonnet 4',
    group: 'anthropic',
    contextLength: 200_000,
    inputPricePerMillion: 3,
    outputPricePerMillion: 15,
    modalities: ['text', 'image'],
  });
});

test('official OpenAI models do not appear under an internal system group', () => {
  const models = normalizeOpenAIModels({ data: [{ id: 'gpt-5', owned_by: 'system' }] });
  assert.equal(models[0].group, 'OpenAI');
});

test('Ollama model details include size and build information', () => {
  const models = normalizeOllamaModels([{
    name: 'qwen3:8b',
    size: 5_000_000_000,
    details: { parameter_size: '8.2B', quantization_level: 'Q4_K_M' },
  }]);

  assert.equal(models[0].id, 'qwen3:8b');
  assert.equal(models[0].group, 'Local');
  assert.equal(models[0].parameterSize, '8.2B');
  assert.equal(models[0].quantization, 'Q4_K_M');
});
