const test = require('node:test');
const assert = require('node:assert/strict');

const { ratesFor, costOf, formatCost, describeTurn, emptyTotals, addTurn, describeTotals } = require('../../src/main/cost');

const glm = { inputPricePerMillion: 0.075, outputPricePerMillion: 0.25 };

test('rates come from the catalog, not from anything typed in', () => {
  assert.deepEqual(ratesFor(glm), { inputPerMillion: 0.075, outputPerMillion: 0.25 });
  // A provider that publishes only one side still gives a usable figure.
  assert.deepEqual(ratesFor({ inputPricePerMillion: 1 }), { inputPerMillion: 1, outputPerMillion: 0 });
});

test('unpriced is not the same as free', () => {
  // Reporting $0.00 for a model that is quietly charging is worse than saying
  // nothing at all.
  assert.equal(ratesFor({}), null);
  assert.equal(ratesFor(null), null);
  assert.equal(costOf({ promptTokens: 1000, evalTokens: 500 }, null), null);
});

test('a turn costs what its tokens cost', () => {
  const cost = costOf({ promptTokens: 1_000_000, evalTokens: 200_000 }, ratesFor(glm));
  assert.equal(cost, 0.075 + 0.05);
  // No tokens means nothing happened, which is not a zero-cost turn to report.
  assert.equal(costOf({ promptTokens: 0, evalTokens: 0 }, ratesFor(glm)), null);
});

test('fractions of a cent are shown, not rounded away', () => {
  // A cheap model's turn is normally well under a cent; $0.00 makes the whole
  // feature look broken.
  assert.equal(formatCost(0.000021), '$0.00002');
  assert.equal(formatCost(0.0421), '$0.0421');
  assert.equal(formatCost(3.5), '$3.50');
  assert.equal(formatCost(0), 'free');
  assert.equal(formatCost('nonsense'), '');
});

test('a turn line carries the tokens behind the number', () => {
  // So the figure can be checked rather than trusted.
  const line = describeTurn({ cost: 0.00042, promptTokens: 12000, evalTokens: 800 });
  assert.match(line, /\$0\.00042/);
  assert.match(line, /12,000 in · 800 out/);
  // Unpriced still reports the tokens.
  const unpriced = describeTurn({ cost: null, promptTokens: 10, evalTokens: 5 });
  assert.equal(unpriced, '10 in · 5 out');
});

test('totals accumulate per conversation', () => {
  let totals = emptyTotals();
  totals = addTurn(totals, { cost: 0.001, promptTokens: 100, evalTokens: 50 });
  totals = addTurn(totals, { cost: 0.002, promptTokens: 200, evalTokens: 60 });
  assert.equal(totals.turns, 2);
  assert.ok(Math.abs(totals.cost - 0.003) < 1e-9);
  assert.equal(totals.promptTokens, 300);
  assert.match(describeTotals(totals), /\$0\.00300 over 2 turns/);
});

test('one unpriced turn makes the total a lower bound, and says so', () => {
  let totals = addTurn(emptyTotals(), { cost: 0.01, promptTokens: 100, evalTokens: 50 });
  totals = addTurn(totals, { cost: null, promptTokens: 100, evalTokens: 50 });
  assert.equal(totals.priced, false);
  assert.match(describeTotals(totals), /at least/);
  assert.match(describeTotals(totals), /no published rates/);
});

test('an empty conversation says so rather than showing zero', () => {
  assert.match(describeTotals(emptyTotals()), /Nothing spent/);
  assert.match(describeTotals(null), /Nothing spent/);
});

// --- wiring ---

const fs = require('node:fs');
const path = require('node:path');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

test('cost is reported once per turn, not once per model call', () => {
  // One user message can drive many calls through the tool loop; "what that
  // question cost" is the unit a person recognises.
  const main = read('main.js');
  assert.match(main, /const turnTokens = \{ promptTokens: 0, evalTokens: 0 \};/);
  assert.match(main, /turnTokens\.promptTokens \+= stats\.promptTokens \|\| 0;/);
  const emit = main.slice(main.indexOf("sink.emit('stream:cost'"), main.indexOf("sink.emit('stream:cost'") + 300);
  assert.match(emit, /sessionText: describeCostTotals\(sessionSpend\)/);
});

test('nothing is reported when inference is local', () => {
  // A local model has no bill; a line saying so on every turn is just noise.
  const main = read('main.js');
  assert.match(main, /if \(runtimeSettings\.provider === 'openai' && \(turnTokens\.promptTokens \|\| turnTokens\.evalTokens\)\)/);
  assert.match(main, /if \(runtimeSettings\.provider !== 'openai'\) return null;/, 'and rates are only looked up for cloud');
});

test('/cost exists in both modes and is hidden when local', () => {
  const app = read('renderer/app.js');
  assert.equal((app.match(/'\/cost — what this conversation has cost so far',/g) || []).length, 2,
    'listed in both the code and chat help');
  assert.match(app, /filter\(\(line\) => !line\.startsWith\('\/cost'\)\)/);
  assert.match(app, /case 'cost':/);
  // And says something useful rather than a number, when there is no bill.
  assert.match(app, /Inference is running locally, so there is nothing to bill\./);
});

test('the turn line is subordinate to the answer it follows', () => {
  const app = read('renderer/app.js');
  assert.match(app, /line\.className = 'msg info turn-cost';/);
  assert.match(read('renderer/style.css'), /\.turn-cost \{/);
});

test('spend is per conversation, so it survives a session switch', () => {
  const main = read('main.js');
  assert.match(main, /sessionSpend = addCostTurn\(sessionSpend, \{ cost, \.\.\.turnTokens \}\)/);
  assert.match(main, /ipcMain\.handle\('cost:get'/);
  assert.match(main, /cloud: runtimeSettings\.provider === 'openai'/);
});
