'use strict';

// The kickoff's owner_interview step (docs/plans/kickoff-owner-interview.md).
// These read the source, like the other workflow control-flow tests, because
// what is pinned is routing between handlers, not one function's output.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { PRESETS } = require('../presets');

const SRC = fs.readFileSync(path.join(__dirname, 'workflow.js'), 'utf8');
const region = (start, end) => {
  const i = SRC.indexOf(start);
  assert.ok(i > 0, `not found: ${start}`);
  return SRC.slice(i, end ? SRC.indexOf(end, i) : i + 3000);
};

test('the presets that had an owner gate now interview; none keeps the old gate', () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    const seq = (p.workflow && p.workflow.kickoff) || [];
    assert.ok(!seq.includes('owner_consultations'), `${name} still lists owner_consultations`);
    if (seq.includes('owner_interview')) {
      assert.equal(seq[seq.indexOf('owner_interview') - 1], 'pm_scoping', `${name}: the interview follows scoping`);
      assert.equal(seq[seq.indexOf('owner_interview') + 1], 'team_review', `${name}: and comes before the review`);
    }
  }
});

// The fallbacks handleKickoffAdvance passes: the old fixed chain, used only for
// a step the sequence does not list.
const OLD_CHAIN = {
  ceo_synthesis: 'pm_scoping', pm_scoping: 'owner_consultations', owner_interview: 'team_review',
  owner_consultations: 'team_review', team_review: 'pm_revision', pm_revision: 'companion_specs',
  companion_specs: 'devops_init', devops_init: 'completed',
};

/** Walk a kickoff from its first step to the end, the way the handler routes it. */
function walk(seq) {
  const { sequenceNextStep } = require('./workflow');
  const visited = [];
  let step = seq.length ? seq[0] : 'ceo_synthesis';
  for (let guard = 0; step !== 'completed' && guard < 20; guard++) {
    visited.push(step);
    step = sequenceNextStep(seq, step, OLD_CHAIN[step]);
  }
  return visited;
}

test('every preset\'s kickoff runs exactly the steps its sequence lists, in order', () => {
  for (const [name, p] of Object.entries(PRESETS)) {
    assert.deepEqual(walk(p.workflow.kickoff), p.workflow.kickoff, name);
  }
});

test('fast-track runs no CEO synthesis, owner step or companion specs', () => {
  assert.deepEqual(walk(PRESETS['fast-track'].workflow.kickoff), ['pm_scoping', 'devops_init']);
});

test('api-only and static-site interview the owner and skip companion specs', () => {
  for (const name of ['api-only', 'static-site']) {
    const steps = walk(PRESETS[name].workflow.kickoff);
    assert.ok(steps.includes('owner_interview'), name);
    assert.ok(!steps.includes('companion_specs'), name);
    assert.ok(!steps.includes('owner_consultations'), name);
  }
});

test('a custom sequence that still names owner_consultations keeps the old gate', () => {
  const custom = ['ceo_synthesis', 'pm_scoping', 'owner_consultations', 'team_review', 'pm_revision', 'companion_specs', 'devops_init'];
  assert.deepEqual(walk(custom), custom);
});

test('a step outside the sequence falls back to the old chain', () => {
  const { sequenceNextStep } = require('./workflow');
  // A run parked on owner_consultations in a project whose sequence now lists
  // owner_interview still moves on to the review.
  assert.equal(sequenceNextStep(PRESETS['web-app'].workflow.kickoff, 'owner_consultations', 'team_review'), 'team_review');
});

test('the kickoff starts at the first step of its sequence', () => {
  assert.match(SRC, /currentStep = kickoffSeq\.length && steps\[kickoffSeq\[0\]\] \? kickoffSeq\[0\] : 'ceo_synthesis';/);
});

test('the old consultation gate still works for runs that reach it', () => {
  assert.ok(SRC.includes("if (wf.currentStep === 'owner_consultations' && action === 'approve') {"));
});

test('Finish commits the interview BEFORE moving on; Skip does not commit', () => {
  const r = region('function handleOwnerInterview(wf, action, res, { commitOnFinish }) {', '  // --- Kickoff workflow ---');
  const fin = r.slice(r.indexOf("if (action === 'approve' || action === 'skip') {"));
  assert.match(fin, /if \(action === 'skip'\) return advance\(\);/);
  const noCommit = fin.indexOf('if (!commitOnFinish) return advance();');
  const commit = fin.indexOf('scopedCommit(projectRoot, paths,');
  assert.ok(noCommit > 0 && commit > noCommit, 'commits only when asked to, after recording notesPath');
  assert.ok(fin.indexOf('.then(advance)') > commit, 'and advances only after the commit settles');
  assert.match(fin, /return advanceBySequence\(wf, res, kickoffInterview\.STEP, 'team_review'\);/, 'moves on by the sequence');
  // An unknown action is refused, not silently treated as one of these.
  assert.match(r, /owner_interview: unknown action/);
});

