const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { initTools, CODER_TOOLS, CODER_TOOL_NAMES, executeTool, isDestructiveCommand, stopAllManagedProcesses } = require('../tools');

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'run';
}

function nowIso() {
  return new Date().toISOString();
}

function systemPrompt(taskPrompt) {
  return [
    'You are Brittain Code benchmark runner mode.',
    'You are solving a coding task inside a disposable benchmark fixture.',
    'Use the provided tools directly rather than narrating code.',
    'Read files before editing them.',
    'Prefer targeted edits over full rewrites unless a full rewrite is clearly simpler.',
    'Run the repository-declared verification check before claiming success.',
    'Do not modify tests or protected files unless the task explicitly authorizes it.',
    'If a tool errors, adjust and continue; do not give up without trying an evidence-based alternative.',
    '',
    'Task:',
    taskPrompt.trim(),
  ].join('\n');
}

async function safeExecuteTool(name, args, cwd) {
  if (!CODER_TOOL_NAMES.has(name)) return { result: `Error: Tool unavailable in benchmark runner: ${name}`, error: true };
  if (name === 'run_command' && isDestructiveCommand(args?.command || '')) {
    return { result: 'Error: Destructive commands are blocked in benchmark automation.', error: true };
  }
  try {
    const result = await executeTool(name, args || {}, cwd);
    return { result: String(result), error: /^Error:/.test(String(result)) };
  } catch (err) {
    return { result: `Error: ${err.message || String(err)}`, error: true };
  }
}

function extractGradeRecord(output) {
  const line = String(output)
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('JSON '));
  if (!line) throw new Error('Unable to parse grader JSON output.');
  return JSON.parse(line.slice(5));
}

