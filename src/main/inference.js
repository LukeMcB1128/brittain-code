'use strict';

// How to talk to an inference endpoint.
//
// The app has always spoken Ollama's /api/chat: newline-delimited JSON, one
// complete object per line, tool calls arriving whole. Everything cloud speaks
// OpenAI's /v1/chat/completions instead: server-sent events, deltas rather than
// messages, and tool calls arriving as indexed fragments that have to be
// stitched back together. Pointing the endpoint setting at a cloud provider
// therefore did not "just work" — it could not.
//
// A transport owns exactly two things: how to phrase the request, and how to
// turn one line of the response into deltas. The consuming loop in main.js —
// which accumulates text, watches for degradation, and emits to the sink — is
// identical for both and stays where it is.
//
// A delta is { content?, thinking?, toolCalls?, stats?, error? }; a parser may
// return several, or none, for any given line.

// Ollama reports timings in nanoseconds and counts in fields of its own; the
// OpenAI shape has none of that, so anything missing simply stays zero rather
// than being invented.
function ollamaStats(chunk) {
  return {
    promptTokens: chunk.prompt_eval_count || 0,
    evalTokens: chunk.eval_count || 0,
    tokPerSec: chunk.eval_duration ? (chunk.eval_count || 0) / (chunk.eval_duration / 1e9) : 0,
    loadMs: (chunk.load_duration || 0) / 1e6,
    promptEvalMs: (chunk.prompt_eval_duration || 0) / 1e6,
    generationMs: (chunk.eval_duration || 0) / 1e6,
    totalMs: (chunk.total_duration || 0) / 1e6,
  };
}

const ollamaTransport = {
  id: 'ollama',
  needsKey: false,

  request({ endpoint, model, messages, tools, think, numCtx, temperature, keepAlive }) {
    return {
      url: endpoint.replace(/\/+$/, '') + '/api/chat',
      headers: { 'Content-Type': 'application/json' },
      body: {
        model,
        messages,
        ...(tools ? { tools } : {}),
        stream: true,
        keep_alive: keepAlive,
        options: { num_ctx: numCtx, temperature },
        ...(think === undefined ? {} : { think }),
      },
    };
  },

  createParser() {
    return {
      push(line) {
        const chunk = JSON.parse(line);
        if (chunk.error) return [{ error: String(chunk.error) }];
        const message = chunk.message || {};
        const deltas = [];
        if (message.thinking) deltas.push({ thinking: message.thinking });
        if (message.content) deltas.push({ content: message.content });
        if (message.tool_calls) deltas.push({ toolCalls: message.tool_calls });
        if (chunk.done) deltas.push({ stats: ollamaStats(chunk) });
        return deltas;
      },
    };
  },
};

const openAITransport = {
  id: 'openai',
  needsKey: true,

  request({ endpoint, apiKey, model, messages, tools, temperature, maxTokens }) {
    return {
      // The endpoint setting holds the base URL — https://openrouter.ai/api/v1
      // or https://api.z.ai/api/paas/v4 — exactly as the provider documents it.
      url: endpoint.replace(/\/+$/, '') + '/chat/completions',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: {
        model,
        messages,
        ...(tools ? { tools } : {}),
        stream: true,
        temperature,
        ...(maxTokens ? { max_tokens: maxTokens } : {}),
        // Providers only report token usage on a stream when asked to, and
        // usage is the whole basis of knowing what a run cost.
        stream_options: { include_usage: true },
      },
    };
  },

  createParser() {
    // Tool calls arrive as fragments keyed by index: the name in one delta, the
    // arguments spread across many. They are only complete at finish_reason, so
    // they accumulate here and are emitted once.
    const pending = new Map();
    let emitted = false;

    const collect = () => {
      const calls = [...pending.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        }))
        .filter((call) => call.function.name);
      pending.clear();
      return calls;
    };

    return {
      push(line) {
        // SSE framing: comments and non-data fields are keep-alives.
        if (!line.startsWith('data:')) return [];
        const payload = line.slice(5).trim();
        if (!payload) return [];
        if (payload === '[DONE]') {
          if (emitted) return [];
          emitted = true;
          const calls = collect();
          return calls.length ? [{ toolCalls: calls }] : [];
        }

        const chunk = JSON.parse(payload);
        if (chunk.error) return [{ error: String(chunk.error.message || chunk.error) }];

        const deltas = [];
        const choice = chunk.choices?.[0];
        const delta = choice?.delta || {};

        // Reasoning models expose their thinking under different names; GLM and
        // DeepSeek use reasoning_content, others reasoning.
        const thinking = delta.reasoning_content ?? delta.reasoning;
        if (thinking) deltas.push({ thinking: String(thinking) });
        if (delta.content) deltas.push({ content: String(delta.content) });

        for (const fragment of delta.tool_calls || []) {
          const index = Number(fragment.index) || 0;
          const call = pending.get(index) || { id: '', name: '', arguments: '' };
          if (fragment.id) call.id = fragment.id;
          if (fragment.function?.name) call.name += fragment.function.name;
          if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
          pending.set(index, call);
        }

        if (choice?.finish_reason && !emitted) {
          emitted = true;
          const calls = collect();
          if (calls.length) deltas.push({ toolCalls: calls });
        }

        // Usage arrives in its own trailing chunk with no choices at all.
        if (chunk.usage) {
          deltas.push({
            stats: {
              promptTokens: chunk.usage.prompt_tokens || 0,
              evalTokens: chunk.usage.completion_tokens || 0,
              tokPerSec: 0,
              loadMs: 0,
              promptEvalMs: 0,
              generationMs: 0,
              totalMs: 0,
            },
          });
        }
        return deltas;
      },
    };
  },
};

const TRANSPORTS = { ollama: ollamaTransport, openai: openAITransport };

function transportFor(provider) {
  return TRANSPORTS[String(provider || 'ollama')] || ollamaTransport;
}

// Cloud tokens cost money, so a run's price is worth knowing rather than
// guessing. Rates are per million tokens and live in settings, because they
// change faster than any release cycle.
function estimateCost(stats, rates) {
  const input = Number(rates?.inputPerMillion) || 0;
  const output = Number(rates?.outputPerMillion) || 0;
  if (!input && !output) return 0;
  return ((Number(stats?.promptTokens) || 0) / 1e6) * input
    + ((Number(stats?.evalTokens) || 0) / 1e6) * output;
}

module.exports = { ollamaTransport, openAITransport, transportFor, estimateCost, TRANSPORTS };
