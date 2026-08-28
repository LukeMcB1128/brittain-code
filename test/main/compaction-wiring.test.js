const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const source = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function compactConversationSource() {
  const main = source('main.js');
  const start = main.indexOf('async function compactConversation(');
  const end = main.indexOf("ipcMain.handle('chat:compact'", start);
  assert.ok(start > 0 && end > start, 'compactConversation should still be findable');
  return main.slice(start, end);
}

test('the conversation is never replaced before the summary is validated', () => {
  const body = compactConversationSource();
  const validated = body.indexOf('validateSummary(');
  const replaced = body.indexOf('conversation = [');
  assert.ok(validated > 0 && replaced > 0);
  assert.ok(validated < replaced, 'validation must happen before the originals are discarded');
  // The degraded path must exist, or a failed summary would still destroy the session.
  assert.match(body, /const degraded = !check\.ok/);
  assert.match(body, /return \{\s*ok: false/, 'an unusable compaction must be able to change nothing');
});

test('both compaction paths ask for a bounded length rather than leaving it to the model', () => {
  const main = source('main.js');
  const matches = main.match(/maxTokens:/g) || [];
  assert.ok(matches.length >= 3, `expected maxTokens on every summarizer call, found ${matches.length}`);
  assert.match(source('src/main/inference.js'), /max_tokens: maxTokens/,
    'the provider-neutral limit must reach the OpenAI request');
  assert.match(source('src/main/inference.js'), /num_predict: maxTokens/,
    'the provider-neutral limit must reach the Ollama request');
  assert.doesNotMatch(compactConversationSource(), /temperature: runtimeSettings\.codeTemperature/,
    'summarizing is extraction, not authoring — it should not use the code temperature');
});

test('the scoped checkpoint path shares the conversation path summarizer', () => {
  const main = source('main.js');
  const start = main.indexOf('async function compactScopedMessages(');
  const end = main.indexOf('async function executeWithApproval(', start);
  const body = main.slice(start, end);
  assert.match(body, /renderLedger\(buildLedger\(history\)\)/);
  assert.match(body, /summaryInstruction\(/);
  assert.match(body, /validateSummary\(/);
  assert.match(body, /retryInstruction\(check\)/);
});

test('a compacted record is marked so the next compaction carries it forward', () => {
  const body = compactConversationSource();
  assert.match(body, /compactionRecord: true/);
  assert.match(body, /message\?\.compactionRecord/, 'the prior record must be found again');
  // Both bookkeeping markers are stripped on the way out: compactionRecord so
  // the next compaction can find the prior record, meta so the renderer can
  // tell machine-written messages from dialogue. Neither is the model's business.
  assert.match(source('main.js'), /excludedFromInference, compactionRecord, meta, \.\.\.message/,
    'the markers must be stripped before messages reach the model');
});

test('the ledger is persisted at compaction and a failed write does not fail the compaction', () => {
  const body = compactConversationSource();
  assert.match(body, /ledgerStore\.append\(sessionId, ledger/);
  assert.match(body, /stored\?\.ok \? stored\.path : ''/, 'a failed write is reported, not thrown');
  assert.match(source('src/main/ledger-store.js'), /catch \(error\) \{\s*return \{ ok: false/);
});

test('session identity resets when the conversation is cleared or replaced', () => {
  const main = source('main.js');
  // Resetting also drops the stashed window session, so cleared messages are
  // not waiting to be restored the next time something switches back to it.
  assert.match(main, /ipcMain\.handle\('chat:reset', \(\) => \{[\s\S]{0,160}?newSessionId\(\);/);
  assert.match(main, /ipcMain\.handle\('chat:reset'[\s\S]{0,160}?sessions\.forget\('window'\);/);
  assert.match(main, /ipcMain\.handle\('chat:load'[\s\S]{0,120}newSessionId\(\);/);
});

test('/ledger is wired from the renderer through preload to main', () => {
  assert.match(source('renderer/app.js'), /case 'ledger':/);
  assert.match(source('renderer/app.js'), /window\.api\.ledgerGet\(\)/);
  assert.match(source('preload.js'), /ledgerGet: \(\) => ipcRenderer\.invoke\('ledger:get'\)/);
  assert.match(source('main.js'), /ipcMain\.handle\('ledger:get'/);
});

test('every compaction reports what it did', () => {
  const main = source('main.js');
  assert.match(main, /description: describeCompaction\(result\)/);
  // All four call sites surface it rather than only updating the token counter.
  const reported = (main.match(/c\.description/g) || []).length;
  assert.ok(reported >= 4, `expected every compaction call site to report, found ${reported}`);
});
