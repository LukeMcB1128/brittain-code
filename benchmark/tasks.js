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

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

const TASKS = {
  cart: {
    version: 4,
    title: 'Checkout rounding and validation repair',
    promptFile: 'prompts/cart.txt',
    targetFiles: ['cart.js'],
    protectedFiles: ['test.js', 'package.json', 'config.js'],
    allowedFiles: ['cart.js'],
    efficiencyBudget: { toolCalls: 16, generatedTokens: 5500, wallTimeMs: 180000 },
    files: {
      'package.json': `{"name":"brittain-bench-cart","private":true,"scripts":{"test":"node test.js"}}\n`,
      'config.js': `module.exports = { taxRate: 0.0825, shippingCents: 599, freeShippingThresholdCents: 5000 };\n`,
      'cart.js': `const config = require('./config');

function lineTotal(line) {
  return line.unitPriceCents + line.quantity; // BUG: quantity is not a price
}

function subtotal(items) {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

function total(items, discountPercent = 0) {
  const sub = subtotal(items);
  const discounted = sub - discountPercent; // BUG: percentage treated as cents
  const tax = discounted * config.taxRate; // BUG: taxes exempt merchandise and returns fractions
  const shipping = sub > config.freeShippingThresholdCents ? 0 : config.shippingCents;
  return discounted + tax + shipping;
}

module.exports = { lineTotal, subtotal, total };\n`,
      'test.js': `const assert = require('assert');
const { lineTotal, subtotal, total } = require('./cart');
let pass = 0;
function test(fn) { try { fn(); pass++; } catch {} }
test(() => assert.strictEqual(lineTotal({ unitPriceCents: 250, quantity: 3, taxable: true }), 750));
test(() => assert.strictEqual(subtotal([{ unitPriceCents: 250, quantity: 2, taxable: true }, { unitPriceCents: 125, quantity: 4, taxable: false }]), 1000));
test(() => assert.strictEqual(total([{ unitPriceCents: 1000, quantity: 1, taxable: true }]), 1682));
test(() => assert.strictEqual(total([{ unitPriceCents: 5000, quantity: 1, taxable: false }]), 5000));
test(() => assert.strictEqual(total([{ unitPriceCents: 2500, quantity: 2, taxable: true }], 10), 5470));
test(() => assert.throws(() => total([{ unitPriceCents: -1, quantity: 1, taxable: true }])));
console.log(pass + '/6 passed.'); process.exit(pass === 6 ? 0 : 1);\n`,
    },
    evaluate(dir) {
      const m = load(dir, 'cart.js');
      return {
        visible: runCases([
          ['line total uses quantity', () => m.lineTotal({ unitPriceCents: 250, quantity: 3, taxable: true }) === 750],
          ['subtotal combines lines', () => m.subtotal([{ unitPriceCents: 250, quantity: 2, taxable: true }, { unitPriceCents: 125, quantity: 4, taxable: false }]) === 1000],
          ['tax and shipping use integer cents', () => m.total([{ unitPriceCents: 1000, quantity: 1, taxable: true }]) === 1682],
          ['threshold equality ships free', () => m.total([{ unitPriceCents: 5000, quantity: 1, taxable: false }]) === 5000],
          ['discount affects threshold and tax', () => m.total([{ unitPriceCents: 2500, quantity: 2, taxable: true }], 10) === 5470],
          ['negative price rejected', () => throws(() => m.total([{ unitPriceCents: -1, quantity: 1, taxable: true }]))],
        ]),
        hidden: runCases([
          ['non-taxable merchandise stays exempt', () => m.total([{ unitPriceCents: 1000, quantity: 1, taxable: false }]) === 1599],
          ['mixed tax allocation rounds correctly', () => m.total([{ unitPriceCents: 999, quantity: 1, taxable: true }, { unitPriceCents: 501, quantity: 1, taxable: false }], 12.5) === 1983],
          ['post-discount subtotal controls shipping', () => m.total([{ unitPriceCents: 5200, quantity: 1, taxable: false }], 5) === 5539],
          ['tax rounds to nearest cent', () => m.total([{ unitPriceCents: 101, quantity: 1, taxable: true }]) === 708],
          ['100 percent discount remains zero plus shipping', () => m.total([{ unitPriceCents: 8000, quantity: 1, taxable: true }], 100) === 599],
          ['invalid quantities rejected', () => throws(() => m.total([{ unitPriceCents: 10, quantity: 0, taxable: true }])) && throws(() => m.total([{ unitPriceCents: 10, quantity: 1.5, taxable: true }]))],
          ['invalid discounts rejected', () => throws(() => m.total([], -1)) && throws(() => m.total([], 101)) && throws(() => m.total([], NaN))],
          ['inputs are not mutated', () => { const items = [{ unitPriceCents: 100, quantity: 2, taxable: true }]; const before = JSON.stringify(items); m.total(items, 10); return JSON.stringify(items) === before; }],
        ]),
      };
    },
  },

  feature: {
    version: 3,
    title: 'Atomic checkout with payment rollback',
    promptFile: 'prompts/feature.txt',
    targetFiles: ['inventory.js', 'orders.js'],
    protectedFiles: ['test.js', 'package.json'],
    allowedFiles: ['inventory.js', 'orders.js'],
    efficiencyBudget: { toolCalls: 26, generatedTokens: 8000, wallTimeMs: 300000 },
    files: {
      'package.json': `{"name":"brittain-bench-feature","private":true,"scripts":{"test":"node test.js"}}\n`,
      'inventory.js': `class Inventory {
  constructor(stock = {}) { this.stock = { ...stock }; }
  available(sku) { return this.stock[sku] || 0; }
  reserveBatch(lines) {
    for (const line of lines) {
      if (line.quantity <= 0) throw new Error('quantity must be positive');
      if (this.available(line.sku) < line.quantity) throw new Error('insufficient stock: ' + line.sku);
      this.stock[line.sku] -= line.quantity; // BUG: later failures leave earlier mutations
    }
    return lines.map((line) => ({ ...line }));
  }
  releaseBatch(lines) {
    for (const line of lines) this.stock[line.sku] = this.available(line.sku) + line.quantity;
  }
}
module.exports = { Inventory };\n`,
      'orders.js': `function placeOrder(inventory, lines, prices, charge) {
  const reserved = inventory.reserveBatch(lines);
  let totalCents = 0;
  for (const line of lines) totalCents += prices[line.sku] * line.quantity;
  const paymentId = charge(totalCents); // BUG: a declined payment keeps the reservation
  return { totalCents, paymentId, lines };
}
module.exports = { placeOrder };\n`,
      'test.js': `const assert = require('assert');
const { Inventory } = require('./inventory'); const { placeOrder } = require('./orders');
let pass = 0; function test(fn) { try { fn(); pass++; } catch {} }
test(() => { const i = new Inventory({ a: 5 }); const r = placeOrder(i, [{ sku:'a', quantity:2 }], { a:125 }, () => 'pay-1'); assert.strictEqual(r.totalCents, 250); assert.strictEqual(r.paymentId, 'pay-1'); assert.strictEqual(i.available('a'), 3); });
test(() => { const i = new Inventory({ a: 5, b: 1 }); assert.throws(() => placeOrder(i, [{ sku:'a', quantity:2 }, { sku:'b', quantity:2 }], { a:100, b:100 }, () => 'x')); assert.deepStrictEqual(i.stock, { a:5, b:1 }); });
test(() => { const i = new Inventory({ a: 5 }); assert.throws(() => placeOrder(i, [{ sku:'a', quantity:2 }], { a:100 }, () => { throw new Error('declined'); })); assert.strictEqual(i.available('a'), 5); });
test(() => { const i = new Inventory({ a: 5 }); placeOrder(i, [{ sku:'a', quantity:2 }, { sku:'a', quantity:2 }], { a:100 }, () => 'x'); assert.strictEqual(i.available('a'), 1); });
console.log(pass + '/4 passed.'); process.exit(pass === 4 ? 0 : 1);\n`,
    },
    evaluate(dir) {
      const { Inventory } = load(dir, 'inventory.js');
      const { placeOrder } = load(dir, 'orders.js');
      return {
        visible: runCases([
          ['places and charges simple order', () => { const i = new Inventory({ a: 5 }); const r = placeOrder(i, [{ sku: 'a', quantity: 2 }], { a: 125 }, () => 'pay-1'); return r.totalCents === 250 && r.paymentId === 'pay-1' && i.available('a') === 3; }],
          ['stock failure is atomic', () => { const i = new Inventory({ a: 5, b: 1 }); try { placeOrder(i, [{ sku: 'a', quantity: 2 }, { sku: 'b', quantity: 2 }], { a: 100, b: 100 }, () => 'x'); } catch {} return i.available('a') === 5 && i.available('b') === 1; }],
          ['payment failure releases stock', () => { const i = new Inventory({ a: 5 }); try { placeOrder(i, [{ sku: 'a', quantity: 2 }], { a: 100 }, () => { throw new Error('declined'); }); } catch {} return i.available('a') === 5; }],
          ['duplicate demand is aggregated', () => { const i = new Inventory({ a: 5 }); placeOrder(i, [{ sku: 'a', quantity: 2 }, { sku: 'a', quantity: 2 }], { a: 100 }, () => 'x'); return i.available('a') === 1; }],
        ]),
        hidden: runCases([
          ['zero and fractional quantities do not mutate', () => { const i = new Inventory({ a: 3 }); const a = throws(() => placeOrder(i, [{ sku: 'a', quantity: 0 }], { a: 50 }, () => 'x')); const b = throws(() => placeOrder(i, [{ sku: 'a', quantity: 1.5 }], { a: 50 }, () => 'x')); return a && b && i.available('a') === 3; }],
          ['unknown sku does not create stock', () => { const i = new Inventory({ a: 3 }); return throws(() => i.reserveBatch([{ sku: 'missing', quantity: 1 }])) && !Object.prototype.hasOwnProperty.call(i.stock, 'missing'); }],
          ['missing price rejected before reservation', () => { const i = new Inventory({ a: 3 }); return throws(() => placeOrder(i, [{ sku: 'a', quantity: 1 }], {}, () => 'x')) && i.available('a') === 3; }],
          ['invalid cent price rejected before reservation', () => { const i = new Inventory({ a: 3 }); return throws(() => placeOrder(i, [{ sku: 'a', quantity: 1 }], { a: 1.5 }, () => 'x')) && i.available('a') === 3; }],
          ['charge called once after reservation', () => { const i = new Inventory({ a: 3 }); let calls = 0; let stockAtCharge; placeOrder(i, [{ sku: 'a', quantity: 2 }], { a: 199 }, (amount) => { calls++; stockAtCharge = i.available('a'); return amount === 398 ? 'ok' : 'bad'; }); return calls === 1 && stockAtCharge === 1; }],
          ['decline error is preserved', () => { const i = new Inventory({ a: 2 }); try { placeOrder(i, [{ sku: 'a', quantity: 1 }], { a: 1 }, () => { throw new Error('card declined'); }); } catch (err) { return err.message === 'card declined' && i.available('a') === 2; } return false; }],
          ['receipt is detached from caller input', () => { const lines = [{ sku: 'a', quantity: 1 }]; const i = new Inventory({ a: 2 }); const r = placeOrder(i, lines, { a: 99 }, () => 'x'); lines[0].quantity = 9; return r.lines !== lines && r.lines[0].quantity === 1; }],
          ['reserveBatch return is normalized and detached', () => { const lines = [{ sku: 'a', quantity: 1 }, { sku: 'a', quantity: 2 }]; const i = new Inventory({ a: 4 }); const reserved = i.reserveBatch(lines); lines[0].quantity = 9; return reserved.length === 1 && reserved[0].sku === 'a' && reserved[0].quantity === 3 && i.available('a') === 1; }],
        ]),
      };
    },
  },

  debug: {
    version: 3,
    title: 'Tenant cache isolation bug with green tests',
    promptFile: 'prompts/debug.txt',
    targetFiles: ['cache.js'],
    protectedFiles: ['test.js', 'package.json'],
    allowedFiles: ['cache.js'],
    efficiencyBudget: { toolCalls: 16, generatedTokens: 5500, wallTimeMs: 210000 },
    files: {
      'package.json': `{"name":"brittain-bench-debug","private":true,"scripts":{"test":"node test.js"}}\n`,
      'cache.js': `class TenantCache {
  constructor(now = () => Date.now()) { this.now = now; this.values = new Map(); }
  cacheKey(_tenant, key) { return key.trim().toLowerCase(); } // BUG: tenant and exact key identity discarded
  set(tenant, key, value, ttlSeconds) {
    this.values.set(this.cacheKey(tenant, key), { value, expiresAt: this.now() + ttlSeconds });
  }
  get(tenant, key) {
    const cacheKey = this.cacheKey(tenant, key);
    const item = this.values.get(cacheKey);
    if (!item || !item.value) return undefined; // BUG: false, zero, and empty string look absent
    if (this.now() >= item.expiresAt) { this.values.delete(cacheKey); return undefined; }
    return item.value;
  }
  has(tenant, key) { return this.get(tenant, key) !== undefined; }
}
module.exports = { TenantCache };\n`,
      'test.js': `const assert = require('assert'); const { TenantCache } = require('./cache');
let now = 1000; const c = new TenantCache(() => now); c.set('tenant-a', 'user-1', 42, 10);
assert.strictEqual(c.get('tenant-a', 'user-1'), 42); now += 5; assert.strictEqual(c.get('tenant-a', 'user-1'), 42);
assert.strictEqual(c.has('tenant-a', 'missing'), false); console.log('3/3 passed.');\n`,
    },
    evaluate(dir) {
      const { TenantCache } = load(dir, 'cache.js');
      return {
        visible: runCases([
          ['immediate read', () => { let now = 1000; const c = new TenantCache(() => now); c.set('tenant-a', 'user-1', 42, 10); return c.get('tenant-a', 'user-1') === 42; }],
          ['short millisecond advance', () => { let now = 1000; const c = new TenantCache(() => now); c.set('tenant-a', 'user-1', 42, 10); now += 5; return c.get('tenant-a', 'user-1') === 42; }],
          ['missing key absent', () => new TenantCache(() => 0).has('tenant-a', 'missing') === false],
        ]),
        hidden: runCases([
          ['tenants are isolated', () => { const c = new TenantCache(() => 0); c.set('a', 'user', 'A', 10); c.set('b', 'user', 'B', 10); return c.get('a', 'user') === 'A' && c.get('b', 'user') === 'B'; }],
          ['delimiter-like identifiers cannot collide', () => { const c = new TenantCache(() => 0); c.set('a:b', 'c', 1, 10); c.set('a', 'b:c', 2, 10); return c.get('a:b', 'c') === 1 && c.get('a', 'b:c') === 2; }],
          ['key identity preserves case and whitespace', () => { const c = new TenantCache(() => 0); c.set('a', 'User', 1, 10); c.set('a', 'user', 2, 10); c.set('a', ' user', 3, 10); return c.get('a', 'User') === 1 && c.get('a', 'user') === 2 && c.get('a', ' user') === 3; }],
          ['falsy values remain cached', () => { const c = new TenantCache(() => 0); c.set('a', 'zero', 0, 10); c.set('a', 'false', false, 10); c.set('a', 'empty', '', 10); return c.has('a', 'zero') && c.get('a', 'zero') === 0 && c.get('a', 'false') === false && c.get('a', 'empty') === ''; }],
          ['ttl is measured in seconds', () => { let now = 100; const c = new TenantCache(() => now); c.set('a', 'x', 1, 10); now += 9999; const before = c.get('a', 'x'); now += 1; return before === 1 && c.get('a', 'x') === undefined; }],
          ['zero ttl expires immediately', () => { const c = new TenantCache(() => 5); c.set('a', 'x', 1, 0); return c.get('a', 'x') === undefined && !c.has('a', 'x'); }],
          ['expired values are removed', () => { let now = 0; const c = new TenantCache(() => now); c.set('a', 'x', 1, 1); now = 1000; c.get('a', 'x'); return c.values.size === 0; }],
          ['invalid identifiers and ttl rejected', () => { const c = new TenantCache(() => 0); return throws(() => c.set('', 'x', 1, 1)) && throws(() => c.set('a', '', 1, 1)) && throws(() => c.set('a', 'x', 1, -1)) && throws(() => c.set('a', 'x', 1, Infinity)); }],
        ]),
      };
    },
  },

  economy: {
    version: 3,
    title: 'Deterministic economy with snapshot and resume',
    promptFile: 'prompts/economy.txt',
    targetFiles: ['rng.js', 'ledger.js', 'economy.js'],
    protectedFiles: ['test.js', 'package.json'],
    allowedFiles: ['rng.js', 'ledger.js', 'economy.js'],
    efficiencyBudget: { toolCalls: 36, generatedTokens: 12000, wallTimeMs: 600000 },
    files: {
      'package.json': `{"name":"brittain-bench-economy","private":true,"scripts":{"test":"node test.js"}}\n`,
      'rng.js': `function createRng(seed, state = seed >>> 0) {
  let value = state >>> 0;
  return {
    next() { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 0x100000000; },
    snapshot() { return value; },
  };
}
module.exports = { createRng };\n`,
      'ledger.js': `class Ledger {
  constructor(balances) { this.balances = { ...balances }; }
  available(id) { return this.balances[id] || 0; }
  transfer(from, to, cents) {
    this.balances[from] -= cents; // BUG: invalid transfers can corrupt or create balances
    this.balances[to] += cents;
  }
  total() { return Object.values(this.balances).reduce((a, b) => a + b, 0); }
}
module.exports = { Ledger };\n`,
      'economy.js': `const { createRng } = require('./rng'); const { Ledger } = require('./ledger');

function simulate(options) {
  const { seed, ticks, households, firms } = options;
  const rng = createRng(seed); const balances = {};
  for (let i = 0; i < households; i++) balances['h' + i] = 10000;
  for (let i = 0; i < firms; i++) balances['f' + i] = 20000;
  const ledger = new Ledger(balances); const initialMoney = ledger.total(); const metrics = [];
  for (let tick = 0; tick < ticks; tick++) {
    let transfers = 0;
    for (let h = 0; h < households; h++) { const amount = Math.min(ledger.available('h' + h), 25 + Math.floor(rng.next() * 176)); ledger.transfer('h' + h, 'f' + Math.floor(rng.next() * firms), amount); transfers++; }
    for (let f = 0; f < firms; f++) { const amount = Math.min(ledger.available('f' + f), 50 + Math.floor(rng.next() * 151)); ledger.transfer('f' + f, 'h' + Math.floor(rng.next() * households), amount); transfers++; }
    const values = Object.values(ledger.balances); metrics.push({ tick, totalMoney: ledger.total(), minBalance: Math.min(...values), maxBalance: Math.max(...values), transfers });
  }
  return { seed, tick: ticks, initialMoney, finalMoney: ledger.total(), accounts: Object.entries(ledger.balances).map(([id, balance]) => ({ id, balance })), metrics, rngState: rng.snapshot() };
}

function resume() { throw new Error('TODO: resume snapshots'); }
module.exports = { simulate, resume };\n`,
      'test.js': `const assert = require('assert'); const { simulate, resume } = require('./economy');
const options = { seed: 7, ticks: 20, households: 4, firms: 2 }; const a = simulate(options); const b = simulate(options);
assert.deepStrictEqual(a, b); assert.strictEqual(a.metrics.length, 20); assert.strictEqual(a.initialMoney, a.finalMoney);
assert.ok(a.accounts.every((x) => Number.isSafeInteger(x.balance) && x.balance >= 0));
const split = resume(simulate({ ...options, ticks: 8 }), 12); assert.deepStrictEqual(split, a);
console.log('5/5 passed.');\n`,
    },
    evaluate(dir) {
      const { createRng } = load(dir, 'rng.js');
      const { Ledger } = load(dir, 'ledger.js');
      const { simulate, resume } = load(dir, 'economy.js');
      const base = { seed: 7, ticks: 20, households: 4, firms: 2 };
      return {
        visible: runCases([
          ['deterministic replay', () => JSON.stringify(simulate(base)) === JSON.stringify(simulate(base))],
          ['one metric per tick', () => simulate(base).metrics.length === 20],
          ['money conserved', () => { const r = simulate(base); return r.initialMoney === r.finalMoney; }],
          ['balances are nonnegative integer cents', () => simulate(base).accounts.every((a) => Number.isSafeInteger(a.balance) && a.balance >= 0)],
          ['split run equals continuous run', () => JSON.stringify(resume(simulate({ ...base, ticks: 8 }), 12)) === JSON.stringify(simulate(base))],
        ]),
        hidden: runCases([
          ['rng snapshot resumes exact stream', () => { const a = createRng(123); a.next(); const state = a.snapshot(); const expected = [a.next(), a.next()]; const b = createRng(123, state); return JSON.stringify([b.next(), b.next()]) === JSON.stringify(expected); }],
          ['different seeds differ', () => JSON.stringify(simulate({ seed: 1, ticks: 5, households: 3, firms: 2 })) !== JSON.stringify(simulate({ seed: 2, ticks: 5, households: 3, firms: 2 }))],
          ['zero ticks supported', () => { const r = simulate({ seed: 1, ticks: 0, households: 2, firms: 1 }); return r.tick === 0 && r.metrics.length === 0 && r.initialMoney === r.finalMoney; }],
          ['multi-stage resume is associative', () => { const o = { seed: 9, ticks: 30, households: 5, firms: 3 }; const split = resume(resume(simulate({ ...o, ticks: 5 }), 7), 18); return JSON.stringify(split) === JSON.stringify(simulate(o)); }],
          ['long run remains stable', () => { const r = simulate({ seed: 99, ticks: 1000, households: 10, firms: 3 }); return r.initialMoney === r.finalMoney && r.accounts.every((a) => Number.isSafeInteger(a.balance) && a.balance >= 0) && r.metrics.every((m) => Object.values(m).every(Number.isSafeInteger)); }],
          ['account count and ids are stable', () => { const r = simulate({ seed: 4, ticks: 2, households: 3, firms: 2 }); return JSON.stringify(r.accounts.map((a) => a.id)) === JSON.stringify(['h0', 'h1', 'h2', 'f0', 'f1']); }],
          ['options and snapshots are not mutated', () => { const o = { seed: 4, ticks: 3, households: 2, firms: 1 }; const before = JSON.stringify(o); const snap = simulate(o); const snapBefore = JSON.stringify(snap); resume(snap, 2); return JSON.stringify(o) === before && JSON.stringify(snap) === snapBefore; }],
          ['invalid simulation inputs rejected', () => throws(() => simulate({ seed: 1, ticks: -1, households: 2, firms: 1 })) && throws(() => simulate({ seed: 1, ticks: 1.5, households: 2, firms: 1 })) && throws(() => simulate({ seed: 1, ticks: 1, households: 0, firms: 1 }))],
          ['ledger invalid transfers are atomic', () => { const l = new Ledger({ a: 10, b: 2 }); const before = JSON.stringify(l.balances); const rejected = throws(() => l.transfer('a', 'b', 11)) && throws(() => l.transfer('missing', 'b', 1)) && throws(() => l.transfer('a', 'b', 1.5)); return rejected && JSON.stringify(l.balances) === before; }],
          ['ledger valid transfer conserves funds', () => { const l = new Ledger({ a: 10, b: 2 }); l.transfer('a', 'b', 4); return l.available('a') === 6 && l.available('b') === 6 && l.total() === 12; }],
        ]),
      };
    },
  },

  outbox: {
    version: 1,
    title: 'Durable retry outbox and worker',
    promptFile: 'prompts/outbox.txt',
    targetFiles: ['outbox.js', 'worker.js'],
    protectedFiles: ['test.js', 'package.json'],
    allowedFiles: ['outbox.js', 'worker.js'],
    efficiencyBudget: { toolCalls: 32, generatedTokens: 10000, wallTimeMs: 480000 },
    files: {
      'package.json': `{"name":"brittain-bench-outbox","private":true,"scripts":{"test":"node test.js"}}\n`,
      'outbox.js': `class Outbox {
  constructor(options = {}) {
    this.baseDelayMs = options.baseDelayMs || 1000; this.maxDelayMs = options.maxDelayMs || 60000; this.maxAttempts = options.maxAttempts || 4;
    this.jobs = []; this.deadLetters = []; this.nextSequence = 0;
  }
  enqueue(id, payload, now = 0) {
    const job = { id, payload, attempts: 0, nextAttemptAt: now, sequence: this.nextSequence++ };
    const existing = this.jobs.findIndex((x) => x.id === id);
    if (existing >= 0) this.jobs[existing] = job; else this.jobs.push(job); // BUG: duplicate silently overwrites and payload aliases caller
    return job;
  }
  due(now) { return this.jobs.filter((job) => job.nextAttemptAt <= now); }
  markSucceeded(id) { this.jobs = this.jobs.filter((job) => job.id !== id); }
  markFailed(id, now, error) {
    const job = this.jobs.find((x) => x.id === id); job.attempts++;
    job.nextAttemptAt = now + this.baseDelayMs * job.attempts; // BUG: linear and uncapped
    if (job.attempts > this.maxAttempts) { this.markSucceeded(id); this.deadLetters.push({ ...job, error: String(error) }); }
  }
  snapshot() { return { config: { baseDelayMs: this.baseDelayMs, maxDelayMs: this.maxDelayMs, maxAttempts: this.maxAttempts }, jobs: this.jobs, deadLetters: this.deadLetters, nextSequence: this.nextSequence }; }
  static fromSnapshot(snapshot) { const box = new Outbox(snapshot.config); Object.assign(box, snapshot); return box; }
}
module.exports = { Outbox };\n`,
      'worker.js': `function drainDue(outbox, now, deliver) {
  const result = { delivered: [], failed: [], deadLettered: [] };
  for (const job of outbox.due(now)) {
    try { deliver(job.payload, job.id); outbox.markSucceeded(job.id); result.delivered.push(job.id); }
    catch (err) { outbox.markFailed(job.id, now, err); result.failed.push(job.id); throw err; } // BUG: one failure stops the batch
  }
  return result;
}
module.exports = { drainDue };\n`,
      'test.js': `const assert = require('assert'); const { Outbox } = require('./outbox'); const { drainDue } = require('./worker');
const box = new Outbox({ baseDelayMs: 100, maxDelayMs: 250, maxAttempts: 3 }); box.enqueue('a', { n: 1 }, 10); box.enqueue('b', { n: 2 }, 10);
const first = drainDue(box, 10, (_payload, id) => { if (id === 'a') throw new Error('offline'); });
assert.deepStrictEqual(first, { delivered:['b'], failed:['a'], deadLettered:[] }); assert.strictEqual(box.jobs[0].nextAttemptAt, 110);
const restored = Outbox.fromSnapshot(box.snapshot()); assert.deepStrictEqual(restored.snapshot(), box.snapshot());
assert.throws(() => restored.enqueue('a', { n: 9 }, 20)); console.log('4/4 passed.');\n`,
    },
    evaluate(dir) {
      const { Outbox } = load(dir, 'outbox.js');
      const { drainDue } = load(dir, 'worker.js');
      return {
        visible: runCases([
          ['worker continues after a failure', () => { const b = new Outbox({ baseDelayMs: 100, maxDelayMs: 250, maxAttempts: 3 }); b.enqueue('a', { n: 1 }, 10); b.enqueue('b', { n: 2 }, 10); const r = drainDue(b, 10, (_p, id) => { if (id === 'a') throw new Error('offline'); }); return JSON.stringify(r) === JSON.stringify({ delivered: ['b'], failed: ['a'], deadLettered: [] }); }],
          ['first retry uses base delay', () => { const b = new Outbox({ baseDelayMs: 100, maxDelayMs: 250, maxAttempts: 3 }); b.enqueue('a', {}, 10); drainDue(b, 10, () => { throw new Error('x'); }); return b.jobs[0].attempts === 1 && b.jobs[0].nextAttemptAt === 110; }],
          ['snapshot round trips', () => { const b = new Outbox({ baseDelayMs: 100, maxDelayMs: 250, maxAttempts: 3 }); b.enqueue('a', { n: 1 }, 10); const restored = Outbox.fromSnapshot(b.snapshot()); return JSON.stringify(restored.snapshot()) === JSON.stringify(b.snapshot()); }],
          ['duplicate pending id rejected', () => { const b = new Outbox(); b.enqueue('a', { n: 1 }, 0); return throws(() => b.enqueue('a', { n: 2 }, 1)) && b.jobs.length === 1 && b.jobs[0].payload.n === 1; }],
        ]),
        hidden: runCases([
          ['due ordering is time then FIFO', () => { const b = new Outbox(); b.enqueue('late', {}, 20); b.enqueue('first', {}, 10); b.enqueue('second', {}, 10); return JSON.stringify(b.due(20).map((j) => j.id)) === JSON.stringify(['first', 'second', 'late']); }],
          ['due and enqueue results are detached', () => { const payload = { nested: { n: 1 } }; const b = new Outbox(); const returned = b.enqueue('a', payload, 0); payload.nested.n = 9; returned.payload.nested.n = 8; const due = b.due(0); due[0].payload.nested.n = 7; return b.jobs[0].payload.nested.n === 1; }],
          ['exponential backoff is capped', () => { const b = new Outbox({ baseDelayMs: 100, maxDelayMs: 250, maxAttempts: 5 }); b.enqueue('a', {}, 0); b.markFailed('a', 0, 'x'); b.markFailed('a', 100, 'x'); b.markFailed('a', 300, 'x'); b.markFailed('a', 550, 'x'); return b.jobs[0].nextAttemptAt === 800; }],
          ['dead letters exactly at max attempts', () => { const b = new Outbox({ baseDelayMs: 10, maxDelayMs: 100, maxAttempts: 2 }); b.enqueue('a', {}, 0); let r = drainDue(b, 0, () => { throw new Error('nope'); }); r = drainDue(b, 10, () => { throw new Error('nope'); }); return b.jobs.length === 0 && b.deadLetters.length === 1 && r.deadLettered[0] === 'a' && r.failed[0] === 'a' && b.deadLetters[0].attempts === 2; }],
          ['not-yet-due work is untouched', () => { const b = new Outbox(); b.enqueue('a', {}, 100); let calls = 0; const r = drainDue(b, 99, () => calls++); return calls === 0 && b.jobs.length === 1 && r.delivered.length === 0; }],
          ['successful id can be reused', () => { const b = new Outbox(); b.enqueue('a', {}, 0); drainDue(b, 0, () => {}); b.enqueue('a', { second: true }, 1); return b.jobs.length === 1 && b.jobs[0].payload.second === true; }],
          ['snapshot and restored box do not alias', () => { const b = new Outbox(); b.enqueue('a', { n: 1 }, 0); const snap = b.snapshot(); const before = JSON.stringify(snap); const restored = Outbox.fromSnapshot(snap); restored.jobs[0].payload.n = 9; restored.enqueue('b', {}, 0); return JSON.stringify(snap) === before && b.jobs.length === 1; }],
          ['invalid enqueue and config rejected atomically', () => { const b = new Outbox(); return throws(() => b.enqueue('', {}, 0)) && throws(() => b.enqueue('a', {}, NaN)) && b.jobs.length === 0 && throws(() => new Outbox({ baseDelayMs: 0 })) && throws(() => new Outbox({ maxAttempts: 1.5 })); }],
          ['invalid snapshots rejected', () => throws(() => Outbox.fromSnapshot({ config: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 2 }, jobs: [{ id: 'a' }, { id: 'a' }], deadLetters: [], nextSequence: 2 }))],
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
