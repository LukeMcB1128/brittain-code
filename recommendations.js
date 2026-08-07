const GIB = 1024 ** 3;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizedModelName(value) {
  return String(value || '').replace(/^ollama:/i, '').trim().toLowerCase();
}

function isLocalEndpoint(endpoint) {
  try {
    const hostname = new URL(endpoint).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || hostname.startsWith('127.');
  } catch {
    return false;
  }
}

function valueBySuffix(modelInfo, suffix) {
  const key = Object.keys(modelInfo || {}).find((name) => name.endsWith(suffix));
  return key ? finiteNumber(modelInfo[key], 0) : 0;
}

function rawValueBySuffix(modelInfo, suffix) {
  const key = Object.keys(modelInfo || {}).find((name) => name.endsWith(suffix));
  return key ? modelInfo[key] : null;
}

function nativeContextLength(show) {
  return valueBySuffix(show?.model_info, '.context_length') || null;
}

function kvCacheBytesPerElement(value) {
  const type = String(value || 'f16').trim().toLowerCase();
  if (type === 'q8_0') return 34 / 32;
  if (type === 'q4_0') return 18 / 32;
  return 2;
}

function tensorProjectionWidth(tensor, embedding) {
  const dimensions = (tensor?.shape || []).map((value) => finiteNumber(value, 0)).filter((value) => value > 0);
  if (!dimensions.length) return 0;
  const projected = dimensions.filter((value) => value !== embedding);
  return projected.length ? Math.min(...projected) : Math.min(...dimensions);
}

function estimateTensorKvCacheBytes(show, contextTokens, bytesPerElement) {
  if (!Array.isArray(show?.tensors)) return 0;
  const info = show.model_info || {};
  const embedding = valueBySuffix(info, '.embedding_length');
  const slidingWindow = valueBySuffix(info, '.attention.sliding_window');
  const slidingPattern = rawValueBySuffix(info, '.attention.sliding_window_pattern');
  const slidingKeyLength = valueBySuffix(info, '.attention.key_length_swa');
  const tensorsByName = new Map(show.tensors.map((tensor) => [tensor.name, tensor]));
  let bytes = 0;
  let attentionLayers = 0;

  for (const keyTensor of show.tensors) {
    const match = String(keyTensor?.name || '').match(/^blk\.(\d+)\.attn_k\.weight$/);
    if (!match) continue;
    const layer = Number(match[1]);
    const keyWidth = tensorProjectionWidth(keyTensor, embedding);
    if (!keyWidth) continue;
    const valueTensor = tensorsByName.get(`blk.${layer}.attn_v.weight`);
    const valueWidth = tensorProjectionWidth(valueTensor, embedding) || keyWidth;

    let usesSlidingWindow = Array.isArray(slidingPattern) ? slidingPattern[layer] === true : false;
    if (!Array.isArray(slidingPattern) && slidingKeyLength) {
      const norm = tensorsByName.get(`blk.${layer}.attn_k_norm.weight`);
      usesSlidingWindow = (norm?.shape || []).some((value) => finiteNumber(value, 0) === slidingKeyLength);
    }
    const layerContext = usesSlidingWindow && slidingWindow
      ? Math.min(contextTokens, slidingWindow)
      : contextTokens;
    bytes += layerContext * (keyWidth + valueWidth) * bytesPerElement;
    attentionLayers += 1;
  }

  return attentionLayers ? Math.ceil(bytes) : 0;
}