function writeChat(chatDir, payload) {
  fs.mkdirSync(chatDir, { recursive: true });
  const chatId = payload.id || String(Date.now()) + Math.floor(Math.random() * 1000);
  const file = path.join(chatDir, `${chatId}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...payload, id: chatId }, null, 2));
  return { chatId, file };
}

async function gradeChat({ repoRoot, fixtureDir, taskId, chatPath }) {
  const output = cp.execFileSync(process.execPath, [path.join(repoRoot, 'benchmark', 'grade.js'), '--chat', chatPath, '--dir', fixtureDir, '--task', taskId], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 4_000_000,
  });
  return { output, record: extractGradeRecord(output) };
}

async function runSingleBenchmark({
  repoRoot,
  provider,
  providerModel,
  task,
  fixtureDir,
  promptText,
  think,
  temperature,
  contextCap,
  maxSteps,
  runTimeoutMs,
  chatDir,
}) {
  const runStartedAt = Date.now();
  const effectiveThink = typeof provider.effectiveThink === 'function'
    ? !!provider.effectiveThink({ model: providerModel, requested: !!think })
    : !!think;
  const conversation = [{ role: 'user', content: promptText }];
  const system = systemPrompt(promptText);
  const aggregateUsage = { prompt: 0, gen: 0, calls: 0, loadMs: 0, promptEvalMs: 0, generationMs: 0, totalMs: 0 };
  const metrics = {
    toolCalls: 0,
    toolErrors: 0,
    recoveredToolCalls: 0,
    toolCallRetries: 0,
    compactions: 0,
    loopIterations: 0,
    coderLoopIterations: 0,
    repairs: 0,
    orchestrations: 0,
    peakContextTokens: 0,
  };
  let finalContent = '';
  let emptyNudges = 0;
  const signal = AbortSignal.timeout(runTimeoutMs || 15 * 60 * 1000);

  for (let step = 0; step < maxSteps; step++) {
    metrics.loopIterations += 1;
    const { assistantMessage, usage } = await provider.respond({
      model: providerModel,
      systemPrompt: system,
      messages: conversation,
      tools: CODER_TOOLS,
      contextCap,
      temperature,
      think: effectiveThink,
      signal,
    });

    aggregateUsage.calls += 1;
    aggregateUsage.prompt += usage.promptTokens || 0;
    aggregateUsage.gen += usage.completionTokens || 0;
    aggregateUsage.loadMs += usage.durations?.loadMs || 0;
    aggregateUsage.promptEvalMs += usage.durations?.promptEvalMs || 0;
    aggregateUsage.generationMs += usage.durations?.generationMs || 0;
    aggregateUsage.totalMs += usage.durations?.totalMs || 0;
    metrics.peakContextTokens = Math.max(metrics.peakContextTokens, usage.totalTokens || 0);

    conversation.push(assistantMessage);
    finalContent = assistantMessage.content || finalContent;
    const toolCalls = assistantMessage.tool_calls || [];
    if (!toolCalls.length) {
      if (!assistantMessage.content?.trim() && emptyNudges < 1) {
        emptyNudges++;
        conversation.push({
          role: 'user',
          content: 'You stopped without any visible output or tool call. Continue the task now: make your next tool call, or write your final summary if the task is complete.',
        });
        continue;
      }
      break;
    }

    for (const call of toolCalls) {
      metrics.toolCalls += 1;
      let args = call.function?.arguments || {};
      if (typeof args === 'string') {
        try { args = JSON.parse(args); }
        catch {
          args = {};
          metrics.toolErrors += 1;
          conversation.push({
            role: 'tool',
            tool_name: call.function?.name,
            tool_call_id: call.id,
            content: 'Error: Tool arguments were not valid JSON.',
          });
          continue;
        }
      }
      const { result, error } = await safeExecuteTool(call.function?.name, args, fixtureDir);
      if (error) metrics.toolErrors += 1;
      conversation.push({
        role: 'tool',
        tool_name: call.function?.name,
        tool_call_id: call.id,
        content: result,
      });
    }
  }

  const runtime = await provider.runtimeMetadata(providerModel, {
    contextCap,
    temperature,
    think: effectiveThink,
    requestedThink: !!think,
  });
  const runMetrics = {
    main: aggregateUsage,
    metrics: {
      ...metrics,
      toolCalls: metrics.toolCalls,
      toolErrors: metrics.toolErrors,
      wallTimeMs: Date.now() - runStartedAt,
    },
  };
  const chatPayload = {
    id: crypto.randomBytes(8).toString('hex'),
    cwd: fixtureDir,
    title: `${task.title} — ${provider.label(providerModel)}`,
    timestamp: nowIso(),
    mode: 'solo',
    model: provider.label(providerModel),
    plannerModel: provider.label(providerModel),
    coderModel: null,
    verifierModel: null,
    think: effectiveThink,
    onlineResearch: false,
    autoApprove: true,
    runtime,
    runMetrics,
    conversation,
    finalContent,
  };
  const { chatId, file } = writeChat(chatDir, chatPayload);
  return { chatId, chatPath: file, conversation, runMetrics, runtime };
}

function rankModels(records, models, taskIds) {
  const perModel = new Map();
  for (const model of models) perModel.set(model, []);
  for (const record of records) {
    if (!perModel.has(record.modelSpec)) perModel.set(record.modelSpec, []);
    perModel.get(record.modelSpec).push(record.gradeRecord);
  }
  return [...perModel.entries()].map(([modelSpec, gradeRecords]) => ({
    modelSpec,
    taskCount: new Set(gradeRecords.map((record) => record.task)).size,
    avgScore: gradeRecords.length ? gradeRecords.reduce((sum, record) => sum + Number(record.total || 0), 0) / gradeRecords.length : 0,
    fullPasses: gradeRecords.filter((record) => record.fullPass).length,
    zeroed: gradeRecords.filter((record) => record.zeroed).length,
    complete: new Set(gradeRecords.map((record) => record.task)).size === taskIds.length,
  })).sort((a, b) =>
    Number(b.complete) - Number(a.complete)
    || b.avgScore - a.avgScore
    || b.fullPasses - a.fullPasses
    || a.zeroed - b.zeroed
    || a.modelSpec.localeCompare(b.modelSpec));
}

async function recordFailedRun({ provider, providerModel, task, taskId, error, wallTimeMs, think, temperature, contextCap, runTimeoutMs }) {
  const message = String(error?.message || error || '');
  const timedOut = /timeout|aborted/i.test(message);
  // Only a genuine time-budget overrun is the model's failure and scores zero.
  // Infrastructure failures (inference server crash, dropped connection) are not
  // attributable to the model and must not be scored; they stay in the batch
  // manifest as errors so the run can be retried or diagnosed.
  if (!timedOut) return null;
  const runtime = await provider.runtimeMetadata(providerModel, { contextCap, temperature });
  const reason = `run exceeded the ${Math.round((runTimeoutMs || 15 * 60 * 1000) / 60000)} minute budget`;
  const label = provider.label(providerModel);
  const record = {
    schemaVersion: 3,
    suiteVersion: 3,
    graderVersion: 3,
    scoreModel: 'brittainmark-v3',
    chatId: null,
    task: taskId,
    taskVersion: task.version,
    taskLanguage: task.language || null,
    mode: 'solo',
    model: label,
    plannerModel: label,
    coderModel: null,
    verifierModel: null,
    modelLabel: label,
    total: 0,
    correctness: 0, safety: 0, reliability: 0, efficiency: 0,
    C1: 0, C2: 0, S1: 0, S2: 0, R1: 0, R2: 0, R3: 0, E1: 0, E2: 0, E3: 0,
    visible: 0, visibleTotal: 0, hidden: 0, hiddenTotal: 0,
    changed: [], collateral: [], protectedTampered: false,
    zeroed: true,
    zeroedReasons: [reason],
    fullPass: false,
    toolCalls: 0, toolErrors: 0, promptTokens: 0, generatedTokens: 0,
    wallTimeMs: wallTimeMs || 0,
    scorePerMinute: 0,
    recoveredToolCalls: 0, toolCallRetries: 0, compactions: 0,
    loopIterations: 0, coderLoopIterations: 0, repairs: 0, peakContextTokens: 0,
    settings: {
      think: !!think,
      onlineResearch: false,
      autoApprove: true,
      contextCap: contextCap || null,
      temperature: temperature ?? null,
    },
    runtime,
    baseline: null,
    ranAt: new Date().toISOString(),
    gradedAt: new Date().toISOString(),
    failure: { error: message, timedOut },
  };
  record.modelDigests = { main: runtime.roles?.main?.digest || null };
  const fingerprint = `main:${runtime.roles?.main?.digest || runtime.roles?.main?.name || '?'}`;
  record.configKey = [record.suiteVersion, record.task, record.taskVersion, record.mode, fingerprint,
    `think=${record.settings.think}`, `ctx=${record.settings.contextCap || '?'}`, `app=${runtime.appVersion || '?'}`].join('|');

  const resultsPath = path.join(__dirname, 'results.json');
  let results = [];
  try { results = JSON.parse(fs.readFileSync(resultsPath, 'utf8')); } catch {}
  results.push(record);
  fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  try { require('./report.js').writeReport(resultsPath, path.join(__dirname, 'report.html')); } catch {}
  return record;
}

module.exports = { runSingleBenchmark, gradeChat, rankModels, slug, stopAllManagedProcesses, initTools, recordFailedRun };
