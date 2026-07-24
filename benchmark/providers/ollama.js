const os = require('os');

class OllamaProvider {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
  }

  label(model) {
    return `ollama:${model}`;
  }

  async json(route, body, signal) {
    const res = await fetch(this.baseUrl + route, {
      method: body ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) throw new Error(`Ollama ${route} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async listModels() {
    const tags = await this.json('/api/tags');
    return (tags.models || []).map((entry) => entry.name || entry.model).filter(Boolean).sort();
  }

  async runtimeMetadata(model, runtimeSettings = {}) {
    const [tags, show, version] = await Promise.all([
      this.json('/api/tags').catch(() => ({ models: [] })),
      this.json('/api/show', { model }).catch(() => ({})),
      this.json('/api/version').catch(() => ({})),
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
    const body = {
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...this.normalizeMessages(messages)],
      tools,
      stream: false,
      options: {
        num_ctx: contextCap || 32768,
        temperature: temperature ?? 0.2,
      },
    };
    if (think !== undefined) body.think = !!think;

    let response;
    try {
      response = await this.json('/api/chat', body, signal);
    } catch (err) {
      const message = String(err.message || err);
      if (body.think !== undefined && /does not support thinking/i.test(message)) {
        delete body.think;
        response = await this.json('/api/chat', body, signal);
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
