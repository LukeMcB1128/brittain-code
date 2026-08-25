const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { selectVerbatimTail } = require('../../src/main/compaction');
const read = (name) => fs.readFileSync(path.join(__dirname, '..', '..', name), 'utf8');

const estimate = (value) => Math.round(JSON.stringify(value).length / 4);
const turn = (text, images) => [
  { role: 'user', content: text, ...(images ? { images } : {}) },
  { role: 'assistant', content: 'ok' },
];

test('a turn carrying an image is measured as it would be sent', () => {
  // estimateTokens counts base64; stripOldImages removes it before sending. A
  // screenshot therefore looked enormous while costing almost nothing, so
  // every candidate was rejected and the tail came back empty.
  const bigImage = 'A'.repeat(200_000);
  const messages = [...turn('older', [bigImage]), ...turn('the actual request', [bigImage])];

  const raw = selectVerbatimTail(messages, 5_000, estimate);
  assert.equal(raw.tail.length, 0, 'measuring stored bytes rejects everything');

  // Measured the way main.js now does it: only the newest image survives.
  const stripOldImages = (msgs) => {
    let last = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].images?.length) { last = i; break; }
    return msgs.map((m, i) => (!m.images?.length || i === last ? m : { ...m, images: undefined }));
  };
  const sendable = (msgs) => estimate(stripOldImages(msgs));
  const measured = selectVerbatimTail(messages, 60_000, sendable);
  assert.ok(measured.tail.length > 0, 'the same turns fit once measured as sent');
});

test('compaction measures the tail the way it will be sent', () => {
  const main = read('main.js');
  assert.match(main, /const sendableTokens = \(messages\) => estimateTokens\(modelReadyMessages\(messages\)\);/);
  assert.match(main, /selectVerbatimTail\(unpinnedConversation, tailBudget\(contextLength\), sendableTokens\)/);
  // The wider fallback must agree, or the two disagree about what fits.
  assert.ok(!/selectVerbatimTail\([^)]*, estimateTokens\)/.test(main),
    'no path may still measure stored bytes');
});

test('keeping zero turns is refused even when the summary was good', () => {
  // The decline existed only on the degraded branch, so a usable summary plus
  // an oversized turn silently discarded the request being worked on.
  const main = read('main.js');
  assert.match(main, /if \(!degraded && !intact\.length\) \{/);
  assert.match(main, /too large to keep even at the widest budget/);
  assert.match(main, /The conversation was left unchanged/);
});

test('it widens before declining, rather than giving up at the first budget', () => {
  const main = read('main.js');
  const guard = main.slice(main.indexOf('let intact = degraded'), main.indexOf('const keptTail = intact;'));
  assert.match(guard, /retainedBudget\(contextLength\) - pinnedCost/);
  assert.ok(guard.indexOf('wider.tail.length') < guard.indexOf('intact = wider.tail'),
    'the wider attempt is checked before it is used');
});

test('the degraded path still declines when nothing fits', () => {
  // Unchanged behaviour: this one was already correct.
  const main = read('main.js');
  assert.match(main, /if \(degraded && !fallback\.tail\.length\)/);
});

// --- the calculator error that started the same session ---

test('a comma in an expression teaches the shape that works', () => {
  // "Unexpected operator ," alone reads as "no commas allowed", and the model
  // abandoned the tool and went back to driving a browser to do arithmetic.
  const mod = require('../../src/tools/calculator');
  const run = Object.values(mod).find((value) => typeof value === 'function');
  const message = String(run({ calculations: [{ expression: 'f(3.9), f(3.99)' }] }));
  assert.match(message, /single formula/);
  assert.match(message, /variables.*\{"x": \[3\.9/);
});

test('an ordinary parse error is not buried in advice', () => {
  const mod = require('../../src/tools/calculator');
  const run = Object.values(mod).find((value) => typeof value === 'function');
  const message = String(run({ calculations: [{ expression: '2 +' }] }));
  assert.match(message, /invalid expression/);
  assert.ok(!message.includes('single formula'), 'the hint belongs only where a comma caused it');
});
