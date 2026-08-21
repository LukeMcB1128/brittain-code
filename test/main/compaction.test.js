const test = require('node:test');
const assert = require('node:assert/strict');

const {
  retainedBudget,
  tailBudget,
  summaryBudget,
  selectVerbatimTail,
  minimumSummaryTokens,
  validateSummary,
} = require('../../src/main/compaction');

const user = (content) => ({ role: 'user', content });
const assistant = (content, tool_calls) => ({ role: 'assistant', content, ...(tool_calls ? { tool_calls } : {}) });
const toolResult = (content) => ({ role: 'tool', content });

function turn(label, size = 20) {
  return [
    user(`${label} request ${'x'.repeat(size)}`),
    assistant(`${label} plan`, [{ function: { name: 'read_file', arguments: { path: `${label}.js` } } }]),
    toolResult(`${label} file body ${'y'.repeat(size)}`),
    assistant(`${label} done`),
  ];
}

test('retained budget gives small context windows a larger share', () => {
  assert.equal(retainedBudget(8192), Math.floor(8192 * 0.40));
  assert.equal(retainedBudget(32768), Math.floor(32768 * 0.28));
  assert.equal(retainedBudget(131072), Math.floor(131072 * 0.25));
  // A large window still retains more tokens outright than a small one.
  assert.ok(retainedBudget(131072) > retainedBudget(8192));
});

test('retained budget is zero for an unknown context length', () => {
  assert.equal(retainedBudget(0), 0);
  assert.equal(retainedBudget(undefined), 0);
  assert.equal(tailBudget(null), 0);
});

test('tail and summary budgets split the retained room without overspending it', () => {
  const limit = 32768;
  const tail = tailBudget(limit);
  const summary = summaryBudget(limit, tail);
  assert.ok(tail > 0);
  assert.ok(summary > 0);
  assert.ok(tail + summary <= retainedBudget(limit));
});

test('summary budget never returns a uselessly small floor', () => {
  assert.ok(summaryBudget(4096, 100_000) >= 256);
});

test('the verbatim tail starts at a user message, never mid-turn', () => {
  const messages = [...turn('one'), ...turn('two'), ...turn('three')];
  const { tail } = selectVerbatimTail(messages, 10_000);
  assert.ok(tail.length > 0);
  assert.equal(tail[0].role, 'user');
});

test('a tool result is never separated from the assistant message that called it', () => {
  const messages = [...turn('one'), ...turn('two'), ...turn('three')];
  const { tail } = selectVerbatimTail(messages, 10_000);
  for (let i = 0; i < tail.length; i++) {
    if (tail[i].role !== 'tool') continue;
    const previous = tail[i - 1];
    assert.ok(previous, 'a tool result must not be the first message in the tail');
    assert.ok(
      previous.role === 'assistant' || previous.role === 'tool',
      'a tool result must follow its assistant call'
    );
  }
});

test('the tail never swallows the whole conversation', () => {
  const messages = [...turn('one'), ...turn('two')];
  const { tail, head } = selectVerbatimTail(messages, 1_000_000);
  assert.ok(head.length > 0, 'compaction must leave something to summarize');
  assert.ok(tail.length < messages.length);
});

test('head and tail together reconstruct the original conversation exactly', () => {
  const messages = [...turn('one'), ...turn('two'), ...turn('three')];
  const { tail, head } = selectVerbatimTail(messages, 5_000);
  assert.deepEqual([...head, ...tail], messages);
});

test('a budget too small for any complete turn keeps no tail at all', () => {
  const messages = [...turn('one', 400), ...turn('two', 400)];
  const { tail, head, tokens } = selectVerbatimTail(messages, 5);
  assert.deepEqual(tail, []);
  assert.deepEqual(head, messages);
  assert.equal(tokens, 0);
});

test('a larger budget keeps at least as many turns as a smaller one', () => {
  const messages = [...turn('one'), ...turn('two'), ...turn('three'), ...turn('four')];
  const small = selectVerbatimTail(messages, 200);
  const large = selectVerbatimTail(messages, 4_000);
  assert.ok(large.turns >= small.turns);
  assert.ok(large.tokens >= small.tokens);
});

test('tail selection tolerates empty and malformed input', () => {
  assert.deepEqual(selectVerbatimTail([], 1000).tail, []);
  assert.deepEqual(selectVerbatimTail(undefined, 1000).tail, []);
  assert.deepEqual(selectVerbatimTail([user('only one')], 1000).tail, []);
});

test('the summary floor scales with the source but stays bounded', () => {
  assert.equal(minimumSummaryTokens(1000), 120, 'short sources keep a modest floor');
  assert.equal(minimumSummaryTokens(20_000), 400);
  assert.equal(minimumSummaryTokens(10_000_000), 900, 'the floor is capped');
});

test('a two-sentence summary of a huge conversation is rejected', () => {
  const result = validateSummary('We worked on the parser. It is fine now.', { sourceTokens: 130_000 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'too short');
  assert.ok(result.required > result.tokens);
});

test('an empty or whitespace summary is rejected', () => {
  assert.equal(validateSummary('', { sourceTokens: 5000 }).reason, 'empty');
  assert.equal(validateSummary('   \n  ', { sourceTokens: 5000 }).reason, 'empty');
  assert.equal(validateSummary(null, { sourceTokens: 5000 }).reason, 'empty');
});

test('a substantial summary is accepted', () => {
  const summary = 'word '.repeat(2000);
  const result = validateSummary(summary, { sourceTokens: 130_000 });
  assert.equal(result.ok, true);
  assert.ok(result.tokens >= result.required);
});

test('a short summary of a short conversation is accepted', () => {
  const result = validateSummary('word '.repeat(200), { sourceTokens: 900 });
  assert.equal(result.ok, true);
});
