const path = require('path');
const cp = require('child_process');

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

function jsonClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function runTsEvaluation(dir, body) {
  const output = cp.execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', body], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
  return JSON.parse(output || '{}');
}

function runPythonEvaluation(dir, body) {
  const output = cp.execFileSync('python3', ['-c', body], {
    cwd: dir,
    encoding: 'utf8',
  }).trim();
  return JSON.parse(output || '{}');
}

const TASKS = {
  cart: {
    version: 4,
    title: 'Checkout rounding and validation repair',
    language: 'javascript',
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
    language: 'javascript',
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
    language: 'javascript',
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
    language: 'javascript',
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
    version: 2,
    title: 'Leased durable outbox with recovery and replay safety',
    language: 'javascript',
    promptFile: 'prompts/outbox.txt',
    targetFiles: ['outbox.js', 'worker.js'],
    protectedFiles: ['test.js', 'package.json'],
    allowedFiles: ['outbox.js', 'worker.js'],
    efficiencyBudget: { toolCalls: 36, generatedTokens: 12000, wallTimeMs: 540000 },
    files: {
      'package.json': `{"name":"brittain-bench-outbox","private":true,"scripts":{"test":"node test.js"}}\n`,
      'outbox.js': `class Outbox {
  constructor(options = {}) {
    this.baseDelayMs = options.baseDelayMs || 1000;
    this.maxDelayMs = options.maxDelayMs || 60000;
    this.maxAttempts = options.maxAttempts || 4;
    this.leaseMs = options.leaseMs || 30000;
    this.pending = [];
    this.inFlight = [];
    this.deadLetters = [];
    this.nextSequence = 0;
  }

  enqueue(id, payload, now = 0) {
    const job = { id, payload, attempts: 0, nextAttemptAt: now, sequence: this.nextSequence++ };
    const existing = this.pending.findIndex((x) => x.id === id);
    if (existing >= 0) this.pending[existing] = job; else this.pending.push(job); // BUG: silently overwrites pending work and aliases payload
    return job;
  }

  claimDue(now, workerId, limit = Infinity) {
    const due = this.pending
      .filter((job) => job.nextAttemptAt <= now)
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.sequence - b.sequence)
      .slice(0, limit);
    for (const job of due) {
      job.leaseOwner = workerId;
      job.leaseExpiresAt = now + this.leaseMs;
      this.inFlight.push(job);
    }
    this.pending = this.pending.filter((job) => !due.includes(job));
    return due;
  }

  reapExpiredClaims(_now) {
    return []; // BUG: restart recovery and expired claims are ignored
  }

  markDelivered(id) {
    this.inFlight = this.inFlight.filter((job) => job.id !== id);
  }

  markFailed(id, _workerId, now, error) {
    const job = this.inFlight.find((item) => item.id === id);
    if (!job) throw new Error('unknown job');
    this.inFlight = this.inFlight.filter((item) => item !== job);
    job.attempts += 1;
    job.nextAttemptAt = now + this.baseDelayMs * job.attempts; // BUG: linear and uncapped
    delete job.leaseOwner;
    delete job.leaseExpiresAt;
    if (job.attempts > this.maxAttempts) {
      this.deadLetters.push({ ...job, lastError: String(error) }); // BUG: wrong boundary
      return 'dead-lettered';
    }
    this.pending.push(job);
    return 'retrying';
  }

  snapshot() {
    return {
      config: {
        baseDelayMs: this.baseDelayMs,
        maxDelayMs: this.maxDelayMs,
        maxAttempts: this.maxAttempts,
        leaseMs: this.leaseMs,
      },
      pending: this.pending,
      inFlight: this.inFlight,
      deadLetters: this.deadLetters,
      nextSequence: this.nextSequence,
    };
  }

  static fromSnapshot(snapshot) {
    const box = new Outbox(snapshot.config);
    Object.assign(box, snapshot);
    return box;
  }
}

module.exports = { Outbox };\n`,
      'worker.js': `function drainDue(outbox, now, workerId, deliver, limit = Infinity) {
  const result = { delivered: [], failed: [], deadLettered: [] };
  for (const job of outbox.claimDue(now, workerId, limit)) {
    try {
      deliver(job.payload, job.id);
      outbox.markDelivered(job.id, workerId);
      result.delivered.push(job.id);
    } catch (err) {
      const status = outbox.markFailed(job.id, workerId, now, err);
      result.failed.push(job.id);
      if (status === 'dead-lettered') result.deadLettered.push(job.id);
      throw err; // BUG: one failure aborts the rest of the due-at-start batch
    }
  }
  return result;
}

module.exports = { drainDue };\n`,
      'test.js': `const assert = require('assert');
const { Outbox } = require('./outbox');
const { drainDue } = require('./worker');

const box = new Outbox({ baseDelayMs: 100, maxDelayMs: 250, maxAttempts: 3, leaseMs: 50 });
box.enqueue('a', { n: 1 }, 10);
box.enqueue('b', { n: 2 }, 10);
const first = drainDue(box, 10, 'worker-1', (_payload, id) => { if (id === 'a') throw new Error('offline'); });
assert.deepStrictEqual(first, { delivered: ['b'], failed: ['a'], deadLettered: [] });
assert.strictEqual(box.pending[0].nextAttemptAt, 110);
const leased = box.claimDue(110, 'worker-2');
assert.deepStrictEqual(leased.map((job) => job.id), ['a']);
const restored = Outbox.fromSnapshot(box.snapshot());
assert.deepStrictEqual(restored.snapshot(), box.snapshot());
console.log('4/4 passed.');\n`,
    },
    evaluate(dir) {
      const { Outbox } = load(dir, 'outbox.js');
      const { drainDue } = load(dir, 'worker.js');
      return {
        visible: runCases([
          ['worker continues after a failure', () => {
            const b = new Outbox({ baseDelayMs: 100, maxDelayMs: 250, maxAttempts: 3, leaseMs: 50 });
            b.enqueue('a', { n: 1 }, 10);
            b.enqueue('b', { n: 2 }, 10);
            const r = drainDue(b, 10, 'worker-1', (_p, id) => { if (id === 'a') throw new Error('offline'); });
            return JSON.stringify(r) === JSON.stringify({ delivered: ['b'], failed: ['a'], deadLettered: [] });
          }],
          ['first retry uses base delay', () => {
            const b = new Outbox({ baseDelayMs: 100, maxDelayMs: 250, maxAttempts: 3, leaseMs: 50 });
            b.enqueue('a', {}, 10);
            drainDue(b, 10, 'worker-1', () => { throw new Error('x'); });
            return b.pending[0].attempts === 1 && b.pending[0].nextAttemptAt === 110;
          }],
          ['claimDue leases due work in order', () => {
            const b = new Outbox({ leaseMs: 40 });
            b.enqueue('late', {}, 20);
            b.enqueue('first', {}, 10);
            b.enqueue('second', {}, 10);
            const due = b.claimDue(20, 'worker-1');
            return JSON.stringify(due.map((j) => j.id)) === JSON.stringify(['first', 'second', 'late']) && b.inFlight.length === 3;
          }],
          ['snapshot round trips', () => {
            const b = new Outbox({ baseDelayMs: 100, maxDelayMs: 250, maxAttempts: 3, leaseMs: 50 });
            b.enqueue('a', { n: 1 }, 10);
            const restored = Outbox.fromSnapshot(b.snapshot());
            return JSON.stringify(restored.snapshot()) === JSON.stringify(b.snapshot());
          }],
          ['expired leases are recoverable', () => {
            const b = new Outbox({ leaseMs: 25 });
            b.enqueue('a', {}, 0);
            b.claimDue(0, 'worker-1');
            const recovered = b.reapExpiredClaims(26);
            return recovered.length === 1 && recovered[0].id === 'a' && b.pending.length === 1 && b.inFlight.length === 0;
          }],
        ]),
        hidden: runCases([
          ['enqueue rejects duplicates across pending and in-flight without mutation', () => {
            const payload = { nested: { n: 1 } };
            const b = new Outbox();
            b.enqueue('a', payload, 0);
            payload.nested.n = 9;
            b.claimDue(0, 'worker-1');
            return throws(() => b.enqueue('a', {}, 1)) && b.inFlight.length === 1 && b.inFlight[0].payload.nested.n === 1;
          }],
          ['returned jobs are detached', () => {
            const b = new Outbox();
            const original = { nested: { v: 1 } };
            const enqueued = b.enqueue('a', original, 0);
            enqueued.payload.nested.v = 7;
            const claimed = b.claimDue(0, 'worker-1');
            claimed[0].payload.nested.v = 8;
            return b.inFlight[0].payload.nested.v === 1;
          }],
          ['backoff is exponential and capped', () => {
            const b = new Outbox({ baseDelayMs: 100, maxDelayMs: 250, maxAttempts: 5, leaseMs: 20 });
            b.enqueue('a', {}, 0);
            b.claimDue(0, 'worker-1');
            b.markFailed('a', 'worker-1', 0, 'x');
            b.claimDue(100, 'worker-1');
            b.markFailed('a', 'worker-1', 100, 'x');
            b.claimDue(300, 'worker-1');
            b.markFailed('a', 'worker-1', 300, 'x');
            return b.pending[0].nextAttemptAt === 550;
          }],
          ['dead letters happen exactly at maxAttempts with last error text', () => {
            const b = new Outbox({ baseDelayMs: 10, maxDelayMs: 100, maxAttempts: 2, leaseMs: 10 });
            b.enqueue('a', {}, 0);
            let r = drainDue(b, 0, 'worker-1', () => { throw new Error('nope-1'); });
            r = drainDue(b, 10, 'worker-1', () => { throw new Error('nope-2'); });
            return b.pending.length === 0 && b.inFlight.length === 0 && b.deadLetters.length === 1 && r.deadLettered[0] === 'a' && r.failed[0] === 'a' && b.deadLetters[0].attempts === 2 && b.deadLetters[0].lastError === 'Error: nope-2';
          }],
          ['successful ids can be reused after delivery', () => {
            const b = new Outbox();
            b.enqueue('a', {}, 0);
            drainDue(b, 0, 'worker-1', () => {});
            b.enqueue('a', { second: true }, 1);
            return b.pending.length === 1 && b.pending[0].payload.second === true;
          }],
          ['markDelivered and markFailed require ownership', () => {
            const b = new Outbox({ leaseMs: 10 });
            b.enqueue('a', {}, 0);
            b.claimDue(0, 'worker-1');
            return throws(() => b.markFailed('a', 'worker-2', 0, 'x')) && throws(() => b.markDelivered('a', 'worker-2'));
          }],
          ['fromSnapshot rejects malformed snapshots atomically', () => throws(() => Outbox.fromSnapshot({ config: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 2, leaseMs: 1 }, pending: [{ id: 'a', payload: {}, attempts: 0, nextAttemptAt: 0, sequence: 0 }], inFlight: [{ id: 'a', payload: {}, attempts: 0, nextAttemptAt: 0, sequence: 1, leaseOwner: 'w', leaseExpiresAt: 2 }], deadLetters: [], nextSequence: 2 }))],
          ['reapExpiredClaims preserves attempts and ordering', () => {
            const b = new Outbox({ leaseMs: 10 });
            b.enqueue('first', {}, 0);
            b.enqueue('second', {}, 0);
            b.claimDue(0, 'worker-1', 2);
            const recovered = b.reapExpiredClaims(11);
            return JSON.stringify(recovered.map((j) => j.id)) === JSON.stringify(['first', 'second']) && JSON.stringify(b.pending.map((j) => j.id)) === JSON.stringify(['first', 'second']);
          }],
          ['limit only processes due-at-start batch slice', () => {
            const b = new Outbox();
            b.enqueue('a', {}, 0);
            b.enqueue('b', {}, 0);
            const r = drainDue(b, 0, 'worker-1', () => {}, 1);
            return JSON.stringify(r.delivered) === JSON.stringify(['a']) && b.pending.length === 1 && b.pending[0].id === 'b';
          }],
        ]),
      };
    },
  },

  fraudml: {
    version: 1,
    title: 'Python fraud scorer with deterministic split and threshold calibration',
    language: 'python',
    promptFile: 'prompts/fraudml.txt',
    targetFiles: ['pipeline.py'],
    protectedFiles: ['test_pipeline.py', 'package.json'],
    allowedFiles: ['pipeline.py'],
    efficiencyBudget: { toolCalls: 28, generatedTokens: 9500, wallTimeMs: 420000 },
    files: {
      'package.json': `{"name":"brittain-bench-fraudml","private":true,"scripts":{"test":"python3 -m unittest -q"}}\n`,
      'pipeline.py': `import copy
import random

FEATURES = ("tx_count", "chargeback_ratio", "avg_amount")

def _clone(value):
    return copy.deepcopy(value)

def _validate_row(row):
    if not isinstance(row, dict):
        raise ValueError("row must be a dict")
    if not isinstance(row.get("id"), str) or not row["id"]:
        raise ValueError("row id must be a nonempty string")
    if row.get("label") not in (0, 1):
        raise ValueError("label must be 0 or 1")
    if not isinstance(row.get("tx_count"), int) or row["tx_count"] < 0:
        raise ValueError("tx_count must be a nonnegative integer")
    ratio = row.get("chargeback_ratio")
    if not isinstance(ratio, (int, float)) or ratio < 0 or ratio > 1:
        raise ValueError("chargeback_ratio must be between 0 and 1")
    amount = row.get("avg_amount")
    if not isinstance(amount, (int, float)) or amount <= 0:
        raise ValueError("avg_amount must be positive")

def split_rows(rows, validation_ratio=0.25, seed=0):
    if not isinstance(rows, list) or len(rows) < 4:
        raise ValueError("rows must contain at least four items")
    shuffled = list(rows)
    random.Random().shuffle(shuffled)  # BUG: seed ignored, result nondeterministic
    cut = int(len(shuffled) * (1 - validation_ratio))
    return shuffled[:cut], shuffled[cut:]

def train_model(rows):
    if not rows:
        raise ValueError("rows required")
    for row in rows:
        _validate_row(row)
    positives = rows
    negatives = rows  # BUG: labels ignored so both centroids are identical
    def mean(group, feature):
        return sum(item[feature] for item in group) / len(group)
    return {
        "positive": {feature: mean(positives, feature) for feature in FEATURES},
        "negative": {feature: mean(negatives, feature) for feature in FEATURES},
    }

def score_row(model, row):
    _validate_row({**row, "label": row.get("label", 0)})
    pos_distance = sum(abs(float(row[feature]) - float(model["positive"][feature])) for feature in FEATURES)
    neg_distance = sum(abs(float(row[feature]) - float(model["negative"][feature])) for feature in FEATURES)
    return round(neg_distance - pos_distance, 6)

def choose_threshold(scored_rows):
    if not scored_rows:
        raise ValueError("scored rows required")
    scores = sorted(item["score"] for item in scored_rows)
    return scores[-1]  # BUG: maximizes confidence, not validation F1

def _metrics(scored_rows, threshold):
    tp = fp = fn = 0
    for item in scored_rows:
        predicted = 1 if item["score"] >= threshold else 0
        actual = item["label"]
        if predicted and actual:
            tp += 1
        elif predicted and not actual:
            fp += 1
        elif actual and not predicted:
            fn += 1
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if precision + recall else 0.0
    return {
        "precision": round(precision, 6),
        "recall": round(recall, 6),
        "f1": round(f1, 6),
    }

def fit_pipeline(rows, validation_ratio=0.25, seed=0):
    train_rows, validation_rows = split_rows(rows, validation_ratio, seed)
    model = train_model(rows)  # BUG: validation leaks into training
    scored_validation = [{"id": row["id"], "label": row["label"], "score": score_row(model, row)} for row in train_rows]  # BUG: calibrates on train
    threshold = choose_threshold(scored_validation)
    metrics = _metrics(scored_validation, threshold)
    return {
        "model": model,
        "threshold": threshold,
        "metrics": {**metrics, "validation_size": len(validation_rows)},
    }

def predict(model_bundle, rows):
    return [1 if score_row(model_bundle["model"], row) >= model_bundle["threshold"] else 0 for row in rows]

def save_model(model_bundle):
    return model_bundle  # BUG: aliases caller state

def load_model(snapshot):
    return snapshot  # BUG: aliases snapshot state
\n`,
      'test_pipeline.py': `import copy
import unittest
from pipeline import split_rows, fit_pipeline, predict, save_model, load_model

ROWS = [
    {"id": "u1", "tx_count": 2, "chargeback_ratio": 0.0, "avg_amount": 40.0, "label": 0},
    {"id": "u2", "tx_count": 3, "chargeback_ratio": 0.1, "avg_amount": 42.0, "label": 0},
    {"id": "u3", "tx_count": 10, "chargeback_ratio": 0.6, "avg_amount": 180.0, "label": 1},
    {"id": "u4", "tx_count": 9, "chargeback_ratio": 0.7, "avg_amount": 190.0, "label": 1},
    {"id": "u5", "tx_count": 4, "chargeback_ratio": 0.2, "avg_amount": 60.0, "label": 0},
    {"id": "u6", "tx_count": 11, "chargeback_ratio": 0.5, "avg_amount": 175.0, "label": 1},
]

class FraudPipelineTests(unittest.TestCase):
    def test_split_is_deterministic(self):
        left_a, right_a = split_rows(copy.deepcopy(ROWS), 0.34, 7)
        left_b, right_b = split_rows(copy.deepcopy(ROWS), 0.34, 7)
        self.assertEqual([row["id"] for row in left_a], [row["id"] for row in left_b])
        self.assertEqual([row["id"] for row in right_a], [row["id"] for row in right_b])

    def test_fit_and_predict(self):
        fitted = fit_pipeline(copy.deepcopy(ROWS), 0.34, 7)
        self.assertIn("threshold", fitted)
        self.assertIn("f1", fitted["metrics"])
        predictions = predict(fitted, ROWS)
        self.assertEqual(len(predictions), len(ROWS))
        self.assertTrue(all(value in (0, 1) for value in predictions))

    def test_save_and_load_round_trip(self):
        fitted = fit_pipeline(copy.deepcopy(ROWS), 0.34, 7)
        restored = load_model(save_model(fitted))
        self.assertEqual(predict(fitted, ROWS), predict(restored, ROWS))

    def test_inputs_are_not_mutated(self):
        original = copy.deepcopy(ROWS)
        fit_pipeline(ROWS, 0.34, 7)
        self.assertEqual(ROWS, original)

if __name__ == "__main__":
    unittest.main()
\n`,
    },
    evaluate(dir) {
      const result = runPythonEvaluation(dir, `
import copy
import json
from pipeline import split_rows, train_model, score_row, choose_threshold, fit_pipeline, predict, save_model, load_model

def run(cases):
    passed = 0
    fails = []
    for description, fn in cases:
        try:
            if fn():
                passed += 1
            else:
                fails.append(description)
        except Exception as err:
            fails.append(f"{description}: {err}")
    return {"pass": passed, "total": len(cases), "fails": fails}

def raises(fn):
    try:
        fn()
        return False
    except Exception:
        return True

ROWS = [
    {"id": "p1", "tx_count": 1, "chargeback_ratio": 0.02, "avg_amount": 35.0, "label": 0},
    {"id": "p2", "tx_count": 2, "chargeback_ratio": 0.05, "avg_amount": 42.0, "label": 0},
    {"id": "p3", "tx_count": 9, "chargeback_ratio": 0.62, "avg_amount": 180.0, "label": 1},
    {"id": "p4", "tx_count": 11, "chargeback_ratio": 0.58, "avg_amount": 170.0, "label": 1},
    {"id": "p5", "tx_count": 3, "chargeback_ratio": 0.08, "avg_amount": 55.0, "label": 0},
    {"id": "p6", "tx_count": 10, "chargeback_ratio": 0.66, "avg_amount": 205.0, "label": 1},
]

HARD_ROWS = [
    {"id": "a", "tx_count": 1, "chargeback_ratio": 0.01, "avg_amount": 20.0, "label": 0},
    {"id": "b", "tx_count": 2, "chargeback_ratio": 0.02, "avg_amount": 24.0, "label": 0},
    {"id": "c", "tx_count": 8, "chargeback_ratio": 0.55, "avg_amount": 160.0, "label": 1},
    {"id": "d", "tx_count": 9, "chargeback_ratio": 0.60, "avg_amount": 165.0, "label": 1},
    {"id": "e", "tx_count": 3, "chargeback_ratio": 0.03, "avg_amount": 30.0, "label": 0},
    {"id": "f", "tx_count": 10, "chargeback_ratio": 0.65, "avg_amount": 172.0, "label": 1},
    {"id": "g", "tx_count": 4, "chargeback_ratio": 0.04, "avg_amount": 40.0, "label": 0},
    {"id": "h", "tx_count": 11, "chargeback_ratio": 0.70, "avg_amount": 210.0, "label": 1},
]

def expected_threshold():
    fitted = fit_pipeline(copy.deepcopy(HARD_ROWS), 0.25, 3)
    return fitted["threshold"]

visible = run([
    ("split is deterministic for same seed", lambda: [row["id"] for row in split_rows(copy.deepcopy(ROWS), 0.34, 7)[0]] == [row["id"] for row in split_rows(copy.deepcopy(ROWS), 0.34, 7)[0]]),
    ("fit returns metrics and threshold", lambda: "f1" in fit_pipeline(copy.deepcopy(ROWS), 0.34, 7)["metrics"]),
    ("predict returns one binary result per row", lambda: len(predict(fit_pipeline(copy.deepcopy(ROWS), 0.34, 7), ROWS)) == len(ROWS) and set(predict(fit_pipeline(copy.deepcopy(ROWS), 0.34, 7), ROWS)).issubset({0, 1})),
    ("save/load preserves predictions", lambda: predict(fit_pipeline(copy.deepcopy(ROWS), 0.34, 7), ROWS) == predict(load_model(save_model(fit_pipeline(copy.deepcopy(ROWS), 0.34, 7))), ROWS)),
])

hidden = run([
    ("different seeds produce different splits", lambda: [row["id"] for row in split_rows(copy.deepcopy(HARD_ROWS), 0.25, 1)[0]] != [row["id"] for row in split_rows(copy.deepcopy(HARD_ROWS), 0.25, 2)[0]]),
    ("split keeps both train and validation nonempty", lambda: all(len(part) > 0 for part in split_rows(copy.deepcopy(HARD_ROWS), 0.25, 3))),
    ("train_model separates positive and negative centroids", lambda: train_model(copy.deepcopy(HARD_ROWS))["positive"]["avg_amount"] > train_model(copy.deepcopy(HARD_ROWS))["negative"]["avg_amount"]),
    ("fit calibrates on validation only", lambda: fit_pipeline(copy.deepcopy(HARD_ROWS), 0.25, 3)["metrics"]["validation_size"] == 2 and fit_pipeline(copy.deepcopy(HARD_ROWS), 0.25, 3)["metrics"]["f1"] >= 0.99),
    ("choose_threshold maximizes F1 with deterministic tie break", lambda: choose_threshold([
        {"score": -2.0, "label": 0},
        {"score": -1.0, "label": 0},
        {"score": 0.5, "label": 1},
        {"score": 1.5, "label": 1},
    ]) == 0.5),
    ("single-class or malformed data is rejected", lambda: raises(lambda: train_model([{**HARD_ROWS[0], "label": 0}, {**HARD_ROWS[1], "label": 0}])) and raises(lambda: fit_pipeline([{**HARD_ROWS[0], "tx_count": -1}, *copy.deepcopy(HARD_ROWS[1:])], 0.25, 1))),
    ("save/load and predictions are detached", lambda: (lambda fitted, snap, loaded: (snap["model"]["positive"].__setitem__("avg_amount", 0.0), loaded.__setitem__("threshold", 999999), fitted["model"]["positive"]["avg_amount"] != 0.0 and fitted["threshold"] != 999999))(fit_pipeline(copy.deepcopy(HARD_ROWS), 0.25, 3), save_model(fit_pipeline(copy.deepcopy(HARD_ROWS), 0.25, 3)), load_model(save_model(fit_pipeline(copy.deepcopy(HARD_ROWS), 0.25, 3))))),
    ("fit does not mutate caller rows", lambda: (lambda original: (fit_pipeline(HARD_ROWS, 0.25, 3), HARD_ROWS == original)[1])(copy.deepcopy(HARD_ROWS))),
])

print(json.dumps({"visible": visible, "hidden": hidden}))
      `);
      return result;
    },
  },

  tsapi: {
    version: 1,
    title: 'TypeScript API sync with pagination, ETags, and idempotent writes',
    language: 'typescript',
    promptFile: 'prompts/tsapi.txt',
    targetFiles: ['api.ts', 'directory.ts'],
    protectedFiles: ['test.ts', 'package.json'],
    allowedFiles: ['api.ts', 'directory.ts'],
    efficiencyBudget: { toolCalls: 28, generatedTokens: 9500, wallTimeMs: 420000 },
    files: {
      'package.json': `{"name":"brittain-bench-tsapi","private":true,"type":"module","scripts":{"test":"node --experimental-strip-types test.ts"}}\n`,
      'api.ts': `export class ApiError extends Error {
  status: number;
  code: string;
  retryable: boolean;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = status >= 500; // BUG: 429 should also be retryable and some 5xx may be normalized differently
  }
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<{
  status: number;
  headers?: Record<string, string>;
  json?: () => Promise<any>;
  text?: () => Promise<string>;
}>;

export async function requestJson(fetchImpl: FetchLike, url: string, init: RequestInit = {}) {
  const headers = { ...(init.headers as Record<string, string> || {}) };
  const response = await fetchImpl(url, { ...init, headers });
  if (response.status === 304) return { status: 'not-modified' }; // BUG: etag discarded
  if (response.status >= 200 && response.status < 300) return response.json ? response.json() : null;
  const code = response.status === 404 ? 'not_found' : 'api_error';
  throw new ApiError(response.status, code, response.text ? await response.text() : 'request failed');
}
\n`,
      'directory.ts': `import { ApiError, requestJson, type FetchLike } from './api.ts';

export type DirectoryCache = { etag: string | null; users: Array<{ id: string; name: string }>; };

export async function listAllUsers(fetchImpl: FetchLike, baseUrl: string, etag: string | null = null) {
  const first = await requestJson(fetchImpl, baseUrl + '/users', { headers: etag ? { 'if-none-match': etag } : {} });
  if ((first as any)?.status === 'not-modified') return { etag, users: [] }; // BUG: cached users are discarded and caller cannot distinguish 304
  const users = [...first.items];
  let cursor = first.nextCursor;
  while (cursor) {
    const page = await requestJson(fetchImpl, baseUrl + '/users?cursor=' + encodeURIComponent(cursor));
    users.push(...page.items); // BUG: cursor loops and malformed pages are not checked
    cursor = page.nextCursor;
  }
  return { etag: first.etag || etag || null, users };
}

export async function createInvite(fetchImpl: FetchLike, baseUrl: string, email: string, idempotencyKey?: string) {
  const body = JSON.stringify({ email });
  return requestJson(fetchImpl, baseUrl + '/invites', {
    method: 'POST',
    headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
    body,
  }); // BUG: nonempty email/idempotency contract not enforced and body/header shape is underspecified
}

export async function syncDirectory(fetchImpl: FetchLike, baseUrl: string, cache: DirectoryCache | null) {
  try {
    const fresh = await listAllUsers(fetchImpl, baseUrl, cache?.etag || null);
    if (fresh.users.length === 0 && cache) return cache; // BUG: aliases cache and treats any empty page as 304
    return fresh;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { etag: null, users: [] };
    throw err;
  }
}
\n`,
      'test.ts': `import assert from 'node:assert/strict';
import { ApiError } from './api.ts';
import { createInvite, listAllUsers, syncDirectory } from './directory.ts';

type ResponseShape = {
  status: number;
  headers?: Record<string, string>;
  json?: () => Promise<any>;
  text?: () => Promise<string>;
};

function makeFetch(routes: Record<string, ResponseShape | ((init?: RequestInit) => ResponseShape | Promise<ResponseShape>)>) {
  return async (url: string, init?: RequestInit): Promise<ResponseShape> => {
    const route = routes[url];
    if (!route) return { status: 404, text: async () => 'missing' };
    return typeof route === 'function' ? await route(init) : route;
  };
}

const pagedFetch = makeFetch({
  '/api/users': {
    status: 200,
    json: async () => ({ etag: 'v1', items: [{ id: 'u1', name: 'A' }], nextCursor: 'page-2' }),
  },
  '/api/users?cursor=page-2': {
    status: 200,
    json: async () => ({ items: [{ id: 'u2', name: 'B' }], nextCursor: null }),
  },
});

const listed = await listAllUsers(pagedFetch, '/api');
assert.deepEqual(listed.users.map((user) => user.id), ['u1', 'u2']);
assert.equal(listed.etag, 'v1');

const cached = { etag: 'v1', users: [{ id: 'cached', name: 'Cached' }] };
const notModifiedFetch = makeFetch({
  '/api/users': {
    status: 304,
    headers: { etag: 'v1' },
  },
});
const synced = await syncDirectory(notModifiedFetch, '/api', cached);
assert.deepEqual(synced.users, cached.users);

let capturedHeaders: Record<string, string> | undefined;
const inviteFetch = makeFetch({
  '/api/invites': (init?: RequestInit) => {
    capturedHeaders = (init?.headers || {}) as Record<string, string>;
    return {
      status: 200,
      json: async () => ({ id: 'invite-1', accepted: false }),
    };
  },
});
const invite = await createInvite(inviteFetch, '/api', 'user@example.com', 'idem-1');
assert.equal(invite.id, 'invite-1');
assert.equal(capturedHeaders?.['idempotency-key'], 'idem-1');

const failingFetch = makeFetch({
  '/api/users': {
    status: 429,
    text: async () => 'rate limited',
  },
});
await assert.rejects(() => listAllUsers(failingFetch, '/api'), (err: unknown) => err instanceof ApiError);
console.log('4/4 passed.');
\n`,
    },
    evaluate(dir) {
      const result = runTsEvaluation(dir, `
import { ApiError, requestJson } from './api.ts';
import { createInvite, listAllUsers, syncDirectory } from './directory.ts';

async function run(cases) {
  let pass = 0;
  const fails = [];
  for (const [description, fn] of cases) {
    try {
      if (await fn()) pass++;
      else fails.push(description);
    } catch (err) {
      fails.push(description + ': ' + (err instanceof Error ? err.message : String(err)));
    }
  }
  return { pass, total: cases.length, fails };
}

function makeFetch(routes) {
  return async (url, init = {}) => {
    const route = routes[url];
    if (!route) return { status: 404, text: async () => 'missing' };
    return typeof route === 'function' ? await route(init) : route;
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function raises(asyncFn, check) {
  return asyncFn().then(() => false, (err) => check ? check(err) : true);
}

const visible = await run([
  ['listAllUsers collects pages in order', async () => {
    const fetchImpl = makeFetch({
      '/api/users': { status: 200, json: async () => ({ etag: 'v1', items: [{ id: 'u1', name: 'A' }], nextCursor: 'page-2' }) },
      '/api/users?cursor=page-2': { status: 200, json: async () => ({ items: [{ id: 'u2', name: 'B' }], nextCursor: null }) },
    });
    const listed = await listAllUsers(fetchImpl, '/api');
    return JSON.stringify(listed.users.map((user) => user.id)) === JSON.stringify(['u1', 'u2']) && listed.etag === 'v1';
  }],
  ['syncDirectory reuses cache on 304', async () => {
    const cache = { etag: 'v1', users: [{ id: 'cached', name: 'Cached' }] };
    const fetchImpl = makeFetch({ '/api/users': { status: 304, headers: { etag: 'v1' } } });
    const synced = await syncDirectory(fetchImpl, '/api', cache);
    return JSON.stringify(synced.users) === JSON.stringify(cache.users);
  }],
  ['createInvite forwards idempotency key', async () => {
    let seen;
    const fetchImpl = makeFetch({
      '/api/invites': async (init = {}) => {
        seen = clone(init.headers || {});
        return { status: 200, json: async () => ({ id: 'invite-1' }) };
      },
    });
    const invite = await createInvite(fetchImpl, '/api', 'user@example.com', 'idem-1');
    return invite.id === 'invite-1' && seen['idempotency-key'] === 'idem-1';
  }],
  ['429 becomes ApiError', async () => {
    const fetchImpl = makeFetch({ '/api/users': { status: 429, text: async () => 'slow down' } });
    return await raises(() => listAllUsers(fetchImpl, '/api'), (err) => err instanceof ApiError);
  }],
]);

const hidden = await run([
  ['requestJson adds Accept header and parses JSON', async () => {
    let headersSeen;
    const fetchImpl = makeFetch({
      '/check': async (init = {}) => {
        headersSeen = clone(init.headers || {});
        return { status: 200, json: async () => ({ ok: true }) };
      },
    });
    const result = await requestJson(fetchImpl, '/check');
    return result.ok === true && headersSeen.accept === 'application/json';
  }],
  ['304 returns a distinguishable result with etag', async () => {
    const fetchImpl = makeFetch({ '/api/users': { status: 304, headers: { etag: 'v2' } } });
    const listed = await listAllUsers(fetchImpl, '/api', 'v1');
    return listed.notModified === true && listed.etag === 'v2';
  }],
  ['syncDirectory detaches cached results', async () => {
    const cache = { etag: 'v1', users: [{ id: 'cached', name: 'Cached' }] };
    const fetchImpl = makeFetch({ '/api/users': { status: 304, headers: { etag: 'v1' } } });
    const synced = await syncDirectory(fetchImpl, '/api', cache);
    synced.users[0].name = 'Mutated';
    return cache.users[0].name === 'Cached';
  }],
  ['cursor loops are rejected', async () => {
    let loopCalls = 0;
    const fetchImpl = makeFetch({
      '/api/users': { status: 200, json: async () => ({ etag: 'v1', items: [{ id: 'u1', name: 'A' }], nextCursor: 'loop' }) },
      '/api/users?cursor=loop': async () => {
        loopCalls += 1;
        if (loopCalls > 2) throw new Error('cursor loop');
        return { status: 200, json: async () => ({ items: [{ id: 'u2', name: 'B' }], nextCursor: 'loop' }) };
      },
    });
    return await raises(() => listAllUsers(fetchImpl, '/api'));
  }],
  ['malformed pages are rejected atomically', async () => {
    const fetchImpl = makeFetch({ '/api/users': { status: 200, json: async () => ({ etag: 'v1', items: null, nextCursor: null }) } });
    return await raises(() => listAllUsers(fetchImpl, '/api'));
  }],
  ['empty email or idempotency key rejected before fetch', async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { status: 200, json: async () => ({ id: 'x' }) }; };
    const a = await raises(() => createInvite(fetchImpl, '/api', '', 'idem-1'));
    const b = await raises(() => createInvite(fetchImpl, '/api', 'user@example.com', ''));
    return a && b && calls === 0;
  }],
  ['POST body is JSON and content type is set', async () => {
    let seenBody = '';
    let seenHeaders = {};
    const fetchImpl = makeFetch({
      '/api/invites': async (init = {}) => {
        seenBody = String(init.body || '');
        seenHeaders = clone(init.headers || {});
        return { status: 200, json: async () => ({ id: 'invite-1' }) };
      },
    });
    await createInvite(fetchImpl, '/api', 'person@example.com', 'idem-9');
    return JSON.parse(seenBody).email === 'person@example.com' && seenHeaders['content-type'] === 'application/json' && seenHeaders.accept === 'application/json';
  }],
  ['ApiError classifies 429 as retryable', async () => {
    const fetchImpl = makeFetch({ '/check': { status: 429, text: async () => 'slow down' } });
    return await raises(() => requestJson(fetchImpl, '/check'), (err) => err instanceof ApiError && err.retryable === true && err.code === 'rate_limited');
  }],
]);

console.log(JSON.stringify({ visible, hidden }));
      `);
      return result;
    },
  },
};

function getTask(id) {
  const task = TASKS[id];
  if (!task) throw new Error(`Unknown task "${id}". Available: ${Object.keys(TASKS).join(', ')}`);
  return task;
}

module.exports = { TASKS, getTask, runCases, jsonClone };
