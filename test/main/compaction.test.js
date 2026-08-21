const test = require('node:test');
const assert = require('node:assert/strict');

const {
  retainedBudget,
  tailBudget,
  summaryBudget,
  selectVerbatimTail,
  minimumSummaryTokens,
  validateSummary,
  describeCompaction,
  summaryInstruction,
  missingSections,
  retryInstruction,
  SUMMARY_SECTIONS,
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

test('a compaction is described with what was reclaimed and what survived', () => {
  const line = describeCompaction({
    ok: true, before: 131_000, after: 8_200, summaryTokens: 1_400, tailTurns: 3, retries: 0,
  });
  assert.match(line, /131000 → 8200 tokens/);
  assert.match(line, /summary 1400 tok/);
  assert.match(line, /3 recent turns kept verbatim/);
  assert.doesNotMatch(line, /retr/);
});

test('a degraded compaction says so instead of reporting a summary size', () => {
  const line = describeCompaction({
    ok: true, before: 99_000, after: 5_000, degraded: true, tailTurns: 1, retries: 1,
  });
  assert.match(line, /no usable summary/);
  assert.match(line, /1 recent turn kept verbatim/);
  assert.match(line, /1 retry/);
  assert.doesNotMatch(line, /summary \d+ tok/);
});

test('a failed compaction is described as nothing at all', () => {
  assert.equal(describeCompaction({ ok: false, error: 'boom' }), '');
  assert.equal(describeCompaction(null), '');
  assert.equal(describeCompaction(undefined), '');
});

const structured = (body = 'word '.repeat(2000)) => [
  'GOAL: ship the parser', '', 'CONSTRAINTS: no new dependencies', '',
  'DECISIONS: chose a hand-rolled lexer', '', 'STATE: half done', '',
  'NEXT: finish the error paths', '', body,
].join('\n');

test('all five required sections are recognised however the model labels them', () => {
  const labelled = ['# GOAL', '**CONSTRAINTS**', 'DECISIONS —  chose X', '## STATE:', 'NEXT - finish'].join('\n\n');
  assert.deepEqual(missingSections(labelled), []);
});

test('a missing section is reported by name', () => {
  const partial = 'GOAL: x\nSTATE: y\nNEXT: z';
  assert.deepEqual(missingSections(partial).sort(), ['CONSTRAINTS', 'DECISIONS']);
});

test('a long summary missing headings is usable but not structured', () => {
  const result = validateSummary('word '.repeat(3000), { sourceTokens: 130_000 });
  assert.equal(result.ok, true, 'it must not be discarded — it is still far better than nothing');
  assert.equal(result.structured, false);
  assert.ok(result.missing.length === SUMMARY_SECTIONS.length);
});

test('a long summary with every heading is both usable and structured', () => {
  const result = validateSummary(structured(), { sourceTokens: 130_000 });
  assert.equal(result.ok, true);
  assert.equal(result.structured, true);
  assert.deepEqual(result.missing, []);
});

test('the summary instruction names the sections and the length it wants', () => {
  const text = summaryInstruction({ tailTurns: 3, minimumTokens: 900 });
  for (const section of SUMMARY_SECTIONS) assert.match(text, new RegExp(section.name));
  assert.match(text, /3 most recent turns are being kept word for word/);
  assert.match(text, /at least 900 tokens/);
  assert.match(text, /Output only the summary/);
});

test('the instruction does not mention a tail when none is being kept', () => {
  const text = summaryInstruction({ tailTurns: 0 });
  assert.doesNotMatch(text, /kept word for word/);
  assert.match(text, /this entire conversation/);
});

test('the retry names the specific problem it wants fixed', () => {
  const short = retryInstruction({ reason: 'too short', tokens: 90, required: 900, missing: [] });
  assert.match(short, /roughly 90 tokens/);
  assert.match(short, /at least 900/);

  const unstructured = retryInstruction({ reason: 'unstructured', tokens: 1200, required: 900, missing: ['DECISIONS', 'NEXT'] });
  assert.match(unstructured, /DECISIONS, NEXT/);
  assert.doesNotMatch(unstructured, /too thin/);

  const empty = retryInstruction({ reason: 'empty', tokens: 0, required: 900, missing: [] });
  assert.match(empty, /empty/);
});

test('the description flags an unstructured summary and counts ledger entries', () => {
  const line = describeCompaction({
    ok: true, before: 131_000, after: 9_200, summaryTokens: 1_400,
    tailTurns: 3, retries: 1, unstructured: true, ledgerEntries: 12,
  });
  assert.match(line, /\(unstructured\)/);
  assert.match(line, /12 ledger entries/);
});
