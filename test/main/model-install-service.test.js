'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const {
  createModelInstallService,
  progressFromChunk,
  validOllamaModelName,
} = require('../../src/main/model-install-service');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

test('Ollama installer validates model names and parses pull progress', () => {
  assert.equal(validOllamaModelName('qwen3.6:27b'), true);
  assert.equal(validOllamaModelName('--help'), false);
  assert.equal(validOllamaModelName('model; touch bad'), false);
  assert.deepEqual(progressFromChunk('\u001b[2Kpulling layer: 42%\r'), {
    status: 'pulling layer: 42%',
    percent: 42,
  });
});

test('Ollama installer uses argument-array execution and reports completion', async () => {
  const child = fakeChild();
  let invocation = null;
  const progress = [];
  const service = createModelInstallService({
    spawnImpl: (...args) => { invocation = args; return child; },
    getEndpoint: () => 'http://127.0.0.1:11434/api',
    isLocalEndpoint: () => true,
  });

  const installing = service.install('gpt-oss:20b', (entry) => progress.push(entry));
  child.stderr.write('pulling manifest\r');
  child.stderr.write('pulling layer: 75%\r');
  child.emit('close', 0, null);
  const result = await installing;

  assert.equal(result.ok, true);
  assert.deepEqual(invocation[0], 'ollama');
  assert.deepEqual(invocation[1], ['pull', 'gpt-oss:20b']);
  assert.equal(invocation[2].env.OLLAMA_HOST, 'http://127.0.0.1:11434');
  assert.equal(progress.some((entry) => entry.percent === 75), true);
  assert.equal(progress.at(-1).percent, 100);
});

test('Ollama installer rejects remote inference endpoints', async () => {
  const service = createModelInstallService({
    spawnImpl: () => { throw new Error('must not run'); },
    getEndpoint: () => 'https://models.example.com',
    isLocalEndpoint: () => false,
  });
  assert.deepEqual(await service.install('qwen3:8b'), {
    ok: false,
    error: 'Install is available only for a local Ollama endpoint.',
  });
});
