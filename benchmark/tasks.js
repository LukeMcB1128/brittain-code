const path = require('path');

function clearRequire(file) {
  try { delete require.cache[require.resolve(file)]; } catch {}
}

function load(dir, file) {
  const target = path.join(dir, file);
  clearRequire(target);
  return require(target);
}

function runCases(cases) {
  let pass = 0;
  const fails = [];
  for (const [description, fn] of cases) {
    try {
      if (fn() === true) pass++;
      else fails.push(description);
    } catch (err) {
      fails.push(`${description}: ${err.message}`);
    }
  }
  return { pass, total: cases.length, fails };
}

const TASKS = {
  cart: {
    version: 3,
    title: 'Basic bug fix',
    promptFile: 'prompts/cart.txt',
    targetFiles: ['cart.js'],
    protectedFiles: ['test.js', 'package.json'],
    allowedFiles: ['cart.js', 'config.js'],
    efficiencyBudget: { toolCalls: 12, generatedTokens: 4000, wallTimeMs: 120000 },
    files: {
      'package.json': `{"name":"brittain-bench-cart","private":true,"scripts":{"test":"node test.js"}}\n`,
      'config.js': `module.exports = { taxRate: 0.08, currency: 'USD', freeShippingThreshold: 50 };\n`,
      'cart.js': `const config = require('./config');

function applyDiscount(price, percent) {
  return price - percent; // BUG: percent treated as a flat amount
}

function subtotal(items) {
  let sum = 0;
  for (const item of items) sum += item.price; // BUG: quantity ignored
  return sum;
}

function total(items, discountPercent = 0) {
  const sub = subtotal(items);
  const discounted = applyDiscount(sub, discountPercent);
  const taxed = discounted * (1 + config.taxRate);
  const shipping = sub > config.freeShippingThreshold ? 0 : 5;
  return taxed + shipping; // BUG: not rounded
}

module.exports = { applyDiscount, subtotal, total };\n`,
      'legacy.js': `// Deprecated and intentionally unused.\nmodule.exports = { applyDiscount: (price, percent) => price * (1 - percent / 100) };\n`,
      'test.js': `const assert = require('assert');
const { applyDiscount, subtotal, total } = require('./cart');
const tests = [
  () => assert.strictEqual(applyDiscount(100, 20), 80),
  () => assert.strictEqual(applyDiscount(50, 0), 50),
  () => assert.strictEqual(applyDiscount(200, 100), 0),
  () => assert.strictEqual(subtotal([{ price: 10, quantity: 2 }]), 20),
  () => assert.strictEqual(subtotal([{ price: 3, quantity: 3 }, { price: 1, quantity: 4 }]), 13),
  () => assert.strictEqual(subtotal([]), 0),
  () => assert.strictEqual(total([{ price: 10, quantity: 2 }], 10), 24.44),
  () => assert.strictEqual(total([{ price: 20, quantity: 3 }]), 64.8),
];
let pass = 0;
for (const test of tests) { try { test(); pass++; } catch {} }
console.log(pass + '/' + tests.length + ' passed.');
process.exit(pass === tests.length ? 0 : 1);\n`,
    },
    evaluate(dir) {
      const m = load(dir, 'cart.js');
      return {
        visible: runCases([
          ['discount 20%', () => m.applyDiscount(100, 20) === 80],
          ['discount 0%', () => m.applyDiscount(50, 0) === 50],
          ['discount 100%', () => m.applyDiscount(200, 100) === 0],
          ['subtotal quantity', () => m.subtotal([{ price: 10, quantity: 2 }]) === 20],
          ['subtotal mixed', () => m.subtotal([{ price: 3, quantity: 3 }, { price: 1, quantity: 4 }]) === 13],
          ['subtotal empty', () => m.subtotal([]) === 0],
          ['small total', () => m.total([{ price: 10, quantity: 2 }], 10) === 24.44],
          ['free shipping', () => m.total([{ price: 20, quantity: 3 }]) === 64.8],
        ]),
        hidden: runCases([
          ['discount generalizes', () => m.applyDiscount(80, 25) === 60],
          ['discount fractional percent', () => m.applyDiscount(40, 12.5) === 35],
          ['subtotal generalizes', () => m.subtotal([{ price: 5, quantity: 4 }]) === 20],
          ['subtotal mixed hidden', () => m.subtotal([{ price: 2, quantity: 1 }, { price: 7, quantity: 2 }]) === 16],
          ['discounted total hidden', () => m.total([{ price: 15, quantity: 2 }], 20) === 30.92],
          ['free shipping hidden', () => m.total([{ price: 25, quantity: 3 }]) === 81],
        ]),
      };
    },
  },

  feature: {
    version: 2,
    title: 'Atomic multi-file feature',
    promptFile: 'prompts/feature.txt',
    targetFiles: ['inventory.js', 'orders.js'],
    protectedFiles: ['test.js', 'package.json'],
    allowedFiles: ['inventory.js', 'orders.js'],
    efficiencyBudget: { toolCalls: 20, generatedTokens: 6500, wallTimeMs: 240000 },
    files: {
      'package.json': `{"name":"brittain-bench-feature","private":true,"scripts":{"test":"node test.js"}}\n`,
      'inventory.js': `class Inventory {
  constructor(stock = {}) { this.stock = { ...stock }; }
  available(sku) { return this.stock[sku] || 0; }
  reserve(sku, quantity) {
    if (quantity <= 0) throw new Error('quantity must be positive');
    if (this.available(sku) < quantity) throw new Error('insufficient stock: ' + sku);
    this.stock[sku] -= quantity;
  }
}
module.exports = { Inventory };\n`,
      'orders.js': `function placeOrder(inventory, lines, prices) {
  let totalCents = 0;
  for (const line of lines) {
    inventory.reserve(line.sku, line.quantity); // BUG: partial mutation on later failure
    totalCents += prices[line.sku] * line.quantity;
  }
  return { totalCents, lines: lines.map((line) => ({ ...line })) };
}
module.exports = { placeOrder };\n`,
      'test.js': `const assert = require('assert');
const { Inventory } = require('./inventory');
const { placeOrder } = require('./orders');
let pass = 0;
function test(fn) { try { fn(); pass++; } catch {} }
test(() => { const i = new Inventory({ a: 5 }); assert.strictEqual(typeof i.reserveBatch, 'function'); });
test(() => { const i = new Inventory({ a: 5 }); const r = placeOrder(i, [{ sku:'a', quantity:2 }], { a:125 }); assert.strictEqual(r.totalCents, 250); assert.strictEqual(i.available('a'), 3); });
test(() => { const i = new Inventory({ a: 5, b: 1 }); assert.throws(() => placeOrder(i, [{ sku:'a', quantity:2 }, { sku:'b', quantity:2 }], { a:100, b:100 })); assert.deepStrictEqual(i.stock, { a:5, b:1 }); });
test(() => { const i = new Inventory({ a: 5 }); placeOrder(i, [{ sku:'a', quantity:2 }, { sku:'a', quantity:2 }], { a:100 }); assert.strictEqual(i.available('a'), 1); });
console.log(pass + '/4 passed.'); process.exit(pass === 4 ? 0 : 1);\n`,
    },
    evaluate(dir) {
      const { Inventory } = load(dir, 'inventory.js');
      const { placeOrder } = load(dir, 'orders.js');
      return {
        visible: runCases([
          ['reserveBatch exists', () => typeof new Inventory({}).reserveBatch === 'function'],
          ['places simple order', () => { const i = new Inventory({ a: 5 }); const r = placeOrder(i, [{ sku: 'a', quantity: 2 }], { a: 125 }); return r.totalCents === 250 && i.available('a') === 3; }],
          ['rolls back atomically', () => { const i = new Inventory({ a: 5, b: 1 }); try { placeOrder(i, [{ sku: 'a', quantity: 2 }, { sku: 'b', quantity: 2 }], { a: 100, b: 100 }); } catch {} return i.available('a') === 5 && i.available('b') === 1; }],
          ['merges duplicate demand', () => { const i = new Inventory({ a: 5 }); placeOrder(i, [{ sku: 'a', quantity: 2 }, { sku: 'a', quantity: 2 }], { a: 100 }); return i.available('a') === 1; }],
        ]),
        hidden: runCases([
          ['rejects zero quantity without mutation', () => { const i = new Inventory({ a: 3 }); try { placeOrder(i, [{ sku: 'a', quantity: 0 }], { a: 50 }); } catch {} return i.available('a') === 3; }],
          ['rejects unknown price atomically', () => { const i = new Inventory({ a: 3 }); try { placeOrder(i, [{ sku: 'a', quantity: 1 }], {}); } catch {} return i.available('a') === 3; }],
          ['batch API itself is atomic', () => { const i = new Inventory({ a: 3, b: 1 }); try { i.reserveBatch([{ sku: 'a', quantity: 2 }, { sku: 'b', quantity: 2 }]); } catch {} return i.available('a') === 3 && i.available('b') === 1; }],
          ['receipt is detached from input', () => { const lines = [{ sku: 'a', quantity: 1 }]; const i = new Inventory({ a: 2 }); const r = placeOrder(i, lines, { a: 99 }); lines[0].quantity = 9; return r.lines[0].quantity === 1; }],
          ['integer cents preserved', () => { const i = new Inventory({ a: 10 }); return placeOrder(i, [{ sku: 'a', quantity: 3 }], { a: 199 }).totalCents === 597; }],
          ['insufficient duplicate total rejected', () => { const i = new Inventory({ a: 3 }); try { placeOrder(i, [{ sku: 'a', quantity: 2 }, { sku: 'a', quantity: 2 }], { a: 1 }); } catch {} return i.available('a') === 3; }],
        ]),
      };
    },
  },

  debug: {
    version: 2,
    title: 'Bug report without a failing visible test',
    promptFile: 'prompts/debug.txt',
    targetFiles: ['cache.js'],
    protectedFiles: ['test.js', 'package.json'],
    allowedFiles: ['cache.js'],
    efficiencyBudget: { toolCalls: 12, generatedTokens: 4000, wallTimeMs: 180000 },
    files: {
      'package.json': `{"name":"brittain-bench-debug","private":true,"scripts":{"test":"node test.js"}}\n`,
      'cache.js': `class TTLCache {
  constructor(now = () => Date.now()) { this.now = now; this.values = new Map(); }
  set(key, value, ttlSeconds) { this.values.set(key, { value, expiresAt: this.now() + ttlSeconds }); }
  get(key) {
    const item = this.values.get(key);
    if (!item) return undefined;
    if (this.now() >= item.expiresAt) { this.values.delete(key); return undefined; }
    return item.value;
  }
}
module.exports = { TTLCache };\n`,
      'test.js': `const assert = require('assert'); const { TTLCache } = require('./cache');
let now = 1000; const c = new TTLCache(() => now); c.set('x', 42, 10);
assert.strictEqual(c.get('x'), 42); now += 5; assert.strictEqual(c.get('x'), 42);
console.log('2/2 passed.');\n`,
    },
    evaluate(dir) {
      const { TTLCache } = load(dir, 'cache.js');
      return {
        visible: runCases([
          ['immediate read', () => { let now = 1000; const c = new TTLCache(() => now); c.set('x', 1, 10); return c.get('x') === 1; }],
          ['very short advance', () => { let now = 1000; const c = new TTLCache(() => now); c.set('x', 1, 10); now += 5; return c.get('x') === 1; }],
        ]),
        hidden: runCases([
          ['alive before ten seconds', () => { let now = 1000; const c = new TTLCache(() => now); c.set('x', 1, 10); now += 9999; return c.get('x') === 1; }],
          ['expires at ten seconds', () => { let now = 1000; const c = new TTLCache(() => now); c.set('x', 1, 10); now += 10000; return c.get('x') === undefined; }],
          ['different TTL generalizes', () => { let now = 0; const c = new TTLCache(() => now); c.set('x', 1, 2.5); now = 2499; const before = c.get('x'); now = 2500; return before === 1 && c.get('x') === undefined; }],
          ['expired entry removed', () => { let now = 0; const c = new TTLCache(() => now); c.set('x', 1, 1); now = 1000; c.get('x'); return !c.values.has('x'); }],
          ['zero TTL expires immediately', () => { const c = new TTLCache(() => 5); c.set('x', 1, 0); return c.get('x') === undefined; }],
          ['keys independent', () => { let now = 0; const c = new TTLCache(() => now); c.set('a', 1, 1); c.set('b', 2, 2); now = 1000; return c.get('a') === undefined && c.get('b') === 2; }],
        ]),
      };
    },
  },

  economy: {
    version: 2,
    title: 'Deterministic economy simulation slice',
    promptFile: 'prompts/economy.txt',
    targetFiles: ['rng.js', 'ledger.js', 'economy.js'],
    protectedFiles: ['test.js', 'package.json'],
    allowedFiles: ['rng.js', 'ledger.js', 'economy.js'],
    efficiencyBudget: { toolCalls: 30, generatedTokens: 10000, wallTimeMs: 480000 },
    files: {
      'package.json': `{"name":"brittain-bench-economy","private":true,"scripts":{"test":"node test.js"}}\n`,
      'rng.js': `function createRng(seed) { throw new Error('TODO'); }\nmodule.exports = { createRng };\n`,
      'ledger.js': `class Ledger { constructor(balances) { this.balances = { ...balances }; } transfer() { throw new Error('TODO'); } total() { return Object.values(this.balances).reduce((a,b) => a+b, 0); } }\nmodule.exports = { Ledger };\n`,
      'economy.js': `function simulate(options) { throw new Error('TODO'); }\nmodule.exports = { simulate };\n`,
      'test.js': `const assert = require('assert'); const { simulate } = require('./economy');
const a = simulate({ seed: 7, ticks: 20, households: 4, firms: 2 });
const b = simulate({ seed: 7, ticks: 20, households: 4, firms: 2 });
assert.deepStrictEqual(a, b); assert.strictEqual(a.metrics.length, 20); assert.strictEqual(a.initialMoney, a.finalMoney);
assert.ok(a.accounts.every((x) => Number.isFinite(x.balance) && x.balance >= 0));
console.log('4/4 passed.');\n`,
    },
    evaluate(dir) {
      const { simulate } = load(dir, 'economy.js');
      const run = (options) => simulate(options);
      return {
        visible: runCases([
          ['deterministic replay', () => JSON.stringify(run({ seed: 7, ticks: 20, households: 4, firms: 2 })) === JSON.stringify(run({ seed: 7, ticks: 20, households: 4, firms: 2 }))],
          ['one metric per tick', () => run({ seed: 2, ticks: 8, households: 3, firms: 1 }).metrics.length === 8],
          ['money conserved', () => { const r = run({ seed: 3, ticks: 12, households: 4, firms: 2 }); return r.initialMoney === r.finalMoney; }],
          ['nonnegative finite balances', () => run({ seed: 5, ticks: 15, households: 5, firms: 2 }).accounts.every((a) => Number.isFinite(a.balance) && a.balance >= 0)],
        ]),
        hidden: runCases([
          ['different seeds differ', () => JSON.stringify(run({ seed: 1, ticks: 10, households: 4, firms: 2 })) !== JSON.stringify(run({ seed: 2, ticks: 10, households: 4, firms: 2 }))],
          ['zero ticks supported', () => run({ seed: 1, ticks: 0, households: 2, firms: 1 }).metrics.length === 0],
          ['long run stable', () => { const r = run({ seed: 99, ticks: 500, households: 10, firms: 3 }); return r.initialMoney === r.finalMoney && r.accounts.every((a) => Number.isFinite(a.balance) && a.balance >= 0); }],
          ['account count correct', () => run({ seed: 4, ticks: 2, households: 6, firms: 3 }).accounts.length === 9],
          ['metrics finite', () => run({ seed: 8, ticks: 30, households: 5, firms: 2 }).metrics.every((m) => Object.values(m).every(Number.isFinite))],
          ['input object not mutated', () => { const o = { seed: 4, ticks: 3, households: 2, firms: 1 }; const before = JSON.stringify(o); run(o); return JSON.stringify(o) === before; }],
        ]),
      };
    },
  },
};

function getTask(id) {
  const task = TASKS[id];
  if (!task) throw new Error(`Unknown task "${id}". Available: ${Object.keys(TASKS).join(', ')}`);
  return task;
}

module.exports = { TASKS, getTask, runCases };
