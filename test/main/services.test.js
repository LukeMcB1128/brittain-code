const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const { median, queryBenchmarks, readBenchResults } = require('../../src/main/benchmark-service');
const { createCheckpointService } = require('../../src/main/checkpoint-service');
const { createHardwareProfile, megabytesToBytes } = require('../../src/main/hardware-profile');
const { createHistoryStore, safeChatId } = require('../../src/main/history-store');
const {
  compactRecommendationShow,
  createRecommendationsService,
  needsVerboseRecommendationShow,
  sameRecommendationHardware,
} = require('../../src/main/recommendations-service');

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'brittain-service-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('history store saves runtime data and keeps file names inside its directory', async (t) => {
  const userData = tempDirectory(t);
  const store = createHistoryStore({
    userDataDir: () => userData,
    runtimeMetadata: async (name) => ({ model: { name: name || null }, source: 'test' }),
  });

  assert.equal(safeChatId('chat:/one'), 'chatone');
  assert.deepEqual(store.list(), []);
  assert.deepEqual(await store.save({
    id: 'chat:/one',
    title: 'Saved chat',
    model: 'main:8b',
    coderModel: 'coder:8b',
    subModel: 'scout:3b',
    mode: 'chat',
    contextState: { projectPath: '/project', pinnedFiles: ['README.md'] },
  }, [{ role: 'user', content: 'Hello' }]), { ok: true });

  assert.equal(store.list()[0].id, 'chatone');
  const loaded = store.load('chat:/one');
  assert.equal(loaded.ok, true);
  assert.equal(loaded.chat.runtime.roles.coder.name, 'coder:8b');
  assert.equal(loaded.chat.conversation[0].content, 'Hello');
  assert.deepEqual(loaded.chat.contextState, { projectPath: '/project', pinnedFiles: ['README.md'] });
  assert.deepEqual(store.remove('chat:/one'), { ok: true });
  assert.deepEqual(store.list(), []);
});

test('hardware profile reports unified memory and reuses the hardware scan', async () => {
  let endpoint = 'http://localhost:11434';
  let graphicsCalls = 0;
  const profile = createHardwareProfile({
    getEndpoint: () => endpoint,
    isLocalEndpoint: (value) => value.includes('localhost'),
    processRef: {
      platform: 'darwin',
      arch: 'arm64',
      getSystemMemoryInfo: () => ({ total: 16 * 1024 * 1024, free: 1024, purgeable: 512 }),
    },
    osRef: {
      totalmem: () => 1,
      cpus: () => [{ model: 'Test Apple chip' }],
    },
    systemInformationRef: {
      graphics: async () => {
        graphicsCalls += 1;
        return { controllers: [{ model: 'Integrated GPU', memoryTotal: 16384, vramDynamic: true }] };
      },
    },
  });

  const local = await profile();
  assert.equal(local.totalMemoryBytes, 16 * 1024 ** 3);
  assert.equal(local.unifiedMemory, true);
  assert.equal(local.totalVramBytes, 0);
  assert.equal(local.controllers[0].vramBytes, megabytesToBytes(16384));
  endpoint = 'https://remote.example';
  assert.equal((await profile()).appliesToEndpoint, false);
  assert.equal(graphicsCalls, 1);
});

test('benchmark service reads results and groups scores by task and model', (t) => {
  const directory = tempDirectory(t);
  const resultsPath = path.join(directory, 'results.json');
  fs.writeFileSync(resultsPath, JSON.stringify([
    { task: 'fix', model: 'a', mode: 'solo', total: 60 },
    { task: 'fix', model: 'a', mode: 'solo', total: 80 },
    { task: 'fix', model: 'b', mode: 'solo', total: 65 },
    { task: 'build', model: 'a', mode: 'solo', total: 90 },
  ]));

  assert.equal(median([9, 1, 5, 3]), 4);
  const result = queryBenchmarks(readBenchResults(resultsPath), 'fix');
  assert.equal(result.available, true);
  assert.deepEqual(result.tasks, ['build', 'fix']);
  assert.deepEqual(result.rows.map((row) => [row.model, row.median, row.runs]), [
    ['a', 70, 2],
    ['b', 65, 1],
  ]);
  assert.deepEqual(readBenchResults(path.join(directory, 'missing.json')), []);
});

test('checkpoint service reports an absent checkpoint without changing files', async () => {
  const gitCalls = [];
  let published = null;
  const service = createCheckpointService({
    gitRun: async (args) => {
      gitCalls.push(args);
      return { ok: false, out: '', err: 'not a repository' };
    },
    getTempDirectory: () => os.tmpdir(),
    publishState: (state) => { published = state; },
  });

  assert.equal(await service.create('/missing'), null);
  assert.deepEqual(await service.undo('/missing'), {
    ok: false,
    error: 'No checkpoint for this folder in this session.',
  });
  assert.deepEqual(gitCalls, [['rev-parse', '--git-dir']]);
  assert.deepEqual(published, { available: false, cwd: '/missing' });
});