// Ollama uses an f16 KV cache unless the host has a different setting. The
// exact formula is useful when the model exports its attention dimensions.
// The fallback is intentionally conservative and remains marked as estimated.
function estimateKvCacheBytes(show, contextTokens, weightBytes, bytesPerElement = 2) {
  const info = show?.model_info || {};
  const layers = valueBySuffix(info, '.block_count');
  const heads = valueBySuffix(info, '.attention.head_count');
  const embedding = valueBySuffix(info, '.embedding_length');
  const keyLength = valueBySuffix(info, '.attention.key_length') || (heads && embedding ? embedding / heads : 0);
  const valueLength = valueBySuffix(info, '.attention.value_length') || keyLength;
  const mlaKeyLength = valueBySuffix(info, '.attention.key_length_mla');
  const mlaValueLength = valueBySuffix(info, '.attention.value_length_mla');
  const kvHeadValue = rawValueBySuffix(info, '.attention.head_count_kv');
  const elementBytes = finiteNumber(bytesPerElement, 2) || 2;
  let kvHeadsAcrossLayers = 0;

  // Multi-head latent attention caches the compressed latent dimensions. It
  // does not cache a full key and value vector for every query head.
  if (layers && mlaKeyLength) {
    return Math.ceil(contextTokens * layers * (mlaKeyLength + (mlaValueLength || mlaKeyLength)) * elementBytes);
  }

  // Tensor shapes are the most reliable source for hybrid and mixed-attention
  // GGUF files. A separate attn_k tensor exists only on layers with a KV
  // cache, and its projected width is the number of cached key values.
  const tensorEstimate = estimateTensorKvCacheBytes(show, contextTokens, elementBytes);
  if (tensorEstimate) return tensorEstimate;

  // GGUF can store KV-head counts per layer. Hybrid models use zero for
  // recurrent layers and a positive count for full-attention layers. Do not
  // coerce this array to Number: that discards the layer layout and can make
  // the estimate many times too large.
  if (Array.isArray(kvHeadValue)) {
    const layerValues = layers ? kvHeadValue.slice(0, layers) : kvHeadValue;
    const slidingWindow = valueBySuffix(info, '.attention.sliding_window');
    const slidingPattern = rawValueBySuffix(info, '.attention.sliding_window_pattern');
    if (Array.isArray(slidingPattern) && slidingWindow) {
      return Math.ceil(layerValues.reduce((sum, value, layer) => {
        const layerContext = slidingPattern[layer] === true ? Math.min(contextTokens, slidingWindow) : contextTokens;
        return sum + layerContext * Math.max(0, finiteNumber(value, 0)) * (keyLength + valueLength) * elementBytes;
      }, 0));
    }
    kvHeadsAcrossLayers = layerValues.reduce((sum, value) => sum + Math.max(0, finiteNumber(value, 0)), 0);
  } else {
    const kvHeads = finiteNumber(kvHeadValue, 0) || heads;
    let attentionLayers = layers;
    const fullAttentionInterval = valueBySuffix(info, '.full_attention_interval');
    if (fullAttentionInterval > 1) attentionLayers = Math.floor(layers / fullAttentionInterval);
    kvHeadsAcrossLayers = attentionLayers * kvHeads;
  }

  if (kvHeadsAcrossLayers && keyLength && valueLength) {
    return Math.ceil(contextTokens * kvHeadsAcrossLayers * (keyLength + valueLength) * elementBytes);
  }

  if (!weightBytes) return 0;
  return Math.ceil(weightBytes * 0.08 * Math.max(1, contextTokens / 8192) * (elementBytes / 2));
}

function estimateModelMemory(tag, show, contextTokens, bytesPerElement = 2) {
  const weightBytes = finiteNumber(tag?.size, 0);
  if (!weightBytes) return null;
  const kvBytes = estimateKvCacheBytes(show, contextTokens, weightBytes, bytesPerElement);
  const runtimeBytes = Math.max(384 * 1024 ** 2, weightBytes * 0.08);
  return {
    bytes: Math.ceil(weightBytes + kvBytes + runtimeBytes),
    weightBytes,
    kvBytes,
    runtimeBytes: Math.ceil(runtimeBytes),
  };
}

function capabilityValue(show, capability) {
  if (!Array.isArray(show?.capabilities) || !show.capabilities.length) return null;
  return show.capabilities.includes(capability);
}

