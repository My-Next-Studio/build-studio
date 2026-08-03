'use strict';

// A review run has exactly one way to finish, and it goes through
// companion_specs.
//
// It used to have three, and only one of them did the whole job:
//   1. companion_specs approve  → specs written, item → Reviewed   ✅
//   2. round cap exceeded       → straight to 'completed'          ❌
//   3. clean approval in-round  → straight to 'completed'          ❌
//
// Paths 2 and 3 skipped companion_specs, and because the backlog transition
// lived inside the companion_specs handler, path 2 also left the item at
// Drafted. fazon FAZ-218 (2026-08-01) hit path 2: the review ran its full four
// rounds, capped at round 5, reported "completed", and left the item Drafted
// with two of three Required companion specs never written — while the PRD's
// own preparation gate says every Required spec must exist before execution.
//
// These read the source rather than driving the express app, because what is
// being pinned is a control-flow invariant across three handlers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'workflow.js'), 'utf8');

/**
 * The body of handleReviewAdvance, bounded by the next top-level function.
 * (Bounding on a section comment is wrong — the kickoff banner sits *earlier*
 * in the file, so searching forward from here finds nothing and the "region"
 * silently becomes the rest of the file, sweeping in every other workflow
 * type's completions.)
 */
function reviewRegion() {
  const start = SRC.indexOf('function handleReviewAdvance');
  assert.ok(start > 0, 'handleReviewAdvance not found');
  const next = /\n {2}function (?!handleReviewAdvance)\w+\(/.exec(SRC.slice(start + 10));
  assert.ok(next, 'could not find the end of handleReviewAdvance');
  return SRC.slice(start, start + 10 + next.index);
}

test('the round cap halts for a decision instead of picking an outcome', () => {
  // Hitting the cap says the loop ran as long as it was allowed — not that the
  // PRD is finished. The engine must not choose; it stops and asks.
  const region = reviewRegion();
  const cap = region.indexOf('wf.round > MAX_REVIEW_ROUNDS');
  assert.ok(cap > 0, 'round cap branch not found');
  const branch = region.slice(cap, cap + 1400);
  assert.match(branch, /wf\.currentStep = 'review_cap_reached'/);
  assert.match(branch, /status: 'blocked'/); // auto-advance refuses blocked steps
  assert.match(branch, /cap: 'review'/);     // distinguishes it from the fix loop
  assert.doesNotMatch(branch, /wf\.currentStep = 'completed'/);
  assert.doesNotMatch(branch, /wf\.currentStep = 'companion_specs'/);
});

test('the cap step offers both ways out, and defaults to neither', () => {
  const region = reviewRegion();
  const i = region.indexOf("wf.currentStep === 'review_cap_reached'");
  assert.ok(i > 0, 'review cap handler not found');
  const handler = region.slice(i, i + 1600);
  assert.match(handler, /action === 'another_round'/);
  assert.match(handler, /wf\.currentStep = 'reviewing'/);
  assert.match(handler, /wf\.currentStep = 'companion_specs'/);
  // No fall-through: an unrecognised action is refused, not silently resolved.
  assert.match(handler, /res\.status\(400\)/);
  // And the run cannot finish from here.
  assert.doesNotMatch(handler, /wf\.currentStep = 'completed'/);
});

test('a clean in-round approval moves to companion_specs, not straight to completed', () => {
  const clean = SRC.indexOf('if (allCleanApproval)');
  assert.ok(clean > 0, 'clean-approval branch not found');
  const branch = SRC.slice(clean, clean + 900);
  assert.match(branch, /wf\.currentStep = 'companion_specs'/);
  assert.doesNotMatch(branch, /wf\.currentStep = 'completed'/);
});

test('only completeReviewWorkflow marks a review run completed', () => {
  // Any future branch that ends a review must call the helper, so the backlog
  // transition cannot be forgotten by whichever path happens to reach the end.
  const region = reviewRegion();
  const completions = region.match(/wf\.currentStep = 'completed'/g) || [];
  assert.equal(completions.length, 0, 'a review branch sets completed directly instead of calling completeReviewWorkflow');
  assert.match(region, /completeReviewWorkflow\(wf\)/);
});

test('completeReviewWorkflow marks the backlog item Reviewed', () => {
  const i = SRC.indexOf('function completeReviewWorkflow');
  assert.ok(i > 0);
  const body = SRC.slice(i, i + 700);
  assert.match(body, /wf\.currentStep = 'completed'/);
  assert.match(body, /advanceLinkedFeatures\(wf\.prdPath, 'Reviewed'\)/);
  assert.match(body, /writeWorklog\(wf\)/);
});

test('the backlog transition lives only in the completion helper', () => {
  // Not in a step handler, where a skipped step takes it down too.
  const hits = (SRC.match(/advanceLinkedFeatures\(wf\.prdPath, 'Reviewed'\)/g) || []).length;
  assert.equal(hits, 1, `expected exactly one Reviewed transition, found ${hits}`);
});

// ─── Silence is not consent (2026-08-03) ────────────────────────────────────
//
// A reviewer that errored WITHOUT reporting has not said "no objection" — it
// has said nothing. Treating `error` as a terminal state let one returning
// reviewer carry a whole round forward on its own verdict while five others
// were silent, and the run completed as approved with five reviews missing.

test('an errored reviewer that never reported blocks the approve', () => {
  const region = reviewRegion();
  const i = region.indexOf('rvSilent');
  assert.ok(i > 0, 'the silent-reviewer guard is missing');
  const guard = region.slice(i - 400, i + 1200);
  // Silence is defined as errored AND no feedback — an errored agent that DID
  // report still counts, since its verdict is known.
  assert.match(guard, /status === 'error' && !a\.feedback/);
  assert.match(guard, /res\.status\(409\)/);
  // And it must be escapable, or a genuinely dead reviewer deadlocks the run.
  assert.match(guard, /override !== true/);
});

test('the running-vs-silent distinction is kept separate', () => {
  // "Still running" and "errored without reporting" need different messages:
  // one resolves by waiting, the other never does.
  const region = reviewRegion();
  assert.match(region, /rvRunning/);
  assert.match(region, /still running/);
  assert.match(region, /failed without reporting/);
});

// ─── Feedback cannot land in a step it was not meant for ────────────────────

test('feedback naming a closed step is refused, not misfiled', () => {
  // Four PRD reviews were recorded as companion-spec deliverables because the
  // handler matches by role within whatever step is current — marking that step
  // done without a single spec being written.
  const i = SRC.indexOf('claimedStep');
  assert.ok(i > 0, 'the step stamp is missing from the feedback handler');
  const guard = SRC.slice(i, i + 1400);
  assert.match(guard, /claimedStep !== wf\.currentStep/);
  assert.match(guard, /res\.status\(409\)/);
  assert.match(guard, /NOT recorded/);
});

test('the generated feedback curl carries the step it belongs to', () => {
  // The guard only works if agents actually send it.
  const curls = SRC.match(/api\/workflow\/feedback[^`]*?feedback":"<[^`]*?'/g) || [];
  assert.ok(curls.length >= 4, `expected every agent feedback curl, found ${curls.length}`);
  for (const c of curls) {
    assert.match(c, /"step":"\$\{(resolvedStep|wf\.currentStep)\}"/, `curl without a step stamp: ${c.slice(0, 120)}`);
  }
});
