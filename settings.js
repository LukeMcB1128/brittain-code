const fs = require('fs');
const path = require('path');

const DEFAULT_SETTINGS = Object.freeze({
  inferenceEndpoint: 'http://127.0.0.1:11434',
  mainContextCap: 0,
  coderContextCap: 32_768,
  scoutContextCap: 24_576,
  autoCompact: true,
  compactThreshold: 0.7,
  keepAlive: '5m',
  codeTemperature: 0.3,
  chatTemperature: 0.6,
  defaultMode: 'last',
  // Which protocol the endpoint speaks. 'ollama' is the local default;
  // 'openai' covers every OpenAI-compatible provider — OpenRouter, Z.AI, Groq,
  // DeepSeek — with the base URL going in inferenceEndpoint as documented.
  //
  // Chosen rather than sniffed: this decides whether a conversation leaves the
  // machine, which is not a question to answer by guessing at a URL.
  provider: 'ollama',
  // Per-million-token rates for cost reporting. Zero means free, which is the
  // truth for a local model.
  inputPerMillion: 0,
  outputPerMillion: 0,
  codeModel: '',
  chatModel: '',
  // The model last run from the UI. Not a preference anyone edits — it exists
  // so callers with no window (the daemon, a trigger, the Discord bridge) can
  // inherit whatever is selected in the app instead of failing with "select a
  // model first" while a model is plainly selected.
  lastModel: '',
  coderModel: '',
  scoutModel: '',
  codeThink: false,
  chatThink: false,
  sidebarOpen: true,
  autoApprove: false,
  // Which named autonomy policy a run uses. Empty means "derive it from
  // autoApprove", which is how an existing install keeps its behaviour on
  // upgrade: checked lands on trusted, unchecked on supervised.
  autonomyPolicy: '',
  autoBranch: false,
  reviewMode: false,
  mcpAutoApprove: false,
  globalCodeInstructions: '',
  globalChatInstructions: '',
  maxAgentSteps: 50,
  defaultLoopIterations: 8,
});

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function clampInteger(value, fallback, min, max) {
  return Math.round(clampNumber(value, fallback, min, max));
}

function cleanText(value, maxLength) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, maxLength);
}

// A base URL, which for a cloud provider includes a path.
//
// This originally allowed only an origin, because Ollama's endpoint is a host
// and a port and the client appends /api/chat itself. Every OpenAI-compatible
// provider documents a base that carries a path — https://openrouter.ai/api/v1,
// https://api.z.ai/api/paas/v4 — so refusing paths made those endpoints
// impossible to enter at all.
//
// What stays refused is anything that is not addressing: credentials, a query
// string, a fragment. Those are either a mistake or a key about to be stored in
// the wrong place.
function normalizeEndpoint(value) {
  const raw = String(value || DEFAULT_SETTINGS.inferenceEndpoint).trim();
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Inference endpoint must be a valid http:// or https:// URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Inference endpoint must use http:// or https://.');
  if (parsed.username || parsed.password) throw new Error('Put no credentials in the inference endpoint URL.');
  if (!parsed.hostname) throw new Error('Inference endpoint needs a hostname.');
  if (parsed.search || parsed.hash) {
    throw new Error('Inference endpoint takes a base URL only — no query string or fragment.');
  }
  // A trailing slash is dropped so the transports can append their own path
  // without producing a doubled separator.
  const path = parsed.pathname.replace(/\/+$/, '');
  return parsed.origin + path;
}

function normalizeContextCap(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return number === 0 ? 0 : fallback;
  return clampInteger(number, fallback, 2_048, 1_048_576);
}

function normalizeSettings(input = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...(input && typeof input === 'object' ? input : {}) };
  return {
    inferenceEndpoint: normalizeEndpoint(merged.inferenceEndpoint),
    mainContextCap: normalizeContextCap(merged.mainContextCap, DEFAULT_SETTINGS.mainContextCap),
    coderContextCap: normalizeContextCap(merged.coderContextCap, DEFAULT_SETTINGS.coderContextCap),
    scoutContextCap: normalizeContextCap(merged.scoutContextCap, DEFAULT_SETTINGS.scoutContextCap),
    autoCompact: !!merged.autoCompact,
    compactThreshold: clampNumber(merged.compactThreshold, DEFAULT_SETTINGS.compactThreshold, 0.5, 0.9),
    keepAlive: ['0', '5m', '30m', '-1'].includes(String(merged.keepAlive)) ? String(merged.keepAlive) : DEFAULT_SETTINGS.keepAlive,
    codeTemperature: clampNumber(merged.codeTemperature, DEFAULT_SETTINGS.codeTemperature, 0, 1.5),
    chatTemperature: clampNumber(merged.chatTemperature, DEFAULT_SETTINGS.chatTemperature, 0, 1.5),
    defaultMode: ['last', 'code', 'chat'].includes(merged.defaultMode) ? merged.defaultMode : DEFAULT_SETTINGS.defaultMode,
    provider: merged.provider === 'openai' ? 'openai' : 'ollama',
    inputPerMillion: Math.max(0, Number(merged.inputPerMillion) || 0),
    outputPerMillion: Math.max(0, Number(merged.outputPerMillion) || 0),
    codeModel: cleanText(merged.codeModel, 200),
    lastModel: cleanText(merged.lastModel, 200),
    chatModel: cleanText(merged.chatModel, 200),
    coderModel: cleanText(merged.coderModel, 200),
    scoutModel: cleanText(merged.scoutModel, 200),
    codeThink: !!merged.codeThink,
    chatThink: !!merged.chatThink,
    sidebarOpen: !!merged.sidebarOpen,
    autoApprove: !!merged.autoApprove,
    autonomyPolicy: cleanText(merged.autonomyPolicy, 80),
    autoBranch: !!merged.autoBranch,
    reviewMode: !!merged.reviewMode,
    mcpAutoApprove: !!merged.mcpAutoApprove,
    globalCodeInstructions: cleanText(merged.globalCodeInstructions, 12_000),
    globalChatInstructions: cleanText(merged.globalChatInstructions, 12_000),
    maxAgentSteps: clampInteger(merged.maxAgentSteps, DEFAULT_SETTINGS.maxAgentSteps, 5, 100),
    defaultLoopIterations: clampInteger(merged.defaultLoopIterations, DEFAULT_SETTINGS.defaultLoopIterations, 1, 50),
  };
}

function settingsPath(userDataDir) {
  return path.join(userDataDir, 'settings.json');
}

function loadSettings(userDataDir) {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(settingsPath(userDataDir), 'utf8')));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(userDataDir, value) {
  const normalized = normalizeSettings(value);
  fs.mkdirSync(userDataDir, { recursive: true });
  const target = settingsPath(userDataDir);
  const temp = target + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(normalized, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, target);
  return normalized;
}

module.exports = {
  DEFAULT_SETTINGS,
  normalizeEndpoint,
  normalizeSettings,
  loadSettings,
  saveSettings,
  settingsPath,
};
