const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  generateChatTitle,
  normalizeGeneratedTitle,
  titleMessages,
} = require('../../src/main/chat-title');
const { createHistoryStore } = require('../../src/main/history-store');

const root = path.join(__dirname, '..', '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

function historyStore() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-chat-title-'));
  return createHistoryStore({
    userDataDir: () => directory,
    runtimeMetadata: async (model) => ({ model }),
  });
}

test('a generated title is plain text on one line with seven words', () => {
  const raw = [
    '<think>Do not show this.</think>',
    'Title: "**Repair background chat naming safely across every new session**"',
    'This second line must not be in the title.',
  ].join('\n');

  assert.equal(
    normalizeGeneratedTitle(raw),
    'Repair background chat naming safely across every',
  );
});

test('title context removes image data and keeps attachment names', () => {
  const messages = titleMessages([
    {
      role: 'user',
      content: 'data:image/png;base64,very-large-image-data',
      displayContent: '',
      images: ['very-large-image-data'],
      imageTypes: ['image/png'],
      attachments: [
        { name: 'naming-failure.png', type: 'image/png' },
        { name: 'notes.txt', type: 'text/plain' },
      ],
    },
    { role: 'tool', content: 'tool output is not title context' },
    { role: 'assistant', content: 'I found the title dispatch defect.' },
  ]);

  assert.deepEqual(messages, [
    {
      role: 'user',
      content: '(attached files)',
      attachmentNames: ['naming-failure.png', 'notes.txt'],
    },
    { role: 'assistant', content: 'I found the title dispatch defect.' },
  ]);
  assert.equal(JSON.stringify(messages).includes('very-large-image-data'), false);
});

test('title generation uses silent inference with no tools', async () => {
  let call;
  const stats = { promptTokens: 18, evalTokens: 4 };
  const result = await generateChatTitle({
    conversation: [{ role: 'user', content: 'Fix automatic chat naming.' }],
    model: 'title-model',
    streamChat: async (...args) => {
      call = args;
      return { content: 'Automatic Chat Naming Repair', stats };
    },
    supportsThinking: async () => true,
    effectiveContext: async () => 32_768,
    timeoutMs: 500,
  });

  assert.deepEqual(result, { ok: true, title: 'Automatic Chat Naming Repair', stats });
  assert.equal(call[0], 'title-model');
  assert.equal(call[2] instanceof AbortSignal, true);
  assert.equal(call[3], false, 'thinking must be disabled for the title request');
  assert.equal(call[4], true, 'title tokens must not go to the chat stream');
  assert.equal(call[5], 8192, 'the small title request must have a bounded context');
  assert.equal(call[6], null, 'the title request must not have tools');
  assert.deepEqual(call[7], { toolCallRetries: 0 });
  assert.equal(call[8], 0.2);
  assert.equal(call[9], 32);
});

test('title inference has a 20 second limit and accepts cancellation', async () => {
  const source = read('src/main/chat-title.js');
  assert.match(source, /signal,\s*timeoutMs = 20_000,/);

  const controller = new AbortController();
  let requestSignal;
  let inferenceStarted;
  const started = new Promise((resolve) => { inferenceStarted = resolve; });
  const pending = generateChatTitle({
    conversation: [{ role: 'user', content: 'Fix automatic chat naming.' }],
    model: 'title-model',
    signal: controller.signal,
    streamChat: async (...args) => {
      requestSignal = args[2];
      inferenceStarted();
      return new Promise((resolve, reject) => {
        const stop = () => reject(requestSignal.reason);
        if (requestSignal.aborted) stop();
        else requestSignal.addEventListener('abort', stop, { once: true });
      });
    },
    supportsThinking: async () => false,
    effectiveContext: async () => 4096,
  });

  await started;
  controller.abort();
  const result = await pending;

  assert.equal(requestSignal.aborted, true);
  assert.equal(result.ok, false);
  assert.equal(result.aborted, true);
});

test('empty model output cannot replace the temporary title', async () => {
  const result = await generateChatTitle({
    conversation: [{ role: 'user', content: 'Fix automatic chat naming.' }],
    model: 'title-model',
    streamChat: async () => ({ content: '<think>No visible answer.</think>\n  ' }),
    supportsThinking: async () => false,
    effectiveContext: async () => 4096,
  });

  assert.deepEqual(result, { ok: false, error: 'The model returned an empty title.' });
});

