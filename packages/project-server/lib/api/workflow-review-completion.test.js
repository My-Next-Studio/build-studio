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
  const cap = region.indexOf('if (capExceeded(wf)) {');
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

// ── execution-run cap ────────────────────────────────────────────────────────
//
// Approving the fix-loop cap in an execution run delegates to the source
// step's own approve. For qa_validation that approve carries a strict gate
// which re-reads the round's failing test counts and refuses — leaving the
// run parked on a completed qa_validation step that the auto-advance tick then
// evaluates from the same stale report and sends back into fix_plan. The
// planner is handed findings it has already seen fixed. fazon, 2026-09-22:
// two rounds burnt this way before the 0-task gate halted it.

function executionCapRegion() {
  const i = SRC.indexOf("const source = wf.fixSource || wf.returnTo || 'code_review';");
  assert.ok(i > 0, 'execution cap handler not found');
  return SRC.slice(i, i + 3600);
}

test('accepting findings at the execution cap (skip) tells the delegated approve it is an operator override', () => {
  const region = executionCapRegion();
  const approve = region.indexOf("if (action === 'skip') {");
  assert.ok(approve > 0);
  const branch = region.slice(approve, approve + 1400);
  assert.match(branch, /override: true/);
  // The delegate must receive the override body, not the raw one.
  assert.match(branch, /handleExecutionAdvance\(wf, 'approve', notes, res, capBody\)/);
  assert.doesNotMatch(branch, /handleExecutionAdvance\(wf, 'approve', notes, res, body\)/);
});

test('the 0-task gate counts triaged blocking findings, not blocking plus failing tests', () => {
  const i = SRC.indexOf('const totalFindings = cleanApproval ? 0 :');
  assert.ok(i > 0, 'totalFindings not found');
  const line = SRC.slice(i, SRC.indexOf('\n', i));
  // A report with `Blocking: 7` and `9 failures` has 7 findings, not 16.
  assert.doesNotMatch(line, /failureCount \+ blockingCount/);
  assert.match(line, /blockingMatch \? blockingCount : failureCount/);
});

test('relaunching a step clears the auto-advance refusal pause for it', () => {
  // Otherwise the pause from the previous attempt outlives the relaunch and the
  // tick silently skips the fresh result (fazon, 2026-09-24).
  const i = SRC.indexOf("if (action === 'relaunch') {");
  assert.ok(i > 0, 'relaunch handler not found');
  const branch = SRC.slice(i, i + 1200);
  assert.match(branch, /_aaReject = \{ step: null, count: 0, error: null \}/);
});

// A server-run suite lasts hours. Its callbacks must act on the workflow as it
// is when they fire, not on the copy loaded when the suite started: saving that
// copy on every passing test reverted auto-advance switched off mid-run within
// seconds (fazon, 2026-09-27).
test('suite progress re-reads the workflow before saving', () => {
  const i = SRC.indexOf('onProgress: (p) => {');
  assert.ok(i > 0, 'onProgress not found');
  const body = SRC.slice(i, SRC.indexOf('},', i));
  const adopt = body.indexOf('adoptCurrentWorkflow()');
  const save = body.indexOf('state.saveWorkflow(wf)');
  assert.ok(adopt > 0 && save > adopt, 'must adopt the current workflow before saving');
  assert.match(body, /isThisRun\(/);
});

test('suite completion ignores a run its step has moved past', () => {
  const i = SRC.indexOf('function attachSuiteCompletion(handle, runTimeoutMs) {');
  assert.ok(i > 0, 'attachSuiteCompletion not found');
  const body = SRC.slice(i, i + 1600);
  const adopt = body.indexOf('adoptCurrentWorkflow()');
  const launch = body.indexOf('launchQaAgent(');
  assert.ok(adopt > 0 && launch > adopt, 'must adopt the current workflow before launching the QA agent');
  assert.match(body, /isThisRun\(step\.suiteRun, handle\.pid\)/);
});

test('send_to_devs without a QA report needs an override AND notes', () => {
  const i = SRC.indexOf("if (wf.currentStep === 'qa_validation' && action === 'send_to_devs') {");
  assert.ok(i > 0, 'send_to_devs handler not found');
  const body = SRC.slice(i, i + 3000);
  assert.match(body, /const ownerDirected = !qaFeedback\.trim\(\) && body\.override === true && typeof notes === 'string' && notes\.trim\(\);/);
  // The plain no-feedback refusal still exists for every other case.
  assert.match(body, /Cannot send to devs: qa_validation has no feedback/);
  assert.ok(body.indexOf('ownerDirected') < body.indexOf('Cannot send to devs: qa_validation has no feedback'));
});


// The cap is a loop guard. Continuing past it must lead where the loop would
// have gone without it — back to the review that raised the findings — and
// never skip that review (launch-studio LS-166, 2026-09-29: approving at the
// cap merged a fix round nobody reviewed, with a BLOCKING finding open).
test('execution cap: approve continues to the source review with a fresh budget', () => {
  const region = executionCapRegion();
  const i = region.indexOf("if (action === 'approve' || action === 'another_round') {");
  assert.ok(i > 0, 'approve/continue branch missing');
  const branch = region.slice(i, region.indexOf("if (action === 'skip') {"));
  assert.match(branch, /restartCapBudget\(wf\)/);
  assert.match(branch, /wf\.currentStep = source;/);
  assert.doesNotMatch(branch, /handleExecutionAdvance/, 'must not run the source step\'s approve (that skips the review)');
  assert.doesNotMatch(branch, /wf\.round = 1/, 'the run\'s round number is not rewritten');
});

test('review cap: approve reviews again; stopping for companion specs needs skip', () => {
  const region = reviewRegion();
  const i = region.indexOf("wf.currentStep === 'review_cap_reached'");
  const handler = region.slice(i, i + 1800);
  const cont = handler.slice(handler.indexOf("if (action === 'approve' || action === 'another_round') {"), handler.indexOf("if (action === 'skip') {"));
  assert.match(cont, /wf\.currentStep = 'reviewing'/);
  assert.match(cont, /restartCapBudget\(wf\)/);
  const stop = handler.slice(handler.indexOf("if (action === 'skip') {"));
  assert.match(stop, /wf\.currentStep = 'companion_specs'/);
});

test('every review and fix-loop cap counts from the budget base, not from round 1', () => {
  const raised = SRC.split("wf.currentStep = 'review_cap_reached';").length - 1;
  assert.equal(raised, 4, 'four places raise the cap');
  assert.equal((SRC.match(/if \(capExceeded\(wf\)\) \{/g) || []).length, 4);
  assert.match(SRC, /return \(wf\.round - \(wf\.capBaseRound \|\| 0\)\) > MAX_REVIEW_ROUNDS;/);
});

// fazon FAZ-383, 2026-09-30: QA found a CLS regression (Blocking: 1) and, in a
// separate check, a missing Python module. The environment guard refused the
// whole report, so the regression never reached a developer.
test('send_to_devs routes real defects even when a check could not run', () => {
  const i = SRC.indexOf("if (wf.currentStep === 'qa_validation' && action === 'send_to_devs') {");
  const body = SRC.slice(i, SRC.indexOf('// --- Fix plan: relaunch', i));
  const mixed = body.indexOf('if (defectsToo) {');
  const refusal = body.indexOf('if (qaBlocked && body.override !== true) {');
  assert.ok(mixed > 0 && refusal > mixed, 'the mixed case must be decided before the environment refusal');
  assert.match(body, /gateBlocked\.blockingCount\(qaFeedback\) > 0/);
  assert.match(body.slice(mixed, refusal), /plannerNoteForBlockedGate/);
});