test('checkpoint service can adopt a validated persisted checkpoint', () => {
  let published = null;
  const store = createCheckpointService({
    gitRun: async () => ({ ok: true, out: '' }),
    getTempDirectory: () => os.tmpdir(),
    publishState: (state) => { published = state; },
  });
  assert.equal(store.adopt({ ref: 'refs/brittain/checkpoints/saved', cwd: '/project', at: 123 }), true);
  assert.deepEqual(store.current(), { ref: 'refs/brittain/checkpoints/saved', cwd: '/project', at: 123 });
  assert.deepEqual(published, { available: true, cwd: '/project' });
});

test('checkpoint diff does not report an unchanged untracked file as deleted and new', async (t) => {
  const cwd = tempDirectory(t);
  cp.execFileSync('git', ['init', '-q'], { cwd });
  cp.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  cp.execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'before\n');
  cp.execFileSync('git', ['add', 'tracked.txt'], { cwd });
  cp.execFileSync('git', ['commit', '-qm', 'base'], { cwd });
  fs.writeFileSync(path.join(cwd, 'existing-untracked.txt'), 'keep me\n');

  const gitRun = async (args, directory, env) => {
    const result = cp.spawnSync('git', args, { cwd: directory, env, encoding: 'utf8' });
    return { ok: result.status === 0, out: result.stdout || '', err: result.stderr || '' };
  };
  const service = createCheckpointService({
    gitRun,
    getTempDirectory: () => os.tmpdir(),
    publishState: () => {},
  });
  assert.ok(await service.create(cwd));
  fs.writeFileSync(path.join(cwd, 'tracked.txt'), 'after\n');

  const result = await service.diffStat(cwd);
  assert.equal(result.ok, true);
  assert.match(result.out, /tracked\.txt/);
  assert.doesNotMatch(result.out, /existing-untracked\.txt/);
});

test('checkpoint diff uses the snapshot supplied by the run', async (t) => {
  const cwd = tempDirectory(t);
  cp.execFileSync('git', ['init', '-q'], { cwd });
  cp.execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  cp.execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  fs.writeFileSync(path.join(cwd, 'base.txt'), 'base\n');
  cp.execFileSync('git', ['add', 'base.txt'], { cwd });
  cp.execFileSync('git', ['commit', '-qm', 'base'], { cwd });

  const gitRun = async (args, directory, env) => {
    const result = cp.spawnSync('git', args, { cwd: directory, env, encoding: 'utf8' });
    return { ok: result.status === 0, out: result.stdout || '', err: result.stderr || '' };
  };
  const service = createCheckpointService({
    gitRun,
    getTempDirectory: () => os.tmpdir(),
    publishState: () => {},
  });
  const firstRun = await service.create(cwd);
  fs.writeFileSync(path.join(cwd, 'first-run.txt'), 'first\n');
  await service.create(cwd);
  fs.writeFileSync(path.join(cwd, 'second-run.txt'), 'second\n');

  const result = await service.diffStat(cwd, firstRun);
  assert.equal(result.ok, true);
  assert.match(result.out, /first-run\.txt/);
  assert.match(result.out, /second-run\.txt/);
});

test('a failed checkpoint cannot leave an older run available', async () => {
  const published = [];
  let fail = false;
  const service = createCheckpointService({
    gitRun: async (args) => {
      if (fail || args[0] === 'rev-parse') return fail
        ? { ok: false, out: '', err: 'locked' }
        : { ok: true, out: args[1] === '--git-dir' ? '.git' : 'head' };
      if (args[0] === 'write-tree') return { ok: true, out: 'tree' };
      if (args[0] === 'commit-tree') return { ok: true, out: 'commit' };
      return { ok: true, out: '' };
    },
    getTempDirectory: () => os.tmpdir(),
    publishState: (state) => published.push(state),
  });
  assert.ok(await service.create('/project'));
  fail = true;
  assert.equal(await service.create('/project'), null);
  assert.equal(service.current(), null);
  assert.deepEqual(published.at(-1), { available: false, cwd: '/project' });
});

