const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GIB,
  buildRecommendations,
  estimateKvCacheBytes,
  fitForMemory,
  isLocalEndpoint,
  summarizeBenchmarks,
} = require('../recommendations');

test('local endpoint detection accepts loopback hosts only', () => {
  assert.equal(isLocalEndpoint('http://localhost:11434'), true);
  assert.equal(isLocalEndpoint('http://127.0.0.2:11434'), true);
  assert.equal(isLocalEndpoint('http://[::1]:11434'), true);
  assert.equal(isLocalEndpoint('http://192.168.1.10:11434'), false);
  assert.equal(isLocalEndpoint('not a URL'), false);
});

test('KV cache estimate uses exported model dimensions', () => {
  const show = {
    model_info: {
      'test.block_count': 32,
      'test.attention.head_count': 32,
      'test.attention.head_count_kv': 8,
      'test.embedding_length': 4096,
    },
  };
  const expected = 8192 * 32 * 8 * (128 + 128) * 2;
  assert.equal(estimateKvCacheBytes(show, 8192, 5 * GIB), expected);
});

test('Brittainmark summary uses v3 solo task medians', () => {
  const summary = summarizeBenchmarks([
    { scoreModel: 'brittainmark-v3', mode: 'solo', model: 'ollama:qwen:8b', task: 'cart', total: 70 },
    { scoreModel: 'brittainmark-v3', mode: 'solo', model: 'qwen:8b', task: 'cart', total: 90 },
    { scoreModel: 'brittainmark-v3', mode: 'solo', model: 'qwen:8b', task: 'debug', total: 80 },
    { scoreModel: 'brittainmark-v3', mode: 'solo', model: 'qwen:8b', task: 'cart', taskVersion: 0, total: 10 },
    { scoreModel: 'brittainmark-v2', mode: 'solo', model: 'qwen:8b', task: 'debug', total: 100 },
    { scoreModel: 'brittainmark-v3', mode: 'team', model: 'qwen:8b', task: 'debug', total: 100 },
  ]).get('qwen:8b');

  assert.deepEqual(summary, { score: 80, tasks: 2, runs: 3, version: 3 });
});

test('unified-memory fit does not add dedicated VRAM', () => {
  const hardware = {
    appliesToEndpoint: true,
    unifiedMemory: true,
    totalMemoryBytes: 16 * GIB,
    totalVramBytes: 16 * GIB,
  };
  assert.equal(fitForMemory(10 * GIB, hardware, false).level, 'good');
  assert.equal(fitForMemory(12 * GIB, hardware, false).level, 'caution');
  assert.equal(fitForMemory(15 * GIB, hardware, false).level, 'risk');
});

test('recommendations merge Ollama data, measured data, and benchmarks', () => {
  const tags = [
    { name: 'vision:8b', size: 5 * GIB, digest: 'one', details: { parameter_size: '8B', quantization_level: 'Q4_K_M' } },
    { name: 'plain:12b', size: 7 * GIB, digest: 'two', details: { parameter_size: '12B', quantization_level: 'Q4_K_M' } },
  ];
  const shows = {
    'vision:8b': {
      capabilities: ['completion', 'tools', 'vision', 'thinking'],
      model_info: { 'test.context_length': 32768 },
    },
    'plain:12b': {
      capabilities: ['completion'],
      model_info: { 'test.context_length': 16384 },
    },
  };
  const result = buildRecommendations({
    tags,
    shows,
    running: [{ name: 'vision:8b', size: 7 * GIB, size_vram: 6 * GIB, context_length: 8192 }],
    hardware: { appliesToEndpoint: true, unifiedMemory: false, totalMemoryBytes: 32 * GIB, totalVramBytes: 12 * GIB },
    benchmarkEntries: [
      { scoreModel: 'brittainmark-v3', mode: 'solo', model: 'vision:8b', task: 'cart', total: 88 },
    ],
    speedSamples: { 'vision:8b': [{ tokensPerSecond: 30, contextTokens: 8192 }, { tokensPerSecond: 40, contextTokens: 8192 }] },
    presets: { models: [{ name: 'vision:8b', marker: 'TEST', priority: 10 }] },
    requestedContext: 8192,
    mode: 'code',
  });

  assert.equal(result[0].name, 'vision:8b');
  assert.equal(result[0].recommended, true);
  assert.deepEqual(result[0].capabilities, { tools: true, vision: true, thinking: true });
  assert.deepEqual(result[0].memory, { bytes: 6 * GIB, source: 'measured', contextTokens: 8192, unified: false });
  assert.equal(result[0].fit.level, 'loaded');
  assert.equal(result[0].speed.tokensPerSecond, 35);
  assert.equal(result[0].brittainmark.score, 88);
  assert.equal(result[0].profile.marker, 'TEST');
  assert.equal(result[1].capabilities.tools, false);
  assert.equal(result[1].contextTokens, 8192);
});

test('remote endpoints do not use client memory for fit claims', () => {
  const [model] = buildRecommendations({
    tags: [{ name: 'remote-test:7b', size: 4 * GIB }],
    hardware: { appliesToEndpoint: false, unifiedMemory: false, totalMemoryBytes: 64 * GIB, totalVramBytes: 24 * GIB },
    requestedContext: 8192,
  });
  assert.deepEqual(model.fit, { level: 'unknown', label: 'SERVER UNKNOWN' });
  assert.equal(model.capabilities.tools, null);
});
