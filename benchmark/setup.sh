#!/usr/bin/env bash
# Creates the fixed scratch repo the benchmark runs against.
# Run once. Between model runs you RESET it (see README), you do not re-run this.
set -euo pipefail

BENCH_DIR="${1:-$HOME/brittain-bench}"
mkdir -p "$BENCH_DIR"
cd "$BENCH_DIR"

cat > config.js <<'EOF'
// Store configuration.
module.exports = {
  taxRate: 0.08,            // 8% sales tax
  currency: 'USD',
  freeShippingThreshold: 50 // free shipping when subtotal is over this
};
EOF

cat > cart.js <<'EOF'
const config = require('./config');

// Apply a percentage discount. applyDiscount(100, 20) === 80
function applyDiscount(price, percent) {
  return price - percent;                 // BUG: treats percent as a flat amount
}

// Sum line items. Each item is { price, quantity }.
function subtotal(items) {
  let sum = 0;
  for (const item of items) {
    sum += item.price;                     // BUG: ignores quantity
  }
  return sum;
}

// Grand total: subtotal, minus a cart-level discount percent, plus tax,
// plus $5 shipping (free when subtotal is over the threshold),
// rounded to 2 decimal places.
function total(items, discountPercent = 0) {
  const sub = subtotal(items);
  const discounted = applyDiscount(sub, discountPercent);
  const taxed = discounted * (1 + config.taxRate);
  const shipping = sub > config.freeShippingThreshold ? 0 : 5;
  return taxed + shipping;                 // BUG: not rounded to 2 dp
}

module.exports = { applyDiscount, subtotal, total };
EOF

cat > legacy.js <<'EOF'
// DEPRECATED. Not used by cart.js or the tests. Do not build on this.
function applyDiscount(price, percent) {
  return price * (1 - percent / 100);
}
module.exports = { applyDiscount };
EOF

cat > test.js <<'EOF'
const assert = require('assert');
const { applyDiscount, subtotal, total } = require('./cart');

let passed = 0, failed = 0;
function check(desc, fn) {
  try { fn(); console.log('PASS  ' + desc); passed++; }
  catch (e) { console.log('FAIL  ' + desc + '  (' + e.message + ')'); failed++; }
}

check('applyDiscount 20% of 100 -> 80', () => assert.strictEqual(applyDiscount(100, 20), 80));
check('applyDiscount 0% leaves price',  () => assert.strictEqual(applyDiscount(50, 0), 50));
check('applyDiscount 100% -> 0',        () => assert.strictEqual(applyDiscount(200, 100), 0));
check('subtotal 10x2 -> 20',            () => assert.strictEqual(subtotal([{ price: 10, quantity: 2 }]), 20));
check('subtotal mixed -> 13',           () => assert.strictEqual(subtotal([{ price: 3, quantity: 3 }, { price: 1, quantity: 4 }]), 13));
check('subtotal empty -> 0',            () => assert.strictEqual(subtotal([]), 0));
check('total small cart -> 24.44',      () => assert.strictEqual(total([{ price: 10, quantity: 2 }], 10), 24.44));
check('total free shipping -> 64.8',    () => assert.strictEqual(total([{ price: 20, quantity: 3 }]), 64.8));

console.log(`\n${passed}/${passed + failed} passed.`);
process.exit(failed ? 1 : 0);
EOF

git init -q
git add -A
git -c user.name='bench' -c user.email='bench@local' commit -qm 'buggy baseline'
git tag -f bench-baseline >/dev/null

echo "Bench ready at: $BENCH_DIR"
echo "Baseline: 3/8 tests pass. Reset before each run with:"
echo "  cd \"$BENCH_DIR\" && git reset --hard -q bench-baseline && git clean -fdq"
