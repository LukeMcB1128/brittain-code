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

function nativeContextLength(show) {
  return valueBySuffix(show?.model_info, '.context_length') || null;
}

// Ollama uses an f16 KV cache unless the host has a different setting. The
// exact formula is useful when the model exports its attention dimensions.
// The fallback is intentionally conservative and remains marked as estimated.
function estimateKvCacheBytes(show, contextTokens, weightBytes) {
  const info = show?.model_info || {};
  const layers = valueBySuffix(info, '.block_count');
  const kvHeads = valueBySuffix(info, '.attention.head_count_kv') || valueBySuffix(info, '.attention.head_count');
  const heads = valueBySuffix(info, '.attention.head_count');
  const embedding = valueBySuffix(info, '.embedding_length');
  const keyLength = valueBySuffix(info, '.attention.key_length') || (heads && embedding ? embedding / heads : 0);
  const valueLength = valueBySuffix(info, '.attention.value_length') || keyLength;

  if (layers && kvHeads && keyLength && valueLength) {
    return Math.ceil(contextTokens * layers * kvHeads * (keyLength + valueLength) * 2);
  }

  if (!weightBytes) return 0;
  return Math.ceil(weightBytes * 0.08 * Math.max(1, contextTokens / 8192));
}

function estimateModelMemory(tag, show, contextTokens) {
  const weightBytes = finiteNumber(tag?.size, 0);
  if (!weightBytes) return null;
  const kvBytes = estimateKvCacheBytes(show, contextTokens, weightBytes);
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
  return {
    tokensPerSecond: Math.round(median(selected.map((sample) => sample.tokensPerSecond)) * 10) / 10,
    samples: selected.length,
    exactContext: sameContext.length > 0,
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

const FIT_ORDER = { loaded: 1, good: 1, caution: 2, unknown: 3, risk: 4 };

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

function buildRecommendations({ tags, shows = {}, running = [], hardware, benchmarkEntries = [], speedSamples = {}, presets = {}, requestedContext = 131072, mode = 'code' }) {
  const benchmarkByModel = summarizeBenchmarks(benchmarkEntries);
  const runningByModel = new Map((running || []).map((entry) => [normalizedModelName(entry.name || entry.model), entry]));

  const models = (tags || []).map((tag) => {
    const name = tag.name || tag.model;
    const normalized = normalizedModelName(name);
    const show = shows[name] || shows[normalized] || {};
    const loaded = runningByModel.get(normalized) || null;
    const nativeContext = nativeContextLength(show);
    const contextTokens = Math.max(2048, Math.min(finiteNumber(requestedContext, 131072), nativeContext || Infinity));
    const estimate = estimateModelMemory(tag, show, contextTokens);
    const actualMemoryBytes = finiteNumber(loaded?.size_vram, 0) || finiteNumber(loaded?.size, 0) || null;
    const memoryBytes = actualMemoryBytes || estimate?.bytes || null;
    const fit = fitForMemory(memoryBytes, hardware, !!loaded);
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
      speed: latestMeasuredSpeed(speedSamples[name] || speedSamples[normalized], contextTokens),
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
  latestMeasuredSpeed,
  median,
  nativeContextLength,
  normalizedModelName,
  summarizeBenchmarks,
};
