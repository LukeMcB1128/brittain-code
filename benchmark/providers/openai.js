class OpenAIProvider {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || '';
  }

  label(model) {
    return `openai:${model}`;
  }

  headers() {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is required for OpenAI benchmark runs.');
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }

  async json(route, body, signal) {
    const res = await fetch(this.baseUrl + route, {
      method: body ? 'POST' : 'GET',
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) throw new Error(`OpenAI ${route} failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async listModels() {
    const response = await this.json('/models');
    return (response.data || []).map((entry) => entry.id).filter(Boolean).sort();
  }

  async runtimeMetadata(model, runtimeSettings = {}) {
    return {
      appVersion: require('../../package.json').version,
      appCommit: null,
      ollamaVersion: null,
      provider: 'openai',
      model: {
        name: this.label(model),
        digest: null,
        sizeBytes: null,
        family: 'openai',
        parameterSize: null,
        quantization: null,
        nativeContext: null,
      },
      settings: {
        inferenceEndpoint: this.baseUrl,
        requestedContextCap: runtimeSettings.contextCap || null,
        codeTemperature: runtimeSettings.temperature ?? null,
        provider: 'openai',
      },
      hardware: null,
      roles: {
        main: {
          name: this.label(model),
          digest: null,
          sizeBytes: null,
          family: 'openai',
          parameterSize: null,
          quantization: null,
          nativeContext: null,
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
          tool_call_id: message.tool_call_id,
        };
      }
      if (message.role === 'assistant' && message.tool_calls) {
        return {
          role: 'assistant',
          content: message.content || '',
          tool_calls: message.tool_calls.map((call) => ({
            id: call.id,
            type: 'function',
            function: {
              name: call.function.name,
              arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments || {}),
            },
          })),
        };
      }
      return { role: message.role, content: message.content || '' };
    });
  }

  normalizeTools(tools) {
    return tools.map((definition) => ({
      type: 'function',
      function: {
        name: definition.function.name,
        description: definition.function.description,
        parameters: definition.function.parameters,
      },
    }));
  }

  async respond({ model, systemPrompt, messages, tools, temperature, signal }) {
    const response = await this.json('/chat/completions', {
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...this.normalizeMessages(messages)],
      tools: this.normalizeTools(tools),
      tool_choice: 'auto',
      temperature: temperature ?? 0.2,
    }, signal);
    const choice = response.choices?.[0]?.message || {};
    const toolCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls.map((call, index) => ({
      id: call.id || `openai-call-${Date.now()}-${index}`,
      type: 'function',
      function: {
        name: call.function?.name,
        arguments: call.function?.arguments || '{}',
      },
    })) : [];
    return {
      assistantMessage: {
        role: 'assistant',
        content: choice.content || '',
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      usage: {
        promptTokens: Number(response.usage?.prompt_tokens) || 0,
        completionTokens: Number(response.usage?.completion_tokens) || 0,
        totalTokens: Number(response.usage?.total_tokens) || 0,
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

module.exports = { OpenAIProvider };
