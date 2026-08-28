const os = require('os');
const http = require('http');
const https = require('https');
const { providerPath, transportFor } = require('../../src/main/inference');

// Node's global fetch (undici) applies a 300s headersTimeout. Ollama runs here are
// non-streaming, so no response headers arrive until generation finishes, and any
// single step slower than 5 minutes died with an opaque `TypeError: fetch failed`
// (cause UND_ERR_HEADERS_TIMEOUT). node:http imposes no such limit, so long
// generations are bounded only by the caller's AbortSignal.
function requestJson(url, body, signal) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = lib.request(target, { method: body ? 'POST' : 'GET', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Ollama ${target.pathname} failed: ${res.statusCode} ${text}`));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch (err) { reject(new Error(`Ollama ${target.pathname} returned invalid JSON: ${err.message}`)); }
      });
    });

    req.setTimeout(0);
    req.on('error', reject);

    if (signal) {
      const abort = () => {
        const err = new Error('The operation was aborted due to timeout');
        err.name = 'TimeoutError';
        req.destroy(err);
      };
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }

    if (payload) req.write(payload);
    req.end();
  });
}

class OllamaProvider {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
  }

  label(model) {
    return `ollama:${model}`;
  }

  shouldRetry(err) {
    const message = String(err?.message || err || '');
    return /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|UND_ERR|aborted|terminated/i.test(message);
  }

  async json(route, body, signal) {
    const attempts = [0, 1500, 4000];
    let lastError;
    for (let index = 0; index < attempts.length; index++) {
      if (attempts[index]) {
        await new Promise((resolve) => setTimeout(resolve, attempts[index]));
      }
      try {
        return await requestJson(this.baseUrl + route, body, signal);
      } catch (err) {
        lastError = err;
        if (!this.shouldRetry(err) || index === attempts.length - 1) throw err;
      }
    }
    throw lastError;
  }

  async listModels() {
    const tags = await this.json(providerPath('ollama', 'models'));
    return (tags.models || []).map((entry) => entry.name || entry.model).filter(Boolean).sort();
  }

  async runtimeMetadata(model, runtimeSettings = {}) {
    const [tags, show, version] = await Promise.all([
      this.json(providerPath('ollama', 'models')).catch(() => ({ models: [] })),
      this.json(providerPath('ollama', 'model'), { model }).catch(() => ({})),
      this.json(providerPath('ollama', 'version')).catch(() => ({})),
    ]);
    const tag = (tags.models || []).find((entry) => entry.name === model || entry.model === model) || {};
    const modelInfo = show.model_info || {};
    const contextKey = Object.keys(modelInfo).find((key) => key.endsWith('.context_length'));
    return {
      appVersion: require('../../package.json').version,
      appCommit: null,
      ollamaVersion: version.version || null,
      provider: 'ollama',
      model: {
        name: model,
        digest: tag.digest || null,
        sizeBytes: tag.size || null,
        family: tag.details?.family || show.details?.family || null,
        parameterSize: tag.details?.parameter_size || show.details?.parameter_size || null,
        quantization: tag.details?.quantization_level || show.details?.quantization_level || null,
        nativeContext: contextKey ? modelInfo[contextKey] : null,
      },
      settings: {
        inferenceEndpoint: this.baseUrl,
        requestedContextCap: runtimeSettings.contextCap || null,
        codeTemperature: runtimeSettings.temperature ?? null,
        provider: 'ollama',
      },
      hardware: {
        platform: process.platform,
        arch: process.arch,
        totalMemoryBytes: os.totalmem(),
        cpu: os.cpus()?.[0]?.model || null,
        cpuCount: os.cpus()?.length || null,
      },
      roles: {
        main: {
          name: this.label(model),
          digest: tag.digest || null,
          sizeBytes: tag.size || null,
          family: tag.details?.family || show.details?.family || null,
          parameterSize: tag.details?.parameter_size || show.details?.parameter_size || null,
          quantization: tag.details?.quantization_level || show.details?.quantization_level || null,
          nativeContext: contextKey ? modelInfo[contextKey] : null,
        },
      },
    };
  }

  normalizeMessages(messages) {
    return messages.map((message) => {
      if (message.role === 'tool') {
        return {
          role: 'tool',
          content: String(message.content || ''),
          tool_name: message.tool_name,
        };
      }
      if (message.role === 'assistant' && message.tool_calls) {
        return {
          role: 'assistant',
          content: message.content || '',
          tool_calls: message.tool_calls.map((call) => ({
            function: {
              name: call.function.name,
              arguments: typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments,
            },
          })),
        };
      }
      return { role: message.role, content: message.content || '' };
    });
  }

  async respond({ model, systemPrompt, messages, tools, contextCap, temperature, think, signal }) {
    const transport = transportFor('ollama');
    const request = transport.request({
      endpoint: this.baseUrl,
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...this.normalizeMessages(messages)],
      tools,
      think,
      numCtx: contextCap || 32768,
      temperature: temperature ?? 0.2,
    });
    request.body.stream = false;

    let response;
    try {
      response = await requestJson(request.url, request.body, signal);
    } catch (err) {
      const message = String(err.message || err);
      if (request.body.think !== undefined && /does not support thinking/i.test(message)) {
        delete request.body.think;
        response = await requestJson(request.url, request.body, signal);
      } else {
        throw err;
      }
    }
    const message = response.message || {};
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call, index) => ({
          id: call.id || `ollama-call-${Date.now()}-${index}`,
          type: 'function',
          function: {
            name: call.function?.name,
            arguments: JSON.stringify(call.function?.arguments || {}),
          },
        }))
      : [];
    return {
      assistantMessage: {
        role: 'assistant',
        content: message.content || '',
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      usage: {
        promptTokens: Number(response.prompt_eval_count) || 0,
        completionTokens: Number(response.eval_count) || 0,
        totalTokens: (Number(response.prompt_eval_count) || 0) + (Number(response.eval_count) || 0),
        durations: {
          loadMs: Math.round((Number(response.load_duration) || 0) / 1e6),
          promptEvalMs: Math.round((Number(response.prompt_eval_duration) || 0) / 1e6),
          generationMs: Math.round((Number(response.eval_duration) || 0) / 1e6),
          totalMs: Math.round((Number(response.total_duration) || 0) / 1e6),
        },
      },
    };
  }
}

module.exports = { OllamaProvider };
