const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHistoryStore } = require('../../src/main/history-store');
const { loadSessionState } = require('../../src/main/sessions');
const { addTurn, emptyTotals } = require('../../src/main/cost');

test('a restarted conversation continues its saved spending total', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-spend-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const options = { userDataDir: () => dir, runtimeMetadata: async () => ({}) };
  const spend = addTurn(emptyTotals(), { cost: 0.25, promptTokens: 1000, evalTokens: 500 });
  assert.equal((await createHistoryStore(options).save({ id: 'discord-1', spend }, [])).ok, true);
  const restarted = createHistoryStore(options);
  assert.deepEqual(restarted.load('discord-1').chat.spend, spend);
  const restored = loadSessionState(restarted, 'discord-1');
  assert.deepEqual(restored.spend, spend);
  const next = addTurn(restored.spend, { cost: 0.5, promptTokens: 2000, evalTokens: 1000 });
  assert.equal(next.cost, 0.75);
  assert.equal(next.turns, 2);
  assert.equal(next.promptTokens, 3000);
});
