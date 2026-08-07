const fs = require('fs');
const path = require('path');
const { buildRecommendations } = require('../../recommendations');
const modelPresets = require('../../model-presets.json');

function compactRecommendationShow(show) {
  return {
    details: show?.details || {},
    capabilities: show?.capabilities || [],
    model_info: Object.fromEntries(Object.entries(show?.model_info || {})
      .filter(([key]) => !key.startsWith('tokenizer.'))),
    tensors: show?.tensors || [],
  };
}

function needsVerboseRecommendationShow(show) {
  const info = show?.model_info || {};
  const hasSlidingWindow = Object.entries(info)
    .some(([key, value]) => key.endsWith('.attention.sliding_window') && Number(value) > 0);
  const missingPattern = Object.entries(info)
    .some(([key, value]) => key.endsWith('.attention.sliding_window_pattern') && value === null);
  const hasSlidingKeyLength = Object.keys(info)
    .some((key) => key.endsWith('.attention.key_length_swa'));
  return hasSlidingWindow && missingPattern && !hasSlidingKeyLength;
}

function sameRecommendationHardware(recorded, current) {
  if (!recorded || !current) return false;
  if (recorded.platform && recorded.platform !== current.platform) return false;
  if (recorded.arch && recorded.arch !== current.arch) return false;
  const recordedMemory = Number(recorded.totalMemoryBytes) || 0;
  const currentMemory = Number(current.totalMemoryBytes) || 0;
  return !recordedMemory || !currentMemory
    || Math.abs(recordedMemory - currentMemory) / currentMemory < 0.1;
}

function readHistoricalModelSpeedSamples({
  hardware,
  userChatsDirectory,
  benchmarkRunsDirectory,
  appDefaultContext,
  benchmarkDefaultContext = 32768,
}) {
  const directories = [{ path: userChatsDirectory, defaultContext: appDefaultContext }];
  try {
    for (const entry of fs.readdirSync(benchmarkRunsDirectory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        directories.push({
          path: path.join(benchmarkRunsDirectory, entry.name, 'chats'),
          defaultContext: benchmarkDefaultContext,
        });
      }
    }
  } catch {}

  const samples = {};
  for (const directory of directories) {
    let files = [];
    try { files = fs.readdirSync(directory.path).filter((name) => name.endsWith('.json')); }
    catch { continue; }
    for (const file of files) {
      try {
        const chat = JSON.parse(fs.readFileSync(path.join(directory.path, file), 'utf8'));
        if (!sameRecommendationHardware(chat.runtime?.hardware, hardware)) continue;
        const usage = chat.runMetrics?.main;
        const generated = Number(usage?.gen) || 0;
        const generationMs = Number(usage?.generationMs) || 0;
        if (generated < 8 || generationMs <= 0) continue;
        const name = String(chat.model || chat.runtime?.model?.name || '')
          .replace(/^ollama:/i, '').trim().toLowerCase();
        if (!name) continue;
        const configuredContext = Number(chat.runtime?.settings?.requestedContextCap)
          || directory.defaultContext;
        const nativeContext = Number(chat.runtime?.model?.nativeContext) || configuredContext;
        if (!samples[name]) samples[name] = [];
        samples[name].push({
          tokensPerSecond: generated / (generationMs / 1000),
          contextTokens: Math.min(configuredContext, nativeContext),
          recordedAt: chat.timestamp || null,
          digest: chat.runtime?.model?.digest || null,
        });
      } catch {}
    }
  }
  return samples;
}

function createRecommendationsService({
  ollamaJson,
  hardwareProfile,
  getRuntimeSettings,
  getEndpoint,
  isLocalEndpoint,
  getHistoryDirectory,
  benchmarkDirectory,
  readBenchResults,
  modelSpeedSamples,
  defaultContext,
  getKvCacheType = () => process.env.OLLAMA_KV_CACHE_TYPE || 'f16',
}) {
  return async function getRecommendations({ mode = 'code' } = {}) {
    try {
      const [tagsResponse, runningResponse, hardware] = await Promise.all([
        ollamaJson('/api/tags'),
        ollamaJson('/api/ps').catch(() => ({ models: [] })),
        hardwareProfile(),
      ]);
      const tags = tagsResponse.models || [];
      const showEntries = await Promise.all(tags.map(async (tag) => {
        const name = tag.name || tag.model;
        try {
          let show = await ollamaJson('/api/show', { model: name });
          if (needsVerboseRecommendationShow(show)) {
            show = await ollamaJson('/api/show', { model: name, verbose: true });
          }
          return [name, compactRecommendationShow(show)];
        } catch {
          return [name, {}];
        }
      }));
      const settings = getRuntimeSettings();
      const requestedContext = settings.mainContextCap > 0
        ? settings.mainContextCap
        : defaultContext;
      const kvCacheType = isLocalEndpoint(getEndpoint()) ? getKvCacheType() : 'f16';
      const speedSamples = readHistoricalModelSpeedSamples({
        hardware,
        userChatsDirectory: getHistoryDirectory(),
        benchmarkRunsDirectory: path.join(benchmarkDirectory, 'runs'),
        appDefaultContext: defaultContext,
      });
      for (const [name, samples] of modelSpeedSamples) {
        const normalized = String(name).replace(/^ollama:/i, '').trim().toLowerCase();
        speedSamples[normalized] = [...(speedSamples[normalized] || []), ...samples].slice(-24);
      }
      const models = buildRecommendations({
        tags,
        shows: Object.fromEntries(showEntries),
        running: runningResponse.models || [],
        hardware,
        benchmarkEntries: readBenchResults(),
        speedSamples,
        presets: modelPresets,
        requestedContext,
        mode: mode === 'chat' ? 'chat' : 'code',
        kvCacheType,
      });
      return {
        ok: true,
        models,
        hardware,
        requestedContext,
        kvCacheType,
        benchmarkAvailable: models.some((model) => !!model.brittainmark),
      };
    } catch (err) {
      return { ok: false, error: `Could not build model recommendations: ${err.message || err}` };
    }
  };
}

module.exports = {
  compactRecommendationShow,
  createRecommendationsService,
  needsVerboseRecommendationShow,
  readHistoricalModelSpeedSamples,
  sameRecommendationHardware,
};
