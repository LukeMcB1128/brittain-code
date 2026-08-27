const test = require('node:test');
const assert = require('node:assert/strict');

const { ollamaTransport, openAITransport, transportFor, estimateCost } = require('../../src/main/inference');

const drain = (parser, lines) => lines.flatMap((line) => parser.push(line));

// --- request shape ---

test('each provider is addressed the way it documents itself', () => {
  const ollama = ollamaTransport.request({ endpoint: 'http://localhost:11434', model: 'm', messages: [], numCtx: 8192, temperature: 0.3, keepAlive: '5m' });
  assert.equal(ollama.url, 'http://localhost:11434/api/chat');
  assert.equal(ollama.body.options.num_ctx, 8192, 'num_ctx is Ollama-only');

  const openai = openAITransport.request({ endpoint: 'https://openrouter.ai/api/v1', apiKey: 'sk-x', model: 'm', messages: [], temperature: 0.3 });
  assert.equal(openai.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(openai.headers.Authorization, 'Bearer sk-x');
  assert.ok(!('options' in openai.body), 'Ollama-only fields must not leak into an OpenAI request');
  assert.ok(!('keep_alive' in openai.body));
});

test('a trailing slash on the endpoint does not double up', () => {
  assert.equal(openAITransport.request({ endpoint: 'https://api.z.ai/api/paas/v4/', model: 'm', messages: [] }).url,
    'https://api.z.ai/api/paas/v4/chat/completions');
  assert.equal(ollamaTransport.request({ endpoint: 'http://localhost:11434/', model: 'm', messages: [] }).url,
    'http://localhost:11434/api/chat');
});

test('usage is requested explicitly, because a stream withholds it otherwise', () => {
  // Without this a cloud run reports no token counts at all, and cost cannot be
  // computed from anything.
  const body = openAITransport.request({ endpoint: 'https://x/v1', model: 'm', messages: [] }).body;
  assert.deepEqual(body.stream_options, { include_usage: true });
});

// --- parsing ---

test('Ollama lines carry whole messages', () => {
  const deltas = drain(ollamaTransport.createParser(), [
    JSON.stringify({ message: { thinking: 'hmm' } }),
    JSON.stringify({ message: { content: 'hello' } }),
    JSON.stringify({ message: { tool_calls: [{ function: { name: 'read_file', arguments: { path: 'a' } } }] } }),
    JSON.stringify({ done: true, prompt_eval_count: 10, eval_count: 5, eval_duration: 1e9 }),
  ]);
  assert.deepEqual(deltas[0], { thinking: 'hmm' });
  assert.deepEqual(deltas[1], { content: 'hello' });
  assert.equal(deltas[2].toolCalls[0].function.name, 'read_file');
  assert.equal(deltas[3].stats.promptTokens, 10);
  assert.equal(deltas[3].stats.tokPerSec, 5);
});

test('an OpenAI tool call is stitched back together from its fragments', () => {
  // The name arrives once and the arguments across many deltas; emitting early
  // would hand the loop an unparseable half-object.
  const deltas = drain(openAITransport.createParser(), [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.js\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ]);
  const calls = deltas.find((d) => d.toolCalls)?.toolCalls;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'call_1');
  assert.equal(calls[0].function.name, 'read_file');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: 'a.js' });
});

test('parallel tool calls keep their own identities and order', () => {
  const deltas = drain(openAITransport.createParser(), [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"second","arguments":"{}"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"first","arguments":"{}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
  ]);
  const calls = deltas.find((d) => d.toolCalls).toolCalls;
  assert.deepEqual(calls.map((c) => c.function.name), ['first', 'second'], 'sorted by index, not arrival');
});

test('tool calls are emitted exactly once', () => {
  // finish_reason and [DONE] both mark the end; emitting at each would run
  // every tool twice.
  const deltas = drain(openAITransport.createParser(), [
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"x","arguments":"{}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: [DONE]',
  ]);
  assert.equal(deltas.filter((d) => d.toolCalls).length, 1);
});

test('reasoning content is recognised under either name', () => {
  const glm = drain(openAITransport.createParser(), ['data: {"choices":[{"delta":{"reasoning_content":"step one"}}]}']);
  assert.deepEqual(glm[0], { thinking: 'step one' });
  const other = drain(openAITransport.createParser(), ['data: {"choices":[{"delta":{"reasoning":"step one"}}]}']);
  assert.deepEqual(other[0], { thinking: 'step one' });
});

test('SSE keep-alives and blank lines are ignored', () => {
  const parser = openAITransport.createParser();
  assert.deepEqual(parser.push(': ping'), []);
  assert.deepEqual(parser.push('data:'), []);
  assert.deepEqual(parser.push('event: message'), []);
});

test('usage arrives in a trailing chunk that has no choices', () => {
  const deltas = drain(openAITransport.createParser(), [
    'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":45}}',
  ]);
  assert.equal(deltas[0].stats.promptTokens, 120);
  assert.equal(deltas[0].stats.evalTokens, 45);
});

test('an error in the stream surfaces as an error delta, not a crash', () => {
  assert.match(drain(openAITransport.createParser(), ['data: {"error":{"message":"rate limited"}}'])[0].error, /rate limited/);
  assert.match(drain(ollamaTransport.createParser(), [JSON.stringify({ error: 'model not found' })])[0].error, /model not found/);
});

// --- selection and cost ---

test('an unknown provider falls back to local rather than guessing', () => {
  assert.equal(transportFor('ollama').id, 'ollama');
  assert.equal(transportFor('openai').id, 'openai');
  assert.equal(transportFor(undefined).id, 'ollama');
  assert.equal(transportFor('anthropic').id, 'ollama', 'never silently send a conversation somewhere unintended');
});

test('cost follows the rates given, and is zero when none are', () => {
  // GLM-5.3-Flash at the time of writing: $0.15 in, $0.50 out per million.
  const stats = { promptTokens: 1_000_000, evalTokens: 200_000 };
  assert.equal(estimateCost(stats, { inputPerMillion: 0.15, outputPerMillion: 0.5 }), 0.15 + 0.1);
  assert.equal(estimateCost(stats, {}), 0, 'a local model costs nothing and should not claim otherwise');
  assert.equal(estimateCost(null, { inputPerMillion: 1 }), 0);
});
