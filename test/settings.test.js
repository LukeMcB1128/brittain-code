const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  DEFAULT_SETTINGS,
  normalizeEndpoint,
  normalizeSettings,
  loadSettings,
  saveSettings,
  settingsPath,
} = require('../settings');

test('accepts Ollama-compatible endpoints on alternate ports', () => {
  assert.equal(normalizeEndpoint('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(normalizeEndpoint('http://localhost:8081/'), 'http://localhost:8081');
  assert.equal(normalizeEndpoint('https://models.example.test:8443'), 'https://models.example.test:8443');
});

test('accepts the base URLs cloud providers document', () => {
  // Refusing paths made every OpenAI-compatible endpoint impossible to enter:
  // they are documented with one, and the client appends only the method path.
  assert.equal(normalizeEndpoint('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/v1');
  assert.equal(normalizeEndpoint('https://api.z.ai/api/paas/v4/'), 'https://api.z.ai/api/paas/v4');
});

test('rejects credentials, query strings, and unsupported protocols', () => {
  // Still refused: anything that is not addressing. A key in a URL is either a
  // mistake or a credential about to be stored in the wrong place.
  assert.throws(() => normalizeEndpoint('http://user:secret@localhost:11434'), /credentials/);
  assert.throws(() => normalizeEndpoint('https://api.example.test/v1?key=sk-abc'), /query string or fragment/);
  assert.throws(() => normalizeEndpoint('https://api.example.test/v1#frag'), /query string or fragment/);
  assert.throws(() => normalizeEndpoint('ftp://localhost:11434'), /http:\/\/ or https:\/\//);
});

test('normalizes settings into safe runtime bounds', () => {
  const settings = normalizeSettings({
    mainContextCap: 999_999,
    compactThreshold: 0.2,
    codeTemperature: 9,
    chatTemperature: -2,
    maxAgentSteps: 999,
    defaultLoopIterations: 0,
    keepAlive: 'forever',
  });
  assert.equal(settings.mainContextCap, 262_144);
  assert.equal(settings.compactThreshold, 0.5);
  assert.equal(settings.codeTemperature, 1.5);
  assert.equal(settings.chatTemperature, 0);
  assert.equal(settings.maxAgentSteps, 100);
  assert.equal(settings.defaultLoopIterations, 1);
  assert.equal(settings.keepAlive, DEFAULT_SETTINGS.keepAlive);
});

test('saves and reloads the complete settings document', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-settings-'));
  try {
    const saved = saveSettings(dir, {
      ...DEFAULT_SETTINGS,
      inferenceEndpoint: 'http://127.0.0.1:9001',
      mainContextCap: 65_536,
      chatModel: 'small-chat:latest',
      globalChatInstructions: 'Prefer short answers.',
    });
    assert.equal(fs.existsSync(settingsPath(dir) + '.tmp'), false);
    assert.deepEqual(loadSettings(dir), saved);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
