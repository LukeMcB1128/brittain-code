const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

// The heuristic lives in main.js, which needs Electron; lift the patterns out
// and exercise the same matching logic so the precision claim is tested.
function financialMatcher() {
  const main = read('main.js');
  const block = main.match(/const FINANCIAL_PATTERNS = \[([\s\S]*?)\];/);
  assert.ok(block, 'FINANCIAL_PATTERNS should exist');
  const patterns = eval('[' + block[1] + ']');
  return (args) => {
    const haystack = [args.command, args.url, args.body, args.data, JSON.stringify(args)]
      .filter(Boolean).join(' ');
    return patterns.some((pattern) => pattern.test(haystack));
  };
}

test('genuine money-moving calls are flagged', () => {
  const looksFinancial = financialMatcher();
  for (const args of [
    { url: 'https://api.stripe.com/v1/charges' },
    { command: 'curl -X POST https://api.stripe.com/v1/payment_intents -d amount=4000' },
    { url: 'https://shop.example.com/checkout/sessions' },
    { command: 'place the order for the laptop stand' },
    { command: 'confirm and pay' },
    { command: 'send 0.5 eth to wallet 0xabc123' },
  ]) {
    assert.equal(looksFinancial(args), true, `should flag: ${JSON.stringify(args)}`);
  }
});

test('ordinary coding calls are not flagged, so the agent stays usable', () => {
  const looksFinancial = financialMatcher();
  for (const args of [
    { command: 'npm run build' },
    { command: 'git log --oneline' },
    { path: 'src/order.js' },
    { command: 'grep -n payment tools.js' },
    { url: 'https://api.github.com/repos/x/y/orders' },
    { path: 'test/billing/invoice.test.js' },
    { command: 'node scripts/run-tests.js' },
  ]) {
    assert.equal(looksFinancial(args), false, `should not flag: ${JSON.stringify(args)}`);
  }
});

test('the financial classification is threaded through the policy, not just detected', () => {
  const main = read('main.js');
  assert.match(main, /financial: looksFinancial\(name, args\)/, 'classifyToolCall must set financial');
  // classifyToolCall is spread straight into decide, so no separate wiring is
  // needed — assert the spread is intact.
  assert.match(main, /const call = classifyToolCall\(name, args\);\s*const decision = decideAutonomy\(policy, \{\s*\.\.\.call,/);
  assert.match(main, /call\.financial \? \{ \.\.\.promptKind, financial: true \}/,
    'a financial call must be surfaced as such in the prompt');
});

test('the approval bar names a spending call and warns before the detail', () => {
  const app = read('renderer/app.js');
  assert.match(app, /financial \? '💳 SPENDING/);
  assert.match(app, /looks like it moves money/);
});

test('/agent shows an unattended-run disclosure once per project', () => {
  const app = read('renderer/app.js');
  assert.match(app, /async function confirmAgentRun\(/);
  assert.match(app, /if \(!\(await confirmAgentRun\(cwd, policy\)\)\) return;/);
  assert.match(app, /cannot be undone/, 'the disclosure must state irreversibility plainly');
  assert.match(app, /Spending money still requires your approval/);
  assert.match(app, /agentAcknowledged/, 'acknowledgement is remembered so it is not a nag');
});

test('an autonomous policy example and its editor are reachable', () => {
  assert.match(read('src/main/autonomy.js'), /function ensureConfig\(userDataDir\)/);
  assert.match(read('main.js'), /ipcMain\.handle\('autonomy:openConfig'/);
  assert.match(read('renderer/app.js'), /case 'policies':/);
  assert.match(read('preload.js'), /autonomyOpenConfig:/);
});
