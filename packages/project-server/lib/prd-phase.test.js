'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { derivePrdPhase, PHASES } = require('./prd-phase');

const ISO_NOW = '2026-04-30T12:00:00.000Z';
const ISO_EARLIER = '2026-04-30T08:00:00.000Z';
const ISO_DAYS_AGO = '2026-04-25T08:00:00.000Z';

function prd(overrides = {}) {
  return {
    id: 'PRD-100',
    title: 'Test PRD',
    path: 'docs/prds/PRD-100-test.md',
    ...overrides,
  };
}

function snap(type, completedAt, extras = {}) {
  return { type, completedAt, ...extras };
}

// ─── PHASES export ──────────────────────────────────────────────────────────

test('PHASES export lists exactly the 5 supported states', () => {
  assert.deepEqual(PHASES, ['drafted', 'reviewed', 'implemented', 'done', 'deferred']);
});

// ─── Phase: done ────────────────────────────────────────────────────────────

test('phase=done when backlog row is marked done (highest priority)', () => {
  const out = derivePrdPhase({
    prdFile: prd(),
    workflow: { type: 'execution', currentStep: 'task_execution', round: 1 },
    snapshots: [snap('review', ISO_EARLIER, { approved: true })],
    gitState: { mergedSha: 'abc123', mergedAt: ISO_EARLIER },
    backlog: { status: 'done', doneAt: ISO_NOW },
  });
  assert.equal(out.phase, 'done', 'done must beat every active signal');
  assert.equal(out.phaseSince, ISO_NOW);
});

// ─── Phase: deferred ────────────────────────────────────────────────────────

test('phase=deferred when backlog row marked deferred (beats workflow + git)', () => {
  const out = derivePrdPhase({
    prdFile: prd(),
    workflow: null,
    snapshots: [],
    gitState: {},
    backlog: {
      status: 'deferred',
      deferredAt: ISO_NOW,
      reason: 'Waiting on partner integration',
      previousPhase: 'reviewed',
      previousPhaseAt: ISO_DAYS_AGO,
    },
  });
  assert.equal(out.phase, 'deferred');
  assert.equal(out.phaseSince, ISO_NOW);
  assert.equal(out.deferred.reason, 'Waiting on partner integration');
  assert.equal(out.deferred.previousPhase, 'reviewed');
  assert.equal(out.deferred.previousPhaseAt, ISO_DAYS_AGO);
});

test('phase=deferred fills previousPhase=null when not recorded', () => {
  const out = derivePrdPhase({
    prdFile: prd(),
    workflow: null,
    snapshots: [],
    gitState: {},
    backlog: { status: 'deferred', deferredAt: ISO_NOW, reason: 'tbd' },
  });
  assert.equal(out.deferred.previousPhase, null);
});

// ─── Phase: implemented ─────────────────────────────────────────────────────

test('phase=implemented when execution merge commit is on main', () => {
  const out = derivePrdPhase({
    prdFile: prd(),
    workflow: null,
    snapshots: [snap('execution', ISO_DAYS_AGO, { approved: true })],
    gitState: { mergedSha: 'abc1234', mergedAt: ISO_EARLIER },
    backlog: { status: 'active' },
  });
  assert.equal(out.phase, 'implemented');
  assert.equal(out.mergedSha, 'abc1234');
  assert.equal(out.phaseSince, ISO_EARLIER);
});

test('phase=implemented even while a follow-up workflow is running', () => {
  // The user can start a new review/execution after merge — phase reflects
  // the persisted ladder state, not the in-flight workflow.
  const out = derivePrdPhase({
    prdFile: prd(),
    workflow: { type: 'execution', currentStep: 'task_execution', round: 2, updatedAt: ISO_NOW },
    snapshots: [snap('execution', ISO_DAYS_AGO, { approved: true })],
    gitState: { mergedSha: 'oldmerge', mergedAt: ISO_EARLIER },
    backlog: { status: 'active' },
  });
  assert.equal(out.phase, 'implemented');
  assert.equal(out.currentWorkflow.type, 'execution', 'workflow context still surfaced');
  assert.equal(out.currentWorkflow.round, 2);
});

// ─── Phase: reviewed ────────────────────────────────────────────────────────

test('phase=reviewed when latest review snapshot ran to completion', () => {
  const out = derivePrdPhase({
    prdFile: prd(),
    workflow: null,
    snapshots: [snap('review', ISO_EARLIER, { approved: true })],
    gitState: {},
    backlog: { status: 'active' },
  });
  assert.equal(out.phase, 'reviewed');
  assert.equal(out.phaseSince, ISO_EARLIER);
  assert.equal(out.currentWorkflow, null);
});

