const test = require('node:test');
const assert = require('node:assert/strict');

const { createDiscordSender } = require('../../src/bridge/discord-client');

const response = (status, body = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

test('messages to one Discord channel are delivered in call order', async () => {
  const calls = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const send = createDiscordSender({
    token: 'token',
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body).content);
      if (calls.length === 1) await firstGate;
      return response(200);
    },
  });

  const first = send('channel', 'first');
  const second = send('channel', 'second');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['first'], 'the second send must wait for the first');
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  assert.deepEqual(calls, ['first', 'second']);
});

test('a rate-limited Discord part is retried instead of skipped', async () => {
  const calls = [];
  const waits = [];
  const replies = [response(429, { retry_after: 0.25 }), response(200)];
  const send = createDiscordSender({
    token: 'token',
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body).content);
      return replies.shift();
    },
    sleep: async (ms) => waits.push(ms),
  });

  assert.equal(await send('channel', 'keep this text'), true);
  assert.deepEqual(calls, ['keep this text', 'keep this text']);
  assert.deepEqual(waits, [250]);
});

test('a failed Discord request is reported as undelivered', async () => {
  const errors = [];
  const send = createDiscordSender({
    token: 'token',
    fetchImpl: async () => response(500, { error: 'down' }),
    log: { error: (...parts) => errors.push(parts.join(' ')) },
  });

  assert.equal(await send('channel', 'answer'), false);
  assert.equal(errors.length, 1);
});
