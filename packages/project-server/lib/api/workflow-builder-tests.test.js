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
  assert.match(r.goalClause, /XCUITest class this branch adds or modifies versus main/);
  assert.match(r.goalClause, /full XCUITest regression suite is NOT required/);
  assert.match(r.guidance, /Do NOT run the full XCUITest regression suite/);
  assert.match(r.guidance, /git diff --name-only --diff-filter=AM main\.\.\.HEAD -- '\*UITests\/\*\.swift'/);
  assert.match(r.guidance, /a shared support file declares none/);
});

test('the base branch and a configured unit-test target reach the text', () => {
  const r = builderTestRequirement({ qa_validation: { scope: 'new-uitests', unit_test_target: 'FazonTests' } }, 'develop');
  assert.match(r.goalClause, /versus develop/);
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
