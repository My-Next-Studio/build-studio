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

test('scoping hands over to the interview only when the sequence names it', () => {
  const r = region("if (wf.currentStep === 'pm_scoping' && action === 'approve') {", '// owner_interview —');
  assert.match(r, /nextStepInSequence\(wf, config, 'pm_scoping'\) === kickoffInterview\.STEP/);
  // Everything else keeps the old routing, so a run parked on the old gate and
  // a custom sequence still work.
  assert.match(r, /: 'owner_consultations';/);
});

test('the old consultation gate still works for runs that reach it', () => {
  assert.ok(SRC.includes("if (wf.currentStep === 'owner_consultations' && action === 'approve') {"));
});

test('Finish commits the interview BEFORE moving on; Skip does not commit', () => {
  const r = region('if (wf.currentStep === kickoffInterview.STEP) {', "if (wf.currentStep === 'owner_consultations' && action === 'approve') {");
  const fin = r.slice(r.indexOf("if (action === 'approve' || action === 'skip') {"));
  assert.match(fin, /if \(action === 'skip'\) return advance\(\);/);
  const commit = fin.indexOf('scopedCommit(projectRoot, paths,');
  assert.ok(commit > 0, 'Finish commits');
  assert.ok(fin.indexOf('.then(advance)') > commit, 'and advances only after the commit settles');
  assert.match(fin, /wf\.currentStep = 'team_review'/);
  // An unknown action is refused, not silently treated as one of these.
  assert.match(r, /owner_interview: unknown action/);
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