test('checkpoint diff rejects an index that calls existing files deleted', async (t) => {
  const cwd = tempDirectory(t);
  fs.writeFileSync(path.join(cwd, 'still-here.txt'), 'present\n');
  let diffCalled = false;
  const service = createCheckpointService({
    gitRun: async (args) => {
      if (args[0] === 'rev-parse') return { ok: true, out: path.join(cwd, 'missing-index'), err: '' };
      if (args[0] === 'add') return { ok: true, out: '', err: '' };
      if (args[0] === 'ls-tree') return { ok: true, out: 'still-here.txt\0', err: '' };
      if (args[0] === 'ls-files') return { ok: true, out: '', err: '' };
      if (args[0] === 'diff') diffCalled = true;
      return { ok: true, out: '', err: '' };
    },
    getTempDirectory: () => os.tmpdir(),
    publishState: () => {},
  });
  const checkpoint = { ref: 'refs/brittain/checkpoints/run', cwd, at: 1 };
  const result = await service.diffStat(cwd, checkpoint);
  assert.equal(result.ok, false);
  assert.match(result.err, /omitted 1 existing path/);
  assert.equal(diffCalled, false);
});

test('recommendations service loads Ollama metadata through its injected boundary', async (t) => {
  const directory = tempDirectory(t);
  const calls = [];
  const service = createRecommendationsService({
    ollamaJson: async (route, body) => {
      calls.push([route, body]);
      if (route === '/api/tags') {
        return { models: [{ name: 'test:8b', size: 4 * 1024 ** 3, details: { parameter_size: '8B', quantization_level: 'Q4_K_M' } }] };
      }
      if (route === '/api/ps') return { models: [] };
      return {
        details: { parameter_size: '8B', quantization_level: 'Q4_K_M' },
        capabilities: ['completion', 'tools'],
        model_info: { 'test.context_length': 32768, 'tokenizer.test': 'removed' },
      };
    },
    hardwareProfile: async () => ({
      platform: 'darwin',
      arch: 'arm64',
      appliesToEndpoint: true,
      unifiedMemory: true,
      totalMemoryBytes: 32 * 1024 ** 3,
    }),
    getRuntimeSettings: () => ({ mainContextCap: 8192 }),
    getEndpoint: () => 'http://localhost:11434',
    isLocalEndpoint: () => true,
    getHistoryDirectory: () => path.join(directory, 'chats'),
    benchmarkDirectory: path.join(directory, 'benchmark'),
    readBenchResults: () => [],
    modelSpeedSamples: new Map(),
    defaultContext: 32768,
    getKvCacheType: () => 'q8_0',
  });

  const result = await service({ mode: 'code' });
  assert.equal(result.ok, true);
  assert.equal(result.kvCacheType, 'q8_0');
  assert.equal(result.models[0].name, 'test:8b');
  assert.equal(result.models[0].quantization, 'Q4_K_M');
  assert.equal(result.models[0].capabilities.tools, true);
  assert.deepEqual(calls.map(([route]) => route), ['/api/tags', '/api/ps', '/api/show']);
});

test('recommendations service uses the packaged baseline when Ollama has no models', async (t) => {
  const directory = tempDirectory(t);
  const service = createRecommendationsService({
    ollamaJson: async (route) => route === '/api/tags' ? { models: [] } : { models: [] },
    hardwareProfile: async () => ({
      platform: 'darwin',
      arch: 'arm64',
      appliesToEndpoint: true,
      unifiedMemory: true,
      totalMemoryBytes: 36 * 1024 ** 3,
    }),
    getRuntimeSettings: () => ({ mainContextCap: 32768 }),
    getEndpoint: () => 'http://localhost:11434',
    isLocalEndpoint: () => true,
    getHistoryDirectory: () => path.join(directory, 'chats'),
    benchmarkDirectory: path.join(directory, 'benchmark'),
    readBenchResults: () => [],
    modelSpeedSamples: new Map(),
    defaultContext: 32768,
  });

  const result = await service({ mode: 'code' });
  assert.equal(result.ok, true);
  assert.equal(result.usingBaseline, true);
  assert.equal(result.installAvailable, true);
  assert.equal(result.reference.label, 'Apple M3 Max (36 GB)');
  assert.equal(result.models.length > 0, true);
  assert.equal(result.models.every((model) => model.installed === false), true);
  assert.equal(result.models.some((model) => model.name === 'gpt-oss:20b'), true);
});

test('recommendation metadata helpers remove tokenizer data and detect hybrid models', () => {
  const compact = compactRecommendationShow({
    model_info: { 'model.context_length': 8192, 'tokenizer.large': 'discard' },
    capabilities: ['tools'],
  });
  assert.deepEqual(compact.model_info, { 'model.context_length': 8192 });
  assert.equal(needsVerboseRecommendationShow({
    model_info: {
      'model.attention.sliding_window': 4096,
      'model.attention.sliding_window_pattern': null,
    },
  }), true);
  assert.equal(sameRecommendationHardware(
    { platform: 'darwin', arch: 'arm64', totalMemoryBytes: 32 },
    { platform: 'darwin', arch: 'arm64', totalMemoryBytes: 33 },
  ), true);
});