test('the automatic-title marker survives history saves', async () => {
  const history = historyStore();
  const conversation = [{ role: 'user', content: 'Explain the project structure.' }];

  await history.save({
    id: 'chat-1',
    title: 'Explain the project structure.',
    model: 'm',
    autoTitlePending: true,
    autoTitleAttempts: 2,
  }, conversation);

  const pending = history.load('chat-1');
  assert.equal(pending.ok, true);
  assert.equal(pending.chat.autoTitlePending, true);
  assert.equal(pending.chat.autoTitleAttempts, 2);

  await history.save({ ...pending.chat, autoTitlePending: false, autoTitleAttempts: 3 }, conversation);
  const finished = history.load('chat-1').chat;
  assert.equal(finished.autoTitlePending, false);
  assert.equal(finished.autoTitleAttempts, 3);
});

test('only an exact legacy fallback is marked for automatic naming', () => {
  const main = read('main.js');
  const helpers = main.slice(
    main.indexOf('function fallbackChatTitle'),
    main.indexOf('function previewChatMessage'),
  );
  const hasLegacyFallbackTitle = Function(
    `'use strict';\n${helpers}\nreturn hasLegacyFallbackTitle;`,
  )();
  const prompt = 'gather some context on the repository before making changes';
  const fallback = prompt.slice(0, 30) + '...';
  const legacy = {
    id: 'chat-1725462730000-abcd1234',
    title: fallback,
    conversation: [{ role: 'user', displayContent: prompt, content: prompt }],
  };

  assert.equal(hasLegacyFallbackTitle(legacy), true);
  assert.equal(hasLegacyFallbackTitle({ ...legacy, title: fallback + '!' }), false,
    'a similar user-selected title must stay unchanged');
  assert.equal(hasLegacyFallbackTitle({ ...legacy, id: '1725462730000' }), false,
    'the migration must not apply to chats from before the faulty ID format');
  assert.equal(hasLegacyFallbackTitle({ ...legacy, autoTitlePending: false }), false,
    'a chat with explicit title state must stay unchanged');
  assert.equal(hasLegacyFallbackTitle({
    id: 'chat-1725462730001-efgh5678',
    title: 'naming-failure.png',
    conversation: [{
      role: 'user',
      displayContent: '',
      content: '',
      attachments: [{ name: 'naming-failure.png' }],
    }],
  }), true, 'an attachment-only fallback must also migrate');
});

test('a staged chat keeps final titles and migrates legacy fallbacks', () => {
  const main = read('main.js');
  const stage = main.slice(
    main.indexOf('async function stageChatJob'),
    main.indexOf('async function clearStagedChatJob'),
  );

  assert.match(stage,
    /const autoTitlePending = loaded\.ok\s*\? !!loaded\.chat\.autoTitlePending \|\| hasLegacyFallbackTitle\(loaded\.chat\)\s*:\s*true;/,
    'a later turn must keep the cleared marker false');
});

