const test = require('node:test');
const assert = require('node:assert/strict');

const { createDiscordBridge } = require('../../src/bridge/discord-client');

class FakeSocket {
  static latest = null;

  constructor() {
    this.listeners = new Map();
    FakeSocket.latest = this;
  }

  addEventListener(name, listener) {
    const entries = this.listeners.get(name) || [];
    entries.push(listener);
    this.listeners.set(name, entries);
  }

  send() {}
  close() {}

  async emit(name, value) {
    await Promise.all((this.listeners.get(name) || []).map((listener) => listener(value)));
  }
}

const flush = async () => {
  for (let index = 0; index < 4; index++) await new Promise((resolve) => setImmediate(resolve));
};

test('app, Discord, scheduled, and question events keep their destinations', async (t) => {
  const originalFetch = global.fetch;
  const originalWebSocket = global.WebSocket;
  const posts = [];
  const commands = [];
  let subscriber = null;

  global.WebSocket = FakeSocket;
  global.fetch = async (url, options) => {
    posts.push({
      channel: String(url).match(/channels\/([^/]+)\/messages/)?.[1] || '',
      content: JSON.parse(options.body).content,
    });
    return {
      status: 200,
      ok: true,
      json: async () => ({}),
      text: async () => '',
    };
  };

  const bridge = createDiscordBridge({
    config: {
      token: 'token',
      ownerIds: ['owner'],
      channelIds: ['A', 'B'],
      notifyChannelId: 'notify',
      cwd: '/project',
      policy: 'guarded',
    },
    ask: async (message) => {
      commands.push(message);
      if (message.cmd === 'run') {
        return { ok: true, runId: `run-${message.payload.replyChannelId}`, status: 'completed', content: `reply ${message.payload.replyChannelId}` };
      }
      return { ok: true };
    },
    subscribe: (listener) => {
      subscriber = listener;
      return () => { subscriber = null; };
    },
    log: { log() {}, error() {} },
  });

  t.after(() => {
    bridge.stop();
    global.fetch = originalFetch;
    global.WebSocket = originalWebSocket;
  });

  await bridge.start();
  assert.equal(typeof subscriber, 'function');

  subscriber('stream:message', 'app output', { origin: 'ui', replyChannelId: 'A', runId: 'app-run' });
  subscriber('stream:message', 'discord A', { origin: 'discord', replyChannelId: 'A', runId: 'run-a' });
  subscriber('stream:message', 'discord B', { origin: 'discord', replyChannelId: 'B', runId: 'run-b' });
  subscriber('stream:message', 'scheduled output', { origin: 'heartbeat', runId: 'heartbeat-run' });
  await flush();

  assert.deepEqual(posts, [
    { channel: 'A', content: 'discord A' },
    { channel: 'B', content: 'discord B' },
    { channel: 'notify', content: 'scheduled output' },
  ]);

  subscriber('question:request', {
    id: 'question-a',
    questions: [{ question: 'Which class?', options: ['Calculus', 'Biology'] }],
  }, { origin: 'discord', replyChannelId: 'A', runId: 'run-a' });
  await flush();

  await FakeSocket.latest.emit('message', { data: JSON.stringify({
    op: 0,
    s: 1,
    t: 'MESSAGE_CREATE',
    d: { id: 'message-b', channel_id: 'B', author: { id: 'owner' }, content: 'hello from B' },
  }) });
  assert.equal(commands.some((entry) => entry.cmd === 'answer'), false, 'channel B must not answer channel A');

  await FakeSocket.latest.emit('message', { data: JSON.stringify({
    op: 0,
    s: 2,
    t: 'MESSAGE_CREATE',
    d: { id: 'message-a', channel_id: 'A', author: { id: 'owner' }, content: '1' },
  }) });
  const answer = commands.find((entry) => entry.cmd === 'answer');
  assert.deepEqual(answer.payload, { id: 'question-a', answers: ['Calculus'] });
});