function summarizeBenchmarks(entries) {
  const eligible = (entries || []).filter((entry) =>
    entry?.scoreModel === 'brittainmark-v3' && entry.mode === 'solo' && entry.task && typeof entry.total === 'number' && entry.model);
  const latestTaskVersions = new Map();
  for (const entry of eligible) {
    const version = finiteNumber(entry.taskVersion, 1);
    latestTaskVersions.set(entry.task, Math.max(latestTaskVersions.get(entry.task) || 0, version));
  }

  const taskGroups = new Map();
  for (const entry of eligible) {
    if (finiteNumber(entry.taskVersion, 1) !== latestTaskVersions.get(entry.task)) continue;
    const model = normalizedModelName(entry.model);
    const key = `${model}\u0000${entry.task}`;
    if (!taskGroups.has(key)) taskGroups.set(key, { model, task: entry.task, scores: [] });
    taskGroups.get(key).scores.push(entry.total);
  }

  const models = new Map();
  for (const group of taskGroups.values()) {
    if (!models.has(group.model)) models.set(group.model, { taskScores: [], runs: 0 });
    const summary = models.get(group.model);
    summary.taskScores.push(median(group.scores));
    summary.runs += group.scores.length;
  }

  return new Map([...models.entries()].map(([model, summary]) => [model, {
    score: Math.round((summary.taskScores.reduce((sum, score) => sum + score, 0) / summary.taskScores.length) * 10) / 10,
    tasks: summary.taskScores.length,
    runs: summary.runs,
    version: 3,
  }]));
}

function findPreset(name, presets) {
  const normalized = normalizedModelName(name);
  return (presets?.models || []).find((preset) => normalizedModelName(preset.name) === normalized) || null;
}

function latestMeasuredSpeed(samples, contextTokens) {
  const valid = (samples || []).filter((sample) => finiteNumber(sample?.tokensPerSecond, 0) > 0);
  if (!valid.length) return null;
  const sameContext = valid.filter((sample) => sample.contextTokens === contextTokens);
  const selected = sameContext.length ? sameContext : valid;
  const selectedContexts = [...new Set(selected.map((sample) => finiteNumber(sample.contextTokens, 0)).filter((value) => value > 0))];
  return {
    tokensPerSecond: Math.round(median(selected.map((sample) => sample.tokensPerSecond)) * 10) / 10,
    samples: selected.length,
    exactContext: sameContext.length > 0,
    contextTokens: sameContext.length ? contextTokens : selectedContexts.length === 1 ? selectedContexts[0] : null,
    source: 'measured',
  };
}

function fitForMemory(requiredBytes, hardware, actualLoaded) {
  if (!hardware?.appliesToEndpoint) return { level: 'unknown', label: 'SERVER UNKNOWN' };
  if (actualLoaded) return { level: 'loaded', label: 'LOADED' };
  if (!requiredBytes) return { level: 'unknown', label: 'UNKNOWN' };

  if (hardware.unifiedMemory) {
    const total = finiteNumber(hardware.totalMemoryBytes, 0);
    if (!total) return { level: 'unknown', label: 'UNKNOWN' };
    if (requiredBytes <= total * 0.7) return { level: 'good', label: 'UNIFIED FIT' };
    if (requiredBytes <= total * 0.85) return { level: 'caution', label: 'TIGHT FIT' };
    return { level: 'risk', label: 'MEMORY RISK' };
  }

  const vram = finiteNumber(hardware.totalVramBytes, 0);
  if (vram) {
    if (requiredBytes <= vram * 0.85) return { level: 'good', label: 'GPU FIT' };
    const ram = finiteNumber(hardware.totalMemoryBytes, 0);
    if (ram && requiredBytes <= ram * 0.7) return { level: 'caution', label: 'PARTIAL OFFLOAD' };
    return { level: 'risk', label: 'MEMORY RISK' };
  }

  const ram = finiteNumber(hardware.totalMemoryBytes, 0);
  if (!ram) return { level: 'unknown', label: 'UNKNOWN' };
  if (requiredBytes <= ram * 0.65) return { level: 'caution', label: 'CPU FIT' };
  return { level: 'risk', label: 'MEMORY RISK' };
}

function parameterBillions(tag, show) {
  const raw = String(tag?.details?.parameter_size || show?.details?.parameter_size || '').toUpperCase();
  const match = raw.match(/([\d.]+)\s*B/);
  return match ? finiteNumber(match[1], 0) : 0;
}

const FIT_ORDER = { loaded: 1, proven: 1, good: 1, caution: 2, unknown: 3, risk: 4 };

