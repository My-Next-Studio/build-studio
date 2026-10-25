'use strict';

// What the goal-harness builder must run before it is done. A project that
// scopes QA's XCUITests to the branch (qa_validation.scope=new-uitests) gets the
// same scope for the builder; the full UI regression runs periodically and
// before a release. Before this, fazon FAZ-062 (2026-10-05) spent 217 minutes in
// one task, most of it a serial run of ~700 UI tests the project had opted out of.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { builderTestRequirement } = require('./workflow');

test('without a scope setting the builder still runs the complete suite', () => {
  for (const config of [{}, { qa_validation: {} }, { qa_validation: { scope: 'full' } }, null]) {
    const r = builderTestRequirement(config);
    assert.match(r.goalClause, /the COMPLETE test suite/);
    assert.match(r.guidance, /final verification run is the full suite/);
  }
});

test('scope=new-uitests: unit and other suites in full, XCUITests only for the branch', () => {
  const r = builderTestRequirement({ qa_validation: { scope: 'new-uitests' } }, 'main');
  assert.doesNotMatch(r.goalClause, /COMPLETE test suite/);
  assert.match(r.goalClause, /every unit test .* pre-implementation tests/);
  assert.match(r.goalClause, /every other non-XCUITest suite has been run in full/);
  assert.match(r.goalClause, /every XCUITest that `node "\$BUILD_STUDIO_UITEST_SCOPE"` lists for this branch versus main/);
  assert.match(r.goalClause, /full XCUITest regression suite is NOT required/);
  assert.match(r.guidance, /Do NOT run the full XCUITest regression suite/);
  // The list comes from the same code QA's run uses (uitest-scope.js), per
  // test in a modified file (fazon FAZ-460, 2026-10-25).
  assert.match(r.guidance, /`node "\$BUILD_STUDIO_UITEST_SCOPE" main`/);
  assert.match(r.guidance, /only the tests that reach the changed code run/);
  assert.match(r.guidance, /run the command again after your last change to a UI test file/);
  // The class rule survives only as the fallback for a missing variable.
  assert.match(r.guidance, /Only if `\$BUILD_STUDIO_UITEST_SCOPE` is unset: .*git diff --name-only --diff-filter=AM main\.\.\.HEAD -- '\*UITests\/\*\.swift'/);
  assert.match(r.guidance, /a shared support file declares none/);
});

test('the builder\'s start script exports the scope command beside the clone reaper', () => {
  const src = fs.readFileSync(path.join(__dirname, 'workflow.js'), 'utf8');
  assert.match(src, /export BUILD_STUDIO_UITEST_SCOPE=\$\{JSON\.stringify\(uitestScopeScript\)\}/);
  assert.match(src, /const uitestScopeScript = path\.join\(__dirname, '\.\.', 'uitest-scope-cli\.js'\);/);
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'uitest-scope-cli.js')));
});

test('QA\'s run takes its XCUITests from the same computation', () => {
  const src = fs.readFileSync(path.join(__dirname, 'workflow.js'), 'utf8');
  assert.match(src, /const uiScope = uitestScope\.computeUiTestScope\(\{ cwd: projectRoot, base: 'main' \}\);/);
  assert.match(src, /testOnly\.classes\.filter\(c => !isUiTarget\(c\)\)/, 'a test-only branch must not bring a modified UI class back whole');
});

test('the base branch and a configured unit-test target reach the text', () => {
  const r = builderTestRequirement({ qa_validation: { scope: 'new-uitests', unit_test_target: 'FazonTests' } }, 'develop');
  assert.match(r.goalClause, /versus develop/);
  assert.match(r.guidance, /"\$BUILD_STUDIO_UITEST_SCOPE" develop/);
  assert.match(r.guidance, /develop\.\.\.HEAD/);
  assert.match(r.guidance, /\(FazonTests\)/);
});

test('the builder goal is built from the helper, not a second hand-written copy', () => {
  const src = fs.readFileSync(path.join(__dirname, 'workflow.js'), 'utf8');
  assert.match(src, /const testRequirement = builderTestRequirement\(config, wf\.defaultBranch \|\| 'main'\);/);
  assert.match(src, /is implemented; \$\{testRequirement\.goalClause\};/);
  assert.match(src, /\$\{testRequirement\.guidance\}/);
  // No hand-written copy of the full-suite goal outside the helper.
  assert.doesNotMatch(src.slice(src.indexOf("const goalCondition")), /the COMPLETE test suite \(including/);
});