test('phase=drafted when only mid-review snapshots exist (approved=false)', () => {
  // Snapshots from ongoing review don't flip the phase — only completed ones do.
  const out = derivePrdPhase({
    prdFile: prd({ createdAt: ISO_DAYS_AGO }),
    workflow: { type: 'review', currentStep: 'reviewing', round: 1, updatedAt: ISO_NOW },
    snapshots: [snap('review', ISO_EARLIER, { approved: false })],
    gitState: {},
    backlog: { status: 'active' },
  });
  assert.equal(out.phase, 'drafted', 'in-progress review keeps phase at drafted');
});

test('phase=reviewed picks the latest approved review snapshot for phaseSince', () => {
  const out = derivePrdPhase({
    prdFile: prd(),
    workflow: null,
    snapshots: [
      snap('review', ISO_DAYS_AGO, { approved: true }),
      snap('review', ISO_EARLIER, { approved: true }),
    ],
    gitState: {},
    backlog: { status: 'active' },
  });
  assert.equal(out.phase, 'reviewed');
  assert.equal(out.phaseSince, ISO_EARLIER);
});

// ─── Phase: drafted ─────────────────────────────────────────────────────────

test('phase=drafted: PRD file exists, no review snapshot, no workflow active', () => {
  const out = derivePrdPhase({
    prdFile: prd({ createdAt: ISO_DAYS_AGO }),
    workflow: null,
    snapshots: [],
    gitState: {},
    backlog: { status: 'active' },
  });
  assert.equal(out.phase, 'drafted');
  assert.equal(out.phaseSince, ISO_DAYS_AGO, 'drafted phase anchored on file creation time');
});

test('phase=drafted while a review workflow is running but not yet completed', () => {
  const out = derivePrdPhase({
    prdFile: prd({ createdAt: ISO_DAYS_AGO }),
    workflow: { type: 'review', currentStep: 'reviewing', round: 1, updatedAt: ISO_NOW },
    snapshots: [],
    gitState: {},
    backlog: { status: 'active' },
  });
  assert.equal(out.phase, 'drafted');
  assert.equal(out.currentWorkflow.type, 'review');
});

// ─── Null PRD ───────────────────────────────────────────────────────────────

test('null prdFile → null result (caller wraps as { prd: null })', () => {
  const out = derivePrdPhase({
    prdFile: null,
    workflow: null,
    snapshots: [],
    gitState: {},
    backlog: null,
  });
  assert.equal(out, null);
});

// ─── Phase priority ─────────────────────────────────────────────────────────

test('priority: done beats deferred', () => {
  const out = derivePrdPhase({
    prdFile: prd(),
    workflow: null,
    snapshots: [],
    gitState: {},
    backlog: { status: 'done', deferredAt: ISO_DAYS_AGO, doneAt: ISO_NOW },
  });
  assert.equal(out.phase, 'done');
});

test('priority: deferred beats implemented', () => {
  const out = derivePrdPhase({
    prdFile: prd(),
    workflow: null,
    snapshots: [],
    gitState: { mergedSha: 'abc', mergedAt: ISO_EARLIER },
    backlog: { status: 'deferred', deferredAt: ISO_NOW, reason: 'paused after merge' },
  });
  assert.equal(out.phase, 'deferred');
});

test('priority: implemented beats reviewed', () => {
  const out = derivePrdPhase({
    prdFile: prd(),
    workflow: null,
    snapshots: [snap('review', ISO_DAYS_AGO, { approved: true })],
    gitState: { mergedSha: 'abc', mergedAt: ISO_EARLIER },
    backlog: { status: 'active' },
  });
  assert.equal(out.phase, 'implemented');
});

// ─── Default backlog status ─────────────────────────────────────────────────

test('missing backlog row treated as active (no spurious done/deferred)', () => {
  const out = derivePrdPhase({
    prdFile: prd({ createdAt: ISO_DAYS_AGO }),
    workflow: null,
    snapshots: [],
    gitState: {},
    backlog: null,
  });
  assert.equal(out.phase, 'drafted');
});

// ─── Field passthrough ─────────────────────────────────────────────────────

test('output preserves PRD id/title/path verbatim', () => {
  const out = derivePrdPhase({
    prdFile: { id: 'PRD-061', title: 'Marketing pipeline', path: 'docs/prds/PRD-061-x.md' },
    workflow: null,
    snapshots: [],
    gitState: {},
    backlog: { status: 'active' },
  });
  assert.equal(out.id, 'PRD-061');
  assert.equal(out.title, 'Marketing pipeline');
  assert.equal(out.path, 'docs/prds/PRD-061-x.md');
});
