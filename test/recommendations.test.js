const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GIB,
  buildBaselineRecommendations,
  buildRecommendations,
  estimateKvCacheBytes,
  fitForMemory,
  isLocalEndpoint,
  kvCacheBytesPerElement,
  sameHardwareClass,
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

test('KV cache estimate uses hybrid per-layer KV heads', () => {
  const show = {
    model_info: {
      'qwen35.block_count': 64,
      'qwen35.attention.head_count': 24,
      'qwen35.attention.head_count_kv': Array.from({ length: 64 }, (_value, index) => (index + 1) % 4 === 0 ? 4 : 0),
      'qwen35.attention.key_length': 256,
      'qwen35.attention.value_length': 256,
      'qwen35.full_attention_interval': 4,
    },
  };
  const expected = 131072 * 16 * 4 * (256 + 256) * 2;
  assert.equal(estimateKvCacheBytes(show, 131072, 16 * GIB), expected);
});

test('KV cache estimate applies a hybrid attention interval to scalar metadata', () => {
  const show = {
    model_info: {
      'hybrid.block_count': 40,
      'hybrid.attention.head_count': 16,
      'hybrid.attention.head_count_kv': 2,
      'hybrid.attention.key_length': 256,
      'hybrid.attention.value_length': 256,
      'hybrid.full_attention_interval': 4,
    },
  };
  const expected = 32768 * 10 * 2 * (256 + 256) * 2;
  assert.equal(estimateKvCacheBytes(show, 32768, 20 * GIB), expected);
});

test('KV cache estimate derives hybrid KV heads when Ollama returns null', () => {
  const show = {
    model_info: {
      'qwen35.block_count': 64,
      'qwen35.embedding_length': 5120,
      'qwen35.attention.head_count': 24,
      'qwen35.attention.head_count_kv': null,
      'qwen35.attention.key_length': 256,
      'qwen35.attention.value_length': 256,
      'qwen35.full_attention_interval': 4,
    },
    tensors: [
      ...Array.from({ length: 16 }, (_value, index) => ({ name: `blk.${index * 4 + 3}.attn_k.weight`, shape: [5120, 1024] })),
      { name: 'v.blk.3.attn_k.weight', shape: [1152, 1152] },
    ],
  };
  const expected = 131072 * 16 * 4 * (256 + 256) * 2;
  assert.equal(estimateKvCacheBytes(show, 131072, 16 * GIB), expected);
});

test('KV cache estimate uses tensor widths and sliding-window layers', () => {
  const show = {
    model_info: {
      'mixed.embedding_length': 2048,
      'mixed.attention.sliding_window': 1024,
      'mixed.attention.sliding_window_pattern': [true, false],
    },
    tensors: [
      { name: 'blk.0.attn_k.weight', shape: [2048, 512] },
      { name: 'blk.0.attn_v.weight', shape: [2048, 512] },
      { name: 'blk.1.attn_k.weight', shape: [2048, 512] },
      { name: 'blk.1.attn_v.weight', shape: [2048, 512] },
    ],
  };
  const expected = (1024 + 8192) * (512 + 512) * 2;
  assert.equal(estimateKvCacheBytes(show, 8192, 5 * GIB), expected);
});

test('KV cache estimate treats MLA dimensions as compressed values', () => {
  const show = {
    model_info: {
      'mla.block_count': 47,
      'mla.attention.head_count': 20,
      'mla.attention.head_count_kv': 20,
      'mla.attention.key_length': 256,
      'mla.attention.value_length': 256,
      'mla.attention.key_length_mla': 576,
      'mla.attention.value_length_mla': 512,
    },
  };
  const expected = 131072 * 47 * (576 + 512) * 2;
  assert.equal(estimateKvCacheBytes(show, 131072, 18 * GIB), expected);
});

test('KV cache quantization uses the Ollama cache storage size', () => {
  assert.equal(kvCacheBytesPerElement('f16'), 2);
  assert.equal(kvCacheBytesPerElement('q8_0'), 34 / 32);
  assert.equal(kvCacheBytesPerElement('q4_0'), 18 / 32);
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

test('baseline recommendations describe installable models from the recorded hardware', () => {
  const baseline = {
    reference: {
      label: 'Test Mac (32 GB)',
      platform: 'darwin',
      arch: 'arm64',
      totalMemoryBytes: 32 * GIB,
      contextTokens: 32768,
    },
    models: [{
      name: 'reference:8b',
      sizeBytes: 5 * GIB,
      parameterSize: '8B',
      quantization: 'Q4_K_M',
      nativeContext: 131072,
      capabilities: { tools: true, vision: false, thinking: true },
      speed: { tokensPerSecond: 42, samples: 3 },
      brittainmark: { score: 88, tasks: 7, runs: 7, version: 3 },
    }],
  };
  const hardware = {
    appliesToEndpoint: true,
    platform: 'darwin',
    arch: 'arm64',
    unifiedMemory: true,
    totalMemoryBytes: 32 * GIB,
  };
  const [model] = buildBaselineRecommendations({ baseline, hardware, kvCacheType: 'q8_0' });

  assert.equal(model.installed, false);
  assert.equal(model.recommended, true);
  assert.equal(model.fit.label, 'BENCHED FIT');
  assert.equal(model.speed.source, 'reference');
  assert.equal(model.speed.tokensPerSecond, 42);
  assert.equal(model.contextTokens, 32768);
  assert.equal(model.brittainmark.score, 88);
  assert.equal(model.reference.label, 'Test Mac (32 GB)');
  assert.equal(sameHardwareClass(baseline.reference, hardware), true);
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

test('a same-context speed measurement proves that a model ran on the machine', () => {
  const [model] = buildRecommendations({
    tags: [{ name: 'measured:30b', size: 30 * GIB }],
    hardware: { appliesToEndpoint: true, unifiedMemory: true, totalMemoryBytes: 32 * GIB },
    speedSamples: { 'measured:30b': [{ tokensPerSecond: 15, contextTokens: 8192 }] },
    requestedContext: 8192,
  });
  assert.deepEqual(model.fit, { level: 'proven', label: 'MEASURED FIT' });
});

test('a speed measurement from an old model digest does not prove fit', () => {
  const [model] = buildRecommendations({
    tags: [{ name: 'changed:30b', size: 30 * GIB, digest: 'new-digest' }],
    hardware: { appliesToEndpoint: true, unifiedMemory: true, totalMemoryBytes: 32 * GIB },
    speedSamples: { 'changed:30b': [{ tokensPerSecond: 15, contextTokens: 8192, digest: 'old-digest' }] },
    requestedContext: 8192,
  });
  assert.equal(model.speed, null);
  assert.equal(model.fit.level, 'risk');
});
