'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { BUILD_RULE, REVIEW_RULE, PRD_REVIEW_RULE } = require('./suite-guardrail');

const SRC = fs.readFileSync(path.join(__dirname, 'api', 'workflow.js'), 'utf8');

test('builders are told to extend an existing suite-wide check, not add one', () => {
  assert.match(BUILD_RULE, /Extend, don't add/);
  assert.match(BUILD_RULE, /Lighthouse/);
  assert.match(BUILD_RULE, /say why in your feedback/);
});

test('reviewers flag a duplicate as MEDIUM, never BLOCKING', () => {
  for (const rule of [REVIEW_RULE, PRD_REVIEW_RULE]) {
    assert.match(rule, /MEDIUM/);
    assert.doesNotMatch(rule, /is a BLOCKING|raise a BLOCKING/);
  }
});

test('the rule reaches the builder task and the test writer', () => {
  assert.match(SRC, /Do NOT refactor code outside this task scope\.\n\n\$\{suiteGuardrail\.BUILD_RULE\}/);
  assert.match(SRC, /- \*\*No trivial tests\*\*.*\n- \$\{suiteGuardrail\.BUILD_RULE\}/);
});

test('the rule reaches both code review prompts, the final reviewer and the PRD reviewers', () => {
  assert.equal(SRC.match(/\\n10\. \$\{suiteGuardrail\.REVIEW_RULE\}/g).length, 2, 'code review, first launch and relaunch');
  assert.match(SRC, /\n9\. \$\{suiteGuardrail\.REVIEW_RULE\}/, 'final review');
  assert.match(SRC, /\\n8\. \$\{suiteGuardrail\.PRD_REVIEW_RULE\}/, 'PRD review');
});