function recommendationSort(mode) {
  return (a, b) => {
    const fitDifference = (FIT_ORDER[a.fit.level] ?? 9) - (FIT_ORDER[b.fit.level] ?? 9);
    if (fitDifference) return fitDifference;
    if (mode === 'code') {
      const toolRank = (value) => value === true ? 0 : value === null ? 1 : 2;
      const toolDifference = toolRank(a.capabilities.tools) - toolRank(b.capabilities.tools);
      if (toolDifference) return toolDifference;
    }
    const benchmarkDifference = (b.brittainmark?.score ?? -1) - (a.brittainmark?.score ?? -1);
    if (benchmarkDifference) return benchmarkDifference;
    const presetDifference = (b.profile?.priority || 0) - (a.profile?.priority || 0);
    if (presetDifference) return presetDifference;
    const parameterDifference = b.parameterBillions - a.parameterBillions;
    if (parameterDifference) return parameterDifference;
    return a.name.localeCompare(b.name);
  };
}

function buildRecommendations({ tags, shows = {}, running = [], hardware, benchmarkEntries = [], speedSamples = {}, presets = {}, requestedContext = 131072, mode = 'code', kvCacheType = 'f16' }) {
  const benchmarkByModel = summarizeBenchmarks(benchmarkEntries);
  const runningByModel = new Map((running || []).map((entry) => [normalizedModelName(entry.name || entry.model), entry]));
  const cacheElementBytes = kvCacheBytesPerElement(kvCacheType);

  const models = (tags || []).map((tag) => {
    const name = tag.name || tag.model;
    const normalized = normalizedModelName(name);
    const show = shows[name] || shows[normalized] || {};
    const loaded = runningByModel.get(normalized) || null;
    const nativeContext = nativeContextLength(show);
    const contextTokens = Math.max(2048, Math.min(finiteNumber(requestedContext, 131072), nativeContext || Infinity));
    const estimate = estimateModelMemory(tag, show, contextTokens, cacheElementBytes);
    const actualMemoryBytes = finiteNumber(loaded?.size_vram, 0) || finiteNumber(loaded?.size, 0) || null;
    const memoryBytes = actualMemoryBytes || estimate?.bytes || null;
    const matchingSpeedSamples = (speedSamples[name] || speedSamples[normalized] || [])
      .filter((sample) => !sample?.digest || !tag.digest || sample.digest === tag.digest);
    const measuredSpeed = latestMeasuredSpeed(matchingSpeedSamples, contextTokens);
    let fit = fitForMemory(memoryBytes, hardware, !!loaded);
    if (fit.level === 'risk' && measuredSpeed?.exactContext && hardware?.appliesToEndpoint) {
      fit = { level: 'proven', label: 'MEASURED FIT' };
    }
    const preset = findPreset(name, presets);

    return {
      name,
      digest: tag.digest || null,
      parameterSize: tag.details?.parameter_size || show.details?.parameter_size || null,
      parameterBillions: parameterBillions(tag, show),
      quantization: tag.details?.quantization_level || show.details?.quantization_level || null,
      nativeContext,
      contextTokens,
      capabilities: {
        tools: capabilityValue(show, 'tools'),
        vision: capabilityValue(show, 'vision'),
        thinking: capabilityValue(show, 'thinking'),
      },
      memory: {
        bytes: memoryBytes,
        source: actualMemoryBytes ? 'measured' : estimate ? 'estimated' : 'unknown',
        contextTokens: actualMemoryBytes ? finiteNumber(loaded?.context_length, contextTokens) : contextTokens,
        unified: !!hardware?.unifiedMemory,
      },
      fit,
      speed: measuredSpeed,
      brittainmark: benchmarkByModel.get(normalized) || null,
      profile: preset ? { marker: preset.marker || null, priority: finiteNumber(preset.priority, 0) } : null,
      recommended: false,
    };
  }).sort(recommendationSort(mode));

  const preferred = models.find((model) => model.fit.level !== 'risk' && (mode !== 'code' || model.capabilities.tools !== false));
  if (preferred) preferred.recommended = true;
  return models;
}

module.exports = {
  GIB,
  buildRecommendations,
  estimateKvCacheBytes,
  estimateModelMemory,
  fitForMemory,
  isLocalEndpoint,
  kvCacheBytesPerElement,
  latestMeasuredSpeed,
  median,
  nativeContextLength,
  normalizedModelName,
  summarizeBenchmarks,
};
