'use strict';

// The lean execution preset's pure half: which runs are lean, who may start
// one, where a fix round returns, and what the builder and reviewer are told.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const lean = require('./lean-execution');

test('only an execution run with preset lean is lean', () => {
  assert.equal(lean.isLean({ type: 'execution', preset: 'lean' }), true);
  assert.equal(lean.isLean({ type: 'execution' }), false);
  // A bugfix is already short; the preset does not apply to it.
  assert.equal(lean.isLean({ type: 'bugfix', preset: 'lean' }), false);
  assert.equal(lean.isLean(null), false);
});

test('the lean sequence drops qa_tests and the separate review steps, and keeps the gates', () => {
  const seq = lean.LEAN_EXECUTION_STEPS;
  for (const dropped of ['qa_tests', 'code_review', 'coverage_matrix', 'ac_verification', 'security_audit', 'final_review']) {
    assert.ok(!seq.includes(dropped), `${dropped} must not run in a lean run`);
  }
  // The merge gates and the bookkeeping stay, in order.
  assert.deepEqual(seq.slice(-3), ['qa_validation', 'merge_to_main', 'capture_learnings']);
  assert.ok(seq.indexOf('merge_for_review') < seq.indexOf('qa_validation'));
});

test('validatePreset: absent or full is the full chain, lean is execution only', () => {
  assert.deepEqual(lean.validatePreset('execution', undefined), { preset: null });
  assert.deepEqual(lean.validatePreset('execution', 'full'), { preset: null });
  assert.deepEqual(lean.validatePreset('execution', 'lean'), { preset: 'lean' });
  assert.match(lean.validatePreset('review', 'lean').error, /execution runs only/);
  assert.match(lean.validatePreset('execution', 'tiny').error, /full, lean/);
});

test('a lean run is refused when a build step is not on Claude, naming the step and CLI', () => {
  assert.equal(lean.leanStartRefusal(() => 'claude'), null);
  const msg = lean.leanStartRefusal((step) => (step === 'fix_execution' ? 'codex' : 'claude'));
  assert.match(msg, /fix_execution runs on codex/);
  assert.doesNotMatch(msg, /task_execution runs on/);
  assert.match(msg, /full chain/);
});

test('a lean fix round returns to the review that raised it', () => {
  assert.equal(lean.leanFixReturnStep({ fixSource: 'qa_validation' }), 'qa_validation');
  assert.equal(lean.leanFixReturnStep({}), 'qa_validation');
});

test('the builder is told to start a spec-only test writer and kept from feeding it the code', () => {
  const s = lean.leanBuilderSection({ prdPath: 'docs/prds/PRD-1.md', testClause: 'unit tests pass' });
  assert.match(s, /test-writer subagent/);
  assert.match(s, /docs\/prds\/PRD-1\.md/);
  assert.match(s, /Do \*\*not\*\* give it your implementation/);
  // Concurrency rules: file boundaries, and no suite run during edits.
  assert.match(s, /explicit boundary/);
  assert.match(s, /only while no subagent is editing/);
  assert.match(s, /unit tests pass/);
  assert.match(s, /### Subagents/);
});

test('the lean task description does not point at pre-implementation tests that do not exist', () => {
  const d = lean.leanTaskDescription('docs/prds/PRD-1.md');
  assert.match(d, /no pre-implementation tests/);
  assert.doesNotMatch(d, /un-skip/);
});

test('a lean fix round carries the findings, the PRD and the owner notes', () => {
  const s = lean.leanFixSection({ prdPath: 'docs/prds/PRD-1.md', findings: 'F-1 null deref', notes: 'keep the API' });
  assert.match(s, /F-1 null deref/);
  assert.match(s, /keep the API/);
  assert.match(s, /docs\/prds\/PRD-1\.md/);
  assert.match(s, /two-line fix is yours/);
  assert.doesNotMatch(lean.leanFixSection({ prdPath: 'p', findings: 'f' }), /Owner notes/);
});

test('the lean review header asks for both the test counts and the review verdict', () => {
  const h = lean.leanReviewHeader();
  assert.match(h, /\*\*Tests passed:\*\* N\/M/);
  assert.match(h, /\*\*Approved:\*\* yes \| no/);
  assert.match(h, /\*\*Blocking:\*\* N/);
  assert.match(h, /Gate could not run/);
  // The full chain's header says the opposite; it must not leak in.
  assert.doesNotMatch(h, /ONLY job is to run the test suite/);
});

test('round 1 reviews the whole branch and names the checks of the dropped steps', () => {
  const s = lean.leanReviewSection({ prdPath: 'docs/prds/PRD-1.md', defaultBranch: 'main', round: 1, fixBase: null, designFiles: [] });
  assert.match(s, /git diff main\.\.\.HEAD/);
  for (const concern of ['Acceptance criteria', 'Security', 'Test quality', 'Hygiene', 'AC Coverage']) {
    assert.match(s, new RegExp(concern));
  }
  assert.doesNotMatch(s, /Design conformance/);
});

test('a design check appears only when the PRD lists an approved design', () => {
  const s = lean.leanReviewSection({ prdPath: 'p', defaultBranch: 'main', round: 1, designFiles: ['design/home.pen'] });
  assert.match(s, /Design conformance.*design\/home\.pen/);
});

test('a re-review reads only the fix diff, and still says the suite runs in full', () => {
  const s = lean.leanReviewSection({ prdPath: 'p', defaultBranch: 'main', round: 2, fixBase: 'abc1234' });
  assert.match(s, /git diff abc1234\.\.HEAD/);
  assert.doesNotMatch(s, /main\.\.\.HEAD/);
  assert.match(s, /still the full suite/);
});

test('a re-review with no recorded fix base falls back to the whole branch', () => {
  const s = lean.leanReviewSection({ prdPath: 'p', defaultBranch: 'main', round: 2, fixBase: null });
  assert.match(s, /git diff main\.\.\.HEAD/);
});

test('a lean fix round does not re-run the slow suites the review runs next', () => {
  const s = lean.leanFixSection({ prdPath: 'p', findings: 'f' });
  assert.match(s, /Do not run the UI test suites or any full end-to-end suite/);
  assert.doesNotMatch(s, /COMPLETE test suite|run in full/);
});

test('the builder gets the scope guidance when the goal harness is not carrying it', () => {
  const guidance = '- Do NOT run the full XCUITest regression suite.';
  assert.match(lean.leanBuilderSection({ prdPath: 'p', testClause: 't', testGuidance: guidance }), /### Which tests to run\n- Do NOT run the full XCUITest/);
  assert.doesNotMatch(lean.leanBuilderSection({ prdPath: 'p', testClause: 't', testGuidance: '' }), /Which tests to run/);
});
