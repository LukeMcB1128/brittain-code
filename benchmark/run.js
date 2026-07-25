#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { TASKS, getTask } = require('./tasks');
const { prepareFixture, resetFixture } = require('./setup');
const { runSingleBenchmark, gradeChat, rankModels, slug, stopAllManagedProcesses, initTools } = require('./runner');
const { OllamaProvider } = require('./providers/ollama');
const { OpenAIProvider } = require('./providers/openai');
const { AnthropicProvider } = require('./providers/anthropic');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
      if (rawValue.trim().startsWith('"')) value = value.replace(/\\n/g, '\n');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    process.env[key] = value;
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));

function help() {
  console.log(`Brittainmark automation

Usage:
  node benchmark/run.js --models 'local:*' --tasks all
  node benchmark/run.js --models ollama:laguna-xs-2.1:latest,openai:gpt-5.6-sol --tasks cart,feature
  node benchmark/run.js --models anthropic:claude-haiku-4-5,anthropic:claude-sonnet-4-5 --tasks all
  node benchmark/run.js --models 'local:*,openai:gpt-5.6-sol' --tasks all --promote-top 5 --total-repeats 3
  node benchmark/run.js --resume 2026-07-24T21-44-02-212Z

Flags:
  --models <list>           Comma-separated model specs. Bare names default to ollama.
                            Special values: local:* / ollama:* / all-local
  --tasks <list>            Comma-separated task ids, or "all"
  --repeats <n>             Repeats for every model/task when no promotion is used (default 1)
  --promote-top <n>         Run all models once, then only the top N continue
  --total-repeats <n>       Total repeats for promoted models (default 3)
  --fixture-root <path>     Where disposable benchmark fixtures live (default benchmark/fixtures)
  --output-root <path>      Where chats and manifests are written (default benchmark/runs)
  --context-cap <n>         Requested context cap passed to providers
  --temperature <n>         Sampling temperature (default 0.2)
  --think <on|off>          Enable provider thinking when supported (default on)
  --max-steps <n>           Max agent steps per run (default 30)
  --resume <batch>          Resume an existing batch id or manifest path
  --list-local-models       Print Ollama model names and exit
  --dry-run                 Show the plan without executing runs
  --help                    Show this help
`);
}

