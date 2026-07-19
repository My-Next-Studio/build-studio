'use strict';

// Tests for qaStrictGateVerdict — the qa_validation strict gate's pure verdict.
// Regression focus: the gate must AGREE with the auto-advance tick, which has
// always honored a certified-clean verdict (Approved: yes + Blocking: 0).
// Before honor_clean_approval defaulted on, tick-approve → gate-400 → step
// paused after the rejection cap (fazon PRD-026, deskrhythm PRD-025,
// launch-studio PRD-016 — three stalls, three overrides, zero real catches).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { qaStrictGateVerdict } = require('./workflow');

const CERTIFIED_WITH_FLAKE = [
  '**Tests passed:** 1305/1305 (unit) + 143/143 stable + 1 flaky-confirmed (E2E)',
  '',
  '**Approved:** yes',
  '**Blocking:** 0',
  '',
  'Full E2E: 143 passed, 1 failed on first pass — re-ran in isolation: passed.',
].join('\n');

const UNCERTIFIED_FAILURES = [
  '**Tests passed:** 520/525',
  '**Approved:** no',
  '**Blocking:** 2',
  '5 failed',
].join('\n');

test('certified-clean verdict passes despite a failing count (default config)', () => {
  const v = qaStrictGateVerdict(CERTIFIED_WITH_FLAKE, {}, false);
  assert.equal(v.blocked, false);
  assert.equal(v.cleanApproval, true);
  assert.equal(v.failingCount, 1);
  assert.equal(v.honoredBypass, true); // must be recorded on the step
});

test('uncertified failures still block (the strict property that matters)', () => {
  const v = qaStrictGateVerdict(UNCERTIFIED_FAILURES, {}, false);
  assert.equal(v.blocked, true);
  assert.equal(v.failingCount, 5);
  assert.equal(v.honoredBypass, false);
});

test('failures with NO structured verdict markers block', () => {
  const v = qaStrictGateVerdict('Ran suite: 3 failed, 140 passed.', {}, false);
  assert.equal(v.blocked, true);
  assert.equal(v.cleanApproval, false);
});

test('Approved: yes alone (no Blocking: 0) is not a certified verdict', () => {
  const fb = '**Approved:** yes\n2 failed';
  const v = qaStrictGateVerdict(fb, {}, false);
  assert.equal(v.blocked, true);
});

test('explicit opt-out restores block-on-any-failure even when certified', () => {
  const cfg = { qa_validation: { honor_clean_approval: false } };
  const v = qaStrictGateVerdict(CERTIFIED_WITH_FLAKE, cfg, false);
  assert.equal(v.blocked, true);
  assert.equal(v.cleanApproval, true); // certification recognized, deliberately not honored
});

test('operator override passes and is NOT an honored bypass (separate audit entry)', () => {
  const cfg = { qa_validation: { honor_clean_approval: false } };
  const v = qaStrictGateVerdict(UNCERTIFIED_FAILURES, cfg, true);
  assert.equal(v.blocked, false);
  assert.equal(v.honoredBypass, false);
});

test('zero failures is a plain pass — never an honored bypass, nothing to audit', () => {
  const v = qaStrictGateVerdict('**Approved:** yes\n**Blocking:** 0\nAll 143 passed.', {}, false);
  assert.equal(v.blocked, false);
  assert.equal(v.honoredBypass, false);
});

test('strict: false disables the gate entirely', () => {
  const cfg = { qa_validation: { strict: false } };
  const v = qaStrictGateVerdict(UNCERTIFIED_FAILURES, cfg, false);
  assert.equal(v.blocked, false);
});

test('PRD numbers are not parsed as failure counts (lookbehind regression)', () => {
  const v = qaStrictGateVerdict('**Approved:** yes\n**Blocking:** 0\n0 PRD-080 failures on main.', {}, false);
  assert.equal(v.failingCount, 0);
  assert.equal(v.blocked, false);
  assert.equal(v.honoredBypass, false);
});

test('failure count parsed from "(N failed" parenthetical form', () => {
  const v = qaStrictGateVerdict('suite red (4 failed, 139 passed)', {}, false);
  assert.equal(v.failingCount, 4);
  assert.equal(v.blocked, true);
});
