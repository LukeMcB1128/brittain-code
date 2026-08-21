'use strict';

// Pure helpers for conversation compaction.
//
// Compaction used to replace the whole conversation with a single summary
// string, which meant a long session could collapse into a couple of sentences
// with no way back. These helpers split that job into parts that can be checked
// before anything is destroyed: how much room a compacted conversation may
// keep, which recent messages survive verbatim, and whether a returned summary
// is substantial enough to continue from.
//
// No Electron and no network here, so all of it is testable without a model.

const estimateTokensDefault = (value) => Math.round(JSON.stringify(value).length / 4);

function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high);
}

// Compaction should buy back room to keep working, not reset the agent to zero.
// Small windows get a proportionally larger share: 25% of 8k is too little to
// hold a useful tail, while 25% of 128k is plenty.
function retainedBudget(contextLength) {
  const limit = Number(contextLength) || 0;
  if (limit <= 0) return 0;
  const share = limit <= 8192 ? 0.40
    : limit <= 16384 ? 0.32
    : limit <= 32768 ? 0.28
    : 0.25;
  return Math.floor(limit * share);
}

// Of the retained budget, this much goes to the verbatim tail. The remainder is
// summary room (and, once the ledger lands, ledger room).
const TAIL_SHARE = 0.6;

function tailBudget(contextLength) {
  return Math.floor(retainedBudget(contextLength) * TAIL_SHARE);
}

function summaryBudget(contextLength, spokenFor = 0) {
  return Math.max(256, retainedBudget(contextLength) - Math.max(0, spokenFor));
}

// A tail may only begin at a turn boundary. Starting mid-turn would hand the
// model tool results whose originating assistant tool_calls were summarized
// away — a shape Ollama rejects and the model cannot interpret.
function isTurnStart(message) {
  return message?.role === 'user';
}

function countTurns(messages) {
  return messages.reduce((total, message) => total + (isTurnStart(message) ? 1 : 0), 0);
}

// Largest suffix of `messages` that starts at a turn boundary and fits the
// budget. Never returns the entire conversation — compaction has to leave
// something behind to summarize, or it accomplishes nothing.
function selectVerbatimTail(messages, budgetTokens, estimateTokens = estimateTokensDefault) {
  const list = Array.isArray(messages) ? messages : [];
  const nothing = { tail: [], head: list.slice(), turns: 0, tokens: 0 };
  if (!list.length || !(budgetTokens > 0)) return nothing;

  let best = null;
  // Walk turn starts newest-first. Candidates grow as the index falls, so the
  // first one over budget means every earlier one is too.
  for (let i = list.length - 1; i > 0; i--) {
    if (!isTurnStart(list[i])) continue;
    const candidate = list.slice(i);
    const tokens = estimateTokens(candidate);
    if (tokens > budgetTokens) break;
    best = { tail: candidate, head: list.slice(0, i), turns: countTurns(candidate), tokens };
  }
  return best || nothing;
}

// The failure this guards against is a 130k conversation coming back as two
// sentences. The floor tracks the source so genuinely short conversations are
// still allowed to summarize short.
function minimumSummaryTokens(sourceTokens) {
  return clamp(Math.round((Number(sourceTokens) || 0) * 0.02), 120, 900);
}

function validateSummary(summary, { sourceTokens = 0, estimateTokens = estimateTokensDefault } = {}) {
  const text = String(summary || '').trim();
  if (!text) return { ok: false, reason: 'empty', tokens: 0, required: 0 };
  const tokens = estimateTokens(text);
  const required = minimumSummaryTokens(sourceTokens);
  if (tokens < required) return { ok: false, reason: 'too short', tokens, required };
  return { ok: true, tokens, required };
}

function retryInstruction(tokens, required) {
  return [
    `That summary was roughly ${tokens} tokens — too thin to resume work from.`,
    `Write a fuller one of at least ${required} tokens.`,
    'Cover the original goal, the decisions taken and why, every file created or modified and its current state,',
    'commands run and their outcomes, unresolved errors, and the remaining work. Output only the summary.',
  ].join(' ');
}

module.exports = {
  estimateTokensDefault,
  retainedBudget,
  tailBudget,
  summaryBudget,
  selectVerbatimTail,
  countTurns,
  minimumSummaryTokens,
  validateSummary,
  retryInstruction,
  TAIL_SHARE,
};
