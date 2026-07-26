class AnthropicProvider {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
    this.apiKey = options.apiKey || process.env.ANTHROPIC_API_KEY || '';
    this.apiVersion = options.apiVersion || process.env.ANTHROPIC_VERSION || '2023-06-01';
    this.maxTokens = Number(options.maxTokens || process.env.ANTHROPIC_MAX_TOKENS || 8192);
    this.thinkingBudget = Number(options.thinkingBudget || process.env.ANTHROPIC_THINKING_BUDGET || 4096);
  }

  label(model) {
    return `anthropic:${model}`;
  }

  headers(beta) {
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is required for Anthropic benchmark runs.');
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': this.apiVersion,
    };
    if (beta) headers['anthropic-beta'] = beta;
    return headers;
  }

  async json(route, body, signal, beta) {
    const res = await fetch(this.baseUrl + route, {
      method: 'POST',
      headers: this.headers(beta),
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new Error(`Anthropic ${route} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  // The Messages API is explicit-model only; the CLI accepts anthropic:<model> specs.
  thinkingMode(model) {
    const id = String(model || '').toLowerCase();
    if (/^claude-(?:opus|sonnet)-4-(?:6|7|8)(?:$|-)/.test(id) || /^claude-(?:opus|sonnet|fable|mythos)-5(?:$|-)/.test(id)) {
      return 'adaptive';
    }
    if (/^claude-(?:opus|sonnet|haiku)-4-5(?:$|-)/.test(id)) return 'manual';
    return null;
  }

  effectiveThink({ model, requested }) {
    return !!requested && this.thinkingMode(model) !== null;
  }

  thinkingConfig(model, think) {
    if (!think) return null;
    const mode = this.thinkingMode(model);
    if (mode === 'adaptive') return { type: 'adaptive', display: 'summarized' };
    if (mode === 'manual') return { type: 'enabled', budget_tokens: this.thinkingBudget };
    return null;
  }

  async runtimeMetadata(model, runtimeSettings = {}) {
    return {
      appVersion: require('../../package.json').version,
      appCommit: null,
      ollamaVersion: null,
      provider: 'anthropic',
      model: {
        name: this.label(model),
        digest: null,
        sizeBytes: null,
        family: 'anthropic',
        parameterSize: null,
        quantization: null,
        nativeContext: null,
      },
      settings: {
        inferenceEndpoint: this.baseUrl,
        requestedContextCap: runtimeSettings.contextCap || null,
        codeTemperature: runtimeSettings.think ? 1 : runtimeSettings.temperature ?? null,
        requestedTemperature: runtimeSettings.temperature ?? null,
        provider: 'anthropic',
        requestedThinking: !!runtimeSettings.requestedThink,
        effectiveThinking: !!runtimeSettings.think,
        thinkingMode: runtimeSettings.think ? this.thinkingMode(model) : null,
      },
      hardware: null,
      roles: {
        main: {
          name: this.label(model),
          digest: null,
          sizeBytes: null,
          family: 'anthropic',
          parameterSize: null,
          quantization: null,
          nativeContext: null,
        },
      },
    };
  }

  normalizeTools(tools) {
    return tools.map((definition) => ({
      name: definition.function.name,
      description: definition.function.description,
      input_schema: definition.function.parameters,
    }));
  }

  normalizeMessages(messages) {
    const normalized = [];
    let pendingToolResults = [];
    const flushToolResults = () => {
      if (!pendingToolResults.length) return;
      normalized.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    };

    for (const message of messages) {
      if (message.role === 'tool') {
        const content = String(message.content || '');
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: message.tool_call_id,
          content,
          is_error: /^Error:/.test(content),
        });
        continue;
      }

      flushToolResults();
      if (message.role === 'assistant') {
        const content = Array.isArray(message.provider_content)
          ? message.provider_content
          : [
              ...(message.content ? [{ type: 'text', text: String(message.content) }] : []),
              ...((message.tool_calls || []).map((call) => ({
                type: 'tool_use',
                id: call.id,
                name: call.function?.name,
                input: typeof call.function?.arguments === 'string'
                  ? JSON.parse(call.function.arguments || '{}')
                  : call.function?.arguments || {},
              }))),
            ];
        if (content.length) normalized.push({ role: 'assistant', content });
        continue;
      }

      normalized.push({ role: 'user', content: String(message.content || '') });
    }
    flushToolResults();
    return normalized;
  }

  async respond({ model, systemPrompt, messages, tools, temperature, think, signal }) {
    const thinking = this.thinkingConfig(model, think);
    const maxTokens = thinking?.type === 'enabled'
      ? Math.max(this.maxTokens, this.thinkingBudget + 1024)
      : this.maxTokens;
    const beta = thinking?.type === 'enabled' ? 'interleaved-thinking-2025-05-14' : null;
    const body = {
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: this.normalizeMessages(messages),
      tools: this.normalizeTools(tools),
      tool_choice: { type: 'auto' },
      // Anthropic requires temperature 1 whenever thinking is enabled.
      temperature: thinking ? 1 : temperature ?? 0.2,
    };
    if (thinking) body.thinking = thinking;
    const response = await this.json('/v1/messages', body, signal, beta);
    const contentBlocks = Array.isArray(response.content) ? response.content : [];
    const toolCalls = contentBlocks
      .filter((block) => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {}),
        },
      }));
    return {
      assistantMessage: {
        role: 'assistant',
        content: contentBlocks.filter((block) => block.type === 'text').map((block) => block.text || '').join(''),
        provider_content: contentBlocks,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      usage: {
        promptTokens: Number(response.usage?.input_tokens) || 0,
        completionTokens: Number(response.usage?.output_tokens) || 0,
        totalTokens: (Number(response.usage?.input_tokens) || 0) + (Number(response.usage?.output_tokens) || 0),
        durations: {
          loadMs: 0,
          promptEvalMs: 0,
          generationMs: 0,
          totalMs: 0,
        },
      },
    };
  }
}

module.exports = { AnthropicProvider };