test('the kickoff commits on Finish; onboarding does not (owner_signoff makes its one commit)', () => {
  assert.ok(SRC.includes('return handleOwnerInterview(wf, action, res, { commitOnFinish: true });'));
  const onb = region('function handleOnboardingAdvance(wf, action, notes, res) {');
  assert.match(onb, /return handleOwnerInterview\(wf, action, res, \{ commitOnFinish: false \}\);/);
});

// The onboarding handler's old fixed chain, as its fallbacks pass it.
const ONBOARDING_OLD_CHAIN = {
  discovery: 'ceo_synthesis', ceo_synthesis: 'architect_backfill', architect_backfill: 'pm_synthesis',
  pm_synthesis: 'devops_detect', devops_detect: 'team_review', owner_interview: 'team_review',
  team_review: 'pm_revision', pm_revision: 'owner_signoff', owner_signoff: 'completed',
};

test('every preset\'s onboarding runs its sequence, with the interview before the review', () => {
  const { sequenceNextStep } = require('./workflow');
  for (const [name, p] of Object.entries(PRESETS)) {
    const seq = p.workflow.onboarding;
    if (!seq) continue; // fast-track defines no onboarding
    const visited = [];
    let step = seq[0];
    for (let guard = 0; step !== 'completed' && guard < 20; guard++) {
      visited.push(step);
      step = sequenceNextStep(seq, step, ONBOARDING_OLD_CHAIN[step]);
    }
    assert.deepEqual(visited, seq, name);
    assert.equal(seq[seq.indexOf('owner_interview') - 1], 'devops_detect', name);
    assert.equal(seq[seq.indexOf('owner_interview') + 1], 'team_review', name);
  }
});

test('a clean onboarding review still skips pm_revision, by the sequence', () => {
  const onb = region('function handleOnboardingAdvance(wf, action, notes, res) {', "action === 'skip_to_signoff'");
  assert.match(onb, /if \(!hasBlocking && sequenceNextStep\(seq, 'team_review', 'pm_revision'\) === 'pm_revision'\) \{/);
  assert.match(onb, /return advanceBySequence\(wf, res, 'pm_revision', 'owner_signoff'\);/);
});

test('auto-advance never acts on the interview, server or client', () => {
  assert.match(SRC, /const alwaysManual = \[[^\]]*'owner_interview'[^\]]*\];/);
  const hub = fs.readFileSync(path.join(__dirname, '../../../hub/components/workflow-view.tsx'), 'utf8');
  assert.match(hub, /const alwaysManual = \[[^\]]*'owner_interview'[^\]]*\]/);
});

test('review and revision read the interview summary, and still the old notes', () => {
  const uses = SRC.split("(wf.steps.owner_interview && wf.steps.owner_interview.notesPath) || (wf.steps.owner_consultations && wf.steps.owner_consultations.notesPath)").length - 1;
  assert.equal(uses, 2, 'team_review and pm_revision');
});

// The source-text test above passed while the routing was broken: stepSequence
// returned the EXECUTION sequence for a kickoff, so the lookup was always null
// and every kickoff went to owner_consultations. This one runs the lookup.
test('a kickoff\'s next step is looked up in the KICKOFF sequence', () => {
  const { nextStepInSequence, stepSequence } = require('./workflow');
  for (const [name, p] of Object.entries(PRESETS)) {
    const config = { workflow: p.workflow };
    const wf = { type: 'kickoff' };
    assert.deepEqual(stepSequence(wf, config), p.workflow.kickoff, `${name}: kickoff sequence`);
    const seq = p.workflow.kickoff;
    const i = seq.indexOf('pm_scoping');
    if (i >= 0 && i < seq.length - 1) assert.equal(nextStepInSequence(wf, config, 'pm_scoping'), seq[i + 1], name);
  }
  const webApp = { workflow: PRESETS['web-app'].workflow };
  assert.equal(nextStepInSequence({ type: 'kickoff' }, webApp, 'pm_scoping'), 'owner_interview');
});