test('normal and mission saves use stored title state', () => {
  const main = read('main.js');
  const saveJob = main.slice(
    main.indexOf('async function saveChatJob'),
    main.indexOf('async function stageChatJob'),
  );
  assert.match(saveJob,
    /title: loaded\.ok\s*\? existing\.title \|\| 'Chat'\s*:\s*history\.title \|\| fallbackChatTitle/,
    'a stored literal Chat title must not be treated as temporary');
  assert.doesNotMatch(saveJob, /existing\.title !== 'Chat'/);

  const renderer = read('renderer/app.js');
  const saveStart = renderer.indexOf('async function saveChat');
  const saveChat = renderer.slice(
    saveStart,
    renderer.indexOf('async function loadChat(', saveStart),
  );
  assert.match(saveChat, /await window\.api\.historyLoad\(currentChatId\)/,
    'saveChat must load persistent title state');
  assert.match(saveChat,
    /const needsTitle = !!firstUser && \(!existingChat \|\| existingChat\.autoTitlePending\);/,
    'a mission save must use the loaded marker instead of the allocated chat ID');
  assert.doesNotMatch(saveChat, /if \(!currentChatId \|\| !firstUser\)/);
  assert.match(saveChat, /if \(existingChat\?\.title\) \{\s*title = existingChat\.title;/,
    'saveChat must preserve a stored literal Chat title');
  assert.match(saveChat, /needsTitle && autoTitleAttempts < 3/,
    'renderer-managed title requests must use the same retry limit');
  assert.match(saveChat, /autoTitlePending,\s*autoTitleAttempts,/,
    'renderer-managed saves must keep their title state');

  const titleHandler = main.slice(main.indexOf("ipcMain.handle('chat:generateTitle'"));
  assert.match(titleHandler,
    /currentAbort = titleAbort;[\s\S]*signal: titleAbort\.signal,[\s\S]*recordTitleUsage\(model, result\.stats\);/,
    'renderer-managed title requests must support Stop and record provider usage');
});

test('a completed first run resolves its title before the done event', () => {
  const main = read('main.js');
  const drain = main.slice(
    main.indexOf('async function drainChatRuns'),
    main.indexOf("ipcMain.handle('chat:send'"),
  );
  const titleResolution = drain.search(/await\s+\w*[Tt]itle\w*\(/);
  const successfulResultGate = drain.indexOf('if (result?.ok && !result.stopped)');
  const doneEvent = drain.indexOf("sink.emit('stream:done'");

  assert.ok(titleResolution >= 0, 'chat completion must run automatic title generation');
  assert.ok(successfulResultGate >= 0 && successfulResultGate < titleResolution,
    'a failed or stopped run must not start title inference');
  assert.match(drain,
    /if \(result\?\.ok && !result\.stopped\) await \w*[Tt]itle\w*\(job\);/,
    'the success check must control the title request');
  assert.ok(titleResolution < doneEvent, 'the generated title must be saved before the UI reloads history');

  const resolverName = drain.slice(titleResolution).match(/await\s+(\w*[Tt]itle\w*)\(/)?.[1];
  assert.ok(resolverName, 'the title resolver must have a named function');
  const resolverStart = main.indexOf(`async function ${resolverName}`);
  assert.ok(resolverStart >= 0, 'the title resolver must be defined in the main process');
  const resolver = main.slice(resolverStart, main.indexOf('\n}', resolverStart) + 2);
  const pendingGuard = resolver.indexOf('if (!loaded.ok || !loaded.chat.autoTitlePending) return');
  const retryGuard = resolver.indexOf('if (attempts >= 3) return');
  const generation = resolver.indexOf('await generateChatTitle');
  assert.ok(pendingGuard >= 0 && pendingGuard < generation,
    'an existing generated title must not be replaced on a later turn');
  assert.ok(retryGuard >= 0 && retryGuard < generation,
    'three failed requests must stop title inference');
  assert.match(resolver,
    /currentAbort = titleAbort;[\s\S]*signal: titleAbort\.signal,[\s\S]*if \(currentAbort === titleAbort\) currentAbort = null;/,
    'the Stop control must own and then release the title request');
  assert.match(resolver,
    /if \(!generated\.ok\) \{[\s\S]*if \(!generated\.aborted\) \{[\s\S]*const nextAttempts = attempts \+ 1;[\s\S]*autoTitlePending: nextAttempts < 3,[\s\S]*autoTitleAttempts: nextAttempts,/,
    'failed requests must stop after the third attempt, while cancellation does not spend an attempt');
  assert.ok(resolver.indexOf('recordTitleUsage(job.model, generated.stats);') < resolver.indexOf('runMetrics: usage'),
    'title usage must be recorded before the updated metrics are saved');
  assert.match(resolver, /autoTitleAttempts: attempts \+ 1,/,
    'a successful request must record its attempt');
  assert.match(resolver, /autoTitlePending:\s*false/,
    'successful finalization must clear the pending marker');

  const usageStart = main.indexOf('function recordTitleUsage');
  const usage = main.slice(usageStart, main.indexOf('\n}', usageStart) + 2);
  assert.match(usage, /recordUsage\('main', stats\);/,
    'title tokens must be included in the session usage totals');
});
