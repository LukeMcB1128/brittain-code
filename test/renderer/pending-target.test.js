const test = require('node:test');
const assert = require('node:assert/strict');

const { resolvePendingTarget } = require('../../renderer/features/pending-target');

const one = [{ runId: 'run-1787440224174-djqc7p', parked: [{ index: 0 }, { index: 1 }] }];
const two = [...one, { runId: 'run-1787440999999-zzz111', parked: [{ index: 0 }] }];

test('with one run waiting, naming it is optional', () => {
  const target = resolvePendingTarget(one, '', '');
  assert.equal(target.record.runId, one[0].runId);
  assert.equal(target.selector, '');
});

test('a bare index or "all" in the run slot is read as the call selector', () => {
  // `/pending approve all` and `/pending approve 2` are about the one waiting
  // run — there is no run named "all".
  assert.equal(resolvePendingTarget(one, 'all', '').selector, 'all');
  assert.equal(resolvePendingTarget(one, '2', '').selector, '2');
  assert.equal(resolvePendingTarget(one, 'all', '').record.runId, one[0].runId);
});

test('an explicit id still wins, and a unique suffix is enough', () => {
  assert.equal(resolvePendingTarget(two, 'run-1787440999999-zzz111', '').record.runId, two[1].runId);
  assert.equal(resolvePendingTarget(two, 'zzz111', '').record.runId, two[1].runId);
  assert.equal(resolvePendingTarget(one, 'djqc7p', 'all').selector, 'all');
});

test('with several waiting, the user picks — nothing is chosen for them', () => {
  const target = resolvePendingTarget(two, '', '');
  assert.equal(target.record, undefined);
  assert.match(target.error, /Several runs are suspended/);
  assert.match(target.error, /djqc7p/);
  // An ambiguous selector must not silently act on one of them either.
  assert.match(resolvePendingTarget(two, 'all', '').error, /Several runs/);
});

test('unmatched ids and an empty tray report themselves', () => {
  assert.match(resolvePendingTarget(two, 'nope', '').error, /No suspended run matching "nope"/);
  assert.match(resolvePendingTarget([], '', '').error, /No suspended runs/);
});