function parseArgs(argv) {
  const args = {
    repeats: 1,
    totalRepeats: 3,
    temperature: 0.2,
    think: true,
    maxSteps: 30,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help') args.help = true;
    else if (arg === '--list-local-models') args.listLocalModels = true;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--models') args.models = argv[++i];
    else if (arg === '--tasks') args.tasks = argv[++i];
    else if (arg === '--repeats') args.repeats = Number(argv[++i]);
    else if (arg === '--promote-top') args.promoteTop = Number(argv[++i]);
    else if (arg === '--total-repeats') args.totalRepeats = Number(argv[++i]);
    else if (arg === '--fixture-root') args.fixtureRoot = argv[++i];
    else if (arg === '--output-root') args.outputRoot = argv[++i];
    else if (arg === '--context-cap') args.contextCap = Number(argv[++i]);
    else if (arg === '--temperature') args.temperature = Number(argv[++i]);
    else if (arg === '--max-steps') args.maxSteps = Number(argv[++i]);
    else if (arg === '--resume') args.resume = argv[++i];
    else if (arg === '--think') {
      const value = String(argv[++i] || '').toLowerCase();
      args.think = value === 'on' ? true : value === 'off' ? false : args.think;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function resolveTasks(taskArg) {
  if (!taskArg || taskArg === 'all') return Object.keys(TASKS);
  const taskIds = taskArg.split(',').map((value) => value.trim()).filter(Boolean);
  const unknown = taskIds.filter((taskId) => !getTask(taskId));
  if (unknown.length) throw new Error(`Unknown task id(s): ${unknown.join(', ')}`);
  return taskIds;
}

async function expandModelSpecs(modelArg, providers) {
  if (!modelArg) throw new Error('Pass --models with one or more model specs.');
  const specs = [];
  for (const raw of modelArg.split(',').map((value) => value.trim()).filter(Boolean)) {
    if (raw === 'all-local' || raw === 'local:*' || raw === 'ollama:*') {
      for (const model of await providers.ollama.listModels()) specs.push(`ollama:${model}`);
      continue;
    }
    if (/^(ollama|local|openai|anthropic):/.test(raw)) {
      const [provider, ...rest] = raw.split(':');
      if (provider === 'ollama' || provider === 'local') specs.push(`ollama:${rest.join(':')}`);
      else if (provider === 'openai') specs.push(`openai:${rest.join(':')}`);
      else if (provider === 'anthropic') specs.push(`anthropic:${rest.join(':')}`);
      continue;
    }
    specs.push(`ollama:${raw}`);
  }
  return [...new Set(specs)];
}

function providerForSpec(spec, providers) {
  const [provider, ...rest] = spec.split(':');
  const model = rest.join(':');
  if (provider === 'ollama') return { provider: providers.ollama, model };
  if (provider === 'openai') return { provider: providers.openai, model };
  if (provider === 'anthropic') return { provider: providers.anthropic, model };
  throw new Error(`Unsupported model spec: ${spec}`);
}

function ensureFixture(taskId, fixtureRoot) {
  const task = getTask(taskId);
  const dir = path.join(fixtureRoot, taskId);
  const manifestPath = path.join(dir, '.brittain-benchmark.json');
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
  if (!manifest || manifest.task !== taskId || manifest.version !== task.version) {
    prepareFixture(taskId, dir, { force: true });
  } else {
    resetFixture(dir);
  }
  return dir;
}

function resolveResumeManifest(resumeArg, outputRoot) {
  const explicit = path.resolve(resumeArg);
  if (fs.existsSync(explicit) && fs.statSync(explicit).isFile()) return explicit;
  const asBatchDir = path.join(outputRoot, resumeArg, 'manifest.json');
  if (fs.existsSync(asBatchDir)) return asBatchDir;
  throw new Error(`Could not find resume manifest for ${resumeArg}`);
}

function runKey(runSpec) {
  return [runSpec.phase, runSpec.repeat, runSpec.modelSpec, runSpec.taskId].join('|');
}

function upsertManifestRun(manifest, entry) {
  const key = runKey(entry);
  const index = manifest.runs.findIndex((run) => runKey(run) === key);
  if (index >= 0) manifest.runs[index] = entry;
  else manifest.runs.push(entry);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return help();

  const repoRoot = path.resolve(__dirname, '..');
  const fixtureRoot = path.resolve(args.fixtureRoot || path.join(__dirname, 'fixtures'));
  const outputRoot = path.resolve(args.outputRoot || path.join(__dirname, 'runs'));
  const providers = {
    ollama: new OllamaProvider(),
    openai: new OpenAIProvider(),
    anthropic: new AnthropicProvider(),
  };

  if (args.listLocalModels) {
    const models = await providers.ollama.listModels();
    for (const model of models) console.log(model);
    return;
  }

  let taskIds = resolveTasks(args.tasks || 'all');
  let modelSpecs = args.resume ? [] : await expandModelSpecs(args.models, providers);
  if (!args.resume && !modelSpecs.length) throw new Error('No models resolved from --models.');

  let batchId = new Date().toISOString().replace(/[:.]/g, '-');
  let batchDir = path.join(outputRoot, batchId);
  let chatDir = path.join(batchDir, 'chats');
  let manifestPath = path.join(batchDir, 'manifest.json');
  let manifest;
  let resumed = false;

  if (args.resume) {
    manifestPath = resolveResumeManifest(args.resume, outputRoot);
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    batchDir = path.dirname(manifestPath);
    batchId = manifest.batchId || path.basename(batchDir);
    chatDir = path.join(batchDir, 'chats');
    taskIds = manifest.taskIds;
    modelSpecs = manifest.modelSpecs;
    args.temperature = manifest.settings?.temperature ?? args.temperature;
    args.think = manifest.settings?.think ?? args.think;
    args.contextCap = manifest.settings?.contextCap ?? args.contextCap;
    args.maxSteps = manifest.settings?.maxSteps ?? args.maxSteps;
    args.promoteTop = manifest.settings?.promoteTop ?? args.promoteTop;
    args.repeats = manifest.settings?.initialRepeats ?? args.repeats;
    args.totalRepeats = manifest.settings?.totalRepeats ?? args.totalRepeats;
    resumed = true;
  }

  initTools(path.join(batchDir, 'tool-state'));
  fs.mkdirSync(chatDir, { recursive: true });

  const initialRepeats = args.promoteTop ? 1 : args.repeats;
  const totalRepeats = args.promoteTop ? Math.max(initialRepeats, args.totalRepeats || 3) : args.repeats;
  manifest = manifest || {
    batchId,
    startedAt: new Date().toISOString(),
    fixtureRoot,
    outputRoot: batchDir,
    taskIds,
    modelSpecs,
    settings: {
      initialRepeats,
      totalRepeats,
      promoteTop: args.promoteTop || null,
      temperature: args.temperature,
      think: args.think,
      contextCap: args.contextCap || null,
      maxSteps: args.maxSteps,
    },
    runs: [],
    rankings: [],
  };
  manifest.fixtureRoot = fixtureRoot;
  manifest.outputRoot = batchDir;
  manifest.taskIds = taskIds;
  manifest.modelSpecs = modelSpecs;
  manifest.settings = {
    initialRepeats,
    totalRepeats,
    promoteTop: args.promoteTop || null,
    temperature: args.temperature,
    think: args.think,
    contextCap: args.contextCap || null,
    maxSteps: args.maxSteps,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`${resumed ? 'Resuming' : 'Batch'} ${batchId}`);
  console.log(`Tasks : ${taskIds.join(', ')}`);
  console.log(`Models: ${modelSpecs.join(', ')}`);
  console.log(`Pass 1 repeats: ${initialRepeats}`);
  if (args.promoteTop) console.log(`Promotion: top ${args.promoteTop} continue to ${totalRepeats} total repeats`);
  if (args.dryRun) return;

  const batchRecords = manifest.runs
    .filter((run) => run.chatId && run.taskId !== undefined && run.total !== undefined)
    .map((run) => ({
      phase: run.phase,
      repeat: run.repeat,
      modelSpec: run.modelSpec,
      taskId: run.taskId,
      fixtureDir: run.fixtureDir || null,
      chatPath: run.chatPath,
      chatId: run.chatId,
      gradeRecord: {
        task: run.taskId,
        total: run.total,
        fullPass: !!run.fullPass,
        zeroed: !!run.zeroed,
      },
    }));
  const completedKeys = new Set(manifest.runs.filter((run) => run.chatId && run.total !== undefined).map(runKey));
  const runQueue = [];
  for (let repeat = 1; repeat <= initialRepeats; repeat++) {
    for (const modelSpec of modelSpecs) {
      for (const taskId of taskIds) {
        const spec = { phase: 'initial', repeat, modelSpec, taskId };
        if (!completedKeys.has(runKey(spec))) runQueue.push(spec);
      }
    }
  }

  async function executeRun(runSpec) {
    const { provider, model } = providerForSpec(runSpec.modelSpec, providers);
    const task = getTask(runSpec.taskId);
    const fixtureDir = ensureFixture(runSpec.taskId, fixtureRoot);
    const promptText = fs.readFileSync(path.join(__dirname, task.promptFile), 'utf8');
    const chatSlug = `${slug(runSpec.modelSpec)}__${task.id || runSpec.taskId}__r${runSpec.repeat}`;
    console.log(`[${runSpec.phase}] ${runSpec.modelSpec} :: ${runSpec.taskId} :: repeat ${runSpec.repeat}`);
    const result = await runSingleBenchmark({
      repoRoot,
      provider,
      providerModel: model,
      task,
      fixtureDir,
      promptText,
      think: args.think,
      temperature: args.temperature,
      contextCap: args.contextCap,
      maxSteps: args.maxSteps,
      chatDir,
      chatSlug,
    });
    const graded = await gradeChat({ repoRoot, fixtureDir, taskId: runSpec.taskId, chatPath: result.chatPath });
    const record = {
      ...runSpec,
      fixtureDir,
      chatPath: result.chatPath,
      chatId: result.chatId,
      gradeRecord: graded.record,
    };
    batchRecords.push(record);
    upsertManifestRun(manifest, {
      phase: runSpec.phase,
      repeat: runSpec.repeat,
      modelSpec: runSpec.modelSpec,
      taskId: runSpec.taskId,
      total: graded.record.total,
      fullPass: graded.record.fullPass,
      zeroed: graded.record.zeroed,
      chatId: result.chatId,
      chatPath: result.chatPath,
      fixtureDir,
    });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  try {
    for (const runSpec of runQueue) {
      try {
        await executeRun(runSpec);
      } catch (err) {
        const message = err.stack || err.message || String(err);
        console.error(`[run error] ${runSpec.modelSpec} :: ${runSpec.taskId} :: repeat ${runSpec.repeat}`);
        console.error(message);
        upsertManifestRun(manifest, {
          phase: runSpec.phase,
          repeat: runSpec.repeat,
          modelSpec: runSpec.modelSpec,
          taskId: runSpec.taskId,
          error: message,
          failedAt: new Date().toISOString(),
        });
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      }
    }

    if (args.promoteTop && totalRepeats > initialRepeats) {
      const rankings = rankModels(batchRecords.filter((record) => record.phase === 'initial'), modelSpecs, taskIds);
      manifest.rankings = rankings;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      const promoted = rankings.slice(0, Math.min(args.promoteTop, rankings.length)).map((entry) => entry.modelSpec);
      console.log(`Promoted: ${promoted.join(', ')}`);
      for (let repeat = initialRepeats + 1; repeat <= totalRepeats; repeat++) {
        for (const modelSpec of promoted) {
          for (const taskId of taskIds) {
            const spec = { phase: 'promoted', repeat, modelSpec, taskId };
            if (completedKeys.has(runKey(spec))) continue;
            try {
              await executeRun(spec);
            } catch (err) {
              const message = err.stack || err.message || String(err);
              console.error(`[run error] ${spec.modelSpec} :: ${spec.taskId} :: repeat ${spec.repeat}`);
              console.error(message);
              upsertManifestRun(manifest, {
                phase: spec.phase,
                repeat: spec.repeat,
                modelSpec: spec.modelSpec,
                taskId: spec.taskId,
                error: message,
                failedAt: new Date().toISOString(),
              });
              fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
            }
          }
        }
      }
    }
  } finally {
    stopAllManagedProcesses();
  }

  manifest.finishedAt = new Date().toISOString();
  manifest.rankings = rankModels(batchRecords, [...new Set(batchRecords.map((record) => record.modelSpec))], taskIds);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`Finished batch ${batchId}`);
  console.log(`Manifest: ${manifestPath}`);
}

main().catch((err) => {
  console.error(err.stack || err.message || String(err));
  stopAllManagedProcesses();
  process.exit(1);
});
