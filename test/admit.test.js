'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeAdmission } = require('../src/admit');

const pr = (number, opts = {}) => ({
  number,
  labels: opts.labels || [],
  createdAt: opts.createdAt || `2026-01-01T00:00:${String(number).padStart(2, '0')}Z`,
  bypass: opts.bypass || false,
});

test('admits up to the budget and holds the rest', () => {
  const prs = [pr(1), pr(2), pr(3), pr(4), pr(5)];
  const r = computeAdmission(prs, { budget: 3 });
  assert.deepEqual(r.admit, [1, 2, 3]);
  assert.deepEqual(r.hold, [4, 5]);
});

test('fifo admits the oldest PRs first regardless of number order', () => {
  const prs = [
    pr(9, { createdAt: '2026-01-01T00:00:00Z' }),
    pr(3, { createdAt: '2026-02-01T00:00:00Z' }),
    pr(7, { createdAt: '2026-03-01T00:00:00Z' }),
  ];
  const r = computeAdmission(prs, { budget: 2, strategy: 'fifo' });
  assert.deepEqual(r.admit, [9, 3]); // oldest two
  assert.deepEqual(r.hold, [7]);
});

test('priority mode admits high-weight labels before older PRs', () => {
  const prs = [
    pr(1, { createdAt: '2026-01-01T00:00:00Z' }), // old, no weight
    pr(2, { createdAt: '2026-06-01T00:00:00Z', labels: ['release'] }), // new, high weight
  ];
  const r = computeAdmission(prs, {
    budget: 1,
    strategy: 'priority',
    priorityLabels: { release: 100 },
  });
  assert.deepEqual(r.admit, [2]);
  assert.deepEqual(r.hold, [1]);
});

test('bypass PRs are always admitted and do NOT consume the budget', () => {
  const prs = [
    pr(1, { bypass: true }),
    pr(2, { labels: ['docs-only'] }),
    pr(3),
    pr(4),
  ];
  const r = computeAdmission(prs, { budget: 1, bypassLabels: ['docs-only'] });
  assert.deepEqual(r.bypass.sort(), [1, 2]);
  assert.deepEqual(r.admit, [3]); // budget of 1 spent on the first eligible
  assert.deepEqual(r.hold, [4]);
});

test('excluded PRs are never admitted or held for admission', () => {
  const prs = [pr(1, { labels: ['wip'] }), pr(2), pr(3)];
  const r = computeAdmission(prs, { budget: 5, excludeLabels: ['wip'] });
  assert.deepEqual(r.excluded, [1]);
  assert.deepEqual(r.admit, [2, 3]);
  assert.equal(r.hold.length, 0);
});

test('transitions: promote newly-admitted, demote newly-held', () => {
  const prs = [
    pr(1, { createdAt: '2026-01-01T00:00:00Z' }), // will stay admitted
    pr(2, { createdAt: '2026-02-01T00:00:00Z', labels: ['ci:admitted'] }), // stays
    pr(3, { createdAt: '2026-03-01T00:00:00Z', labels: ['ci:admitted'] }), // falls out -> demote
  ];
  const r = computeAdmission(prs, { budget: 2 });
  assert.deepEqual(r.admit, [1, 2]);
  assert.deepEqual(r.toPromote, [1]); // 1 gets the label it lacks
  assert.deepEqual(r.toDemote, [3]); // 3 loses the label
});

test('stale queue labels are cleared from bypassed and excluded PRs', () => {
  const prs = [
    pr(1, { labels: ['ci:queued'], bypass: true }), // became docs-only while queued
    pr(2, { labels: ['ci:admitted', 'wip'] }), // gained an exclude label while admitted
    pr(3, { bypass: true }), // never labeled — nothing to clear
    pr(4, { labels: ['wip'] }), // excluded, never labeled
  ];
  const r = computeAdmission(prs, {
    budget: 4,
    excludeLabels: ['wip'],
    queuedLabel: 'ci:queued',
  });
  assert.deepEqual(r.toClear.sort(), [1, 2]);
});

test('budget of 0 holds everything, budget >= n admits all', () => {
  const prs = [pr(1), pr(2)];
  assert.deepEqual(computeAdmission(prs, { budget: 0 }).hold, [1, 2]);
  assert.deepEqual(computeAdmission(prs, { budget: 99 }).admit, [1, 2]);
});

test('empty input is safe', () => {
  const r = computeAdmission([], { budget: 3 });
  assert.deepEqual(r, {
    admit: [], hold: [], bypass: [], excluded: [],
    toPromote: [], toDemote: [], toClear: [],
  });
});

const { bypassSignature, bypassCacheKey } = require('../src/run');

test('bypass signature is order-independent', () => {
  assert.equal(
    bypassSignature(['docs/**', '*.md']),
    bypassSignature(['*.md', 'docs/**']),
  );
});

test('bypass signature changes when the globs change', () => {
  assert.notEqual(
    bypassSignature(['docs/**']),
    bypassSignature(['docs/**', 'README.md']),
  );
  // Empty vs. non-empty must differ so removing all globs invalidates verdicts.
  assert.notEqual(bypassSignature([]), bypassSignature(['docs/**']));
});

test('bypass cache key binds number, head SHA, base SHA, and globs', () => {
  const sig = bypassSignature(['docs/**']);
  const base = bypassCacheKey(7, 'headA', 'baseA', sig);
  // A moved base branch at the same head must produce a different key.
  assert.notEqual(base, bypassCacheKey(7, 'headA', 'baseB', sig));
  // A new head commit must produce a different key.
  assert.notEqual(base, bypassCacheKey(7, 'headB', 'baseA', sig));
  // Edited globs must produce a different key.
  assert.notEqual(base, bypassCacheKey(7, 'headA', 'baseA', bypassSignature([])));
  // Same inputs are stable across calls.
  assert.equal(base, bypassCacheKey(7, 'headA', 'baseA', sig));
});
