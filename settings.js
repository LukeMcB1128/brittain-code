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
  codeModel: '',
  chatModel: '',
  coderModel: '',
  scoutModel: '',
  codeThink: false,
  chatThink: false,
  sidebarOpen: true,
  autoApprove: false,
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

function normalizeEndpoint(value) {
  const raw = String(value || DEFAULT_SETTINGS.inferenceEndpoint).trim();
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Inference endpoint must be a valid http:// or https:// URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Inference endpoint must use http:// or https://.');
  if (parsed.username || parsed.password) throw new Error('Put no credentials in the inference endpoint URL.');
  if (!parsed.hostname) throw new Error('Inference endpoint needs a hostname.');
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Inference endpoint must contain only protocol, host, and optional port.');
  }
  return parsed.origin;
}

function normalizeContextCap(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number === 0) return number === 0 ? 0 : fallback;
  return clampInteger(number, fallback, 2_048, 262_144);
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
    codeModel: cleanText(merged.codeModel, 200),
    chatModel: cleanText(merged.chatModel, 200),
    coderModel: cleanText(merged.coderModel, 200),
    scoutModel: cleanText(merged.scoutModel, 200),
    codeThink: !!merged.codeThink,
    chatThink: !!merged.chatThink,
    sidebarOpen: !!merged.sidebarOpen,
    autoApprove: !!merged.autoApprove,
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
