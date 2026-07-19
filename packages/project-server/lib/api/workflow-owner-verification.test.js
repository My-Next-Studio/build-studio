'use strict';

// Tests for the owner_verification step's pure helpers: checklist extraction
// from the AC verifier's `### Owner action items` section, and the
// evidence-presence gate. Regression focus: finance-studio PRD-004 capped at
// round 5 because the AC verifier deferred owner-gated ACs downstream while
// the final reviewer blocked on their absent evidence — the checklist these
// helpers implement is what makes that dispute structurally impossible.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractOwnerChecklist, ownerVerificationMissing } = require('./workflow');

const AC_FEEDBACK = [
  '**Approved:** yes',
  '**Blocking:** 0',
  '',
  '### AC Verification Matrix',
  '| AC-1 | build | MET | MANUAL | docs/pr-evidence/x.md |',
  '| AC-2 | Dock launch | UNTESTABLE (owner-gated) | MANUAL | requires real Dock |',
  '',
  '### Owner action items',
  '- AC-2: launch from the Dock, confirm normal window incl. keychain phase',
  '- [ ] AC-4 — secret persists across relaunch (DevTools console)',
  '* AC-7: FINANCE_STUDIO_HOME relocation still live packaged',
  '- AC-2: duplicate bullet should be deduped',
  '- a bullet with no AC id is ignored',
  '',
  '### Something after',
  '- AC-99: bullets outside the section are NOT checklist items',
].join('\n');

test('extracts one item per AC bullet, deduped, section-bounded', () => {
  const list = extractOwnerChecklist(AC_FEEDBACK);
  assert.deepEqual(list.map(i => i.ac), ['AC-2', 'AC-4', 'AC-7']);
  assert.match(list[0].text, /Dock/);
});

test('checkbox and asterisk bullet forms both parse', () => {
  const list = extractOwnerChecklist('### Owner action items\n- [x] AC-1: done thing\n* US-2.1: story check\n');
  assert.deepEqual(list.map(i => i.ac), ['AC-1', 'US-2.1']);
});

test('no section → empty checklist (step auto-skips)', () => {
  assert.deepEqual(extractOwnerChecklist('**Approved:** yes\nno owner items here'), []);
  assert.deepEqual(extractOwnerChecklist(''), []);
  assert.deepEqual(extractOwnerChecklist(null), []);
});

test('section at end of feedback (no following heading) still parses', () => {
  const list = extractOwnerChecklist('stuff\n\n### Owner action items\n- AC-3: quit/relaunch persistence');
  assert.deepEqual(list.map(i => i.ac), ['AC-3']);
});

const CHECKLIST = [
  { ac: 'AC-2', text: 'Dock launch' },
  { ac: 'AC-4', text: 'secret persists' },
  { ac: 'AC-7', text: 'home relocation' },
];

test('all ACs mentioned in evidence → nothing missing', () => {
  const evidence = '| AC-2 | PASS | ... |\nAC-4 verified after relaunch.\n## AC-7\nfresh home created.';
  assert.deepEqual(ownerVerificationMissing(CHECKLIST, evidence), []);
});

test('unmentioned ACs are reported missing', () => {
  const missing = ownerVerificationMissing(CHECKLIST, 'AC-2 PASS, and that is all.');
  assert.deepEqual(missing.map(m => m.ac), ['AC-4', 'AC-7']);
});

test('id matching is word-bounded — AC-2 does not satisfy AC-21', () => {
  const missing = ownerVerificationMissing([{ ac: 'AC-2', text: 'x' }], 'only AC-21 appears here');
  assert.deepEqual(missing.map(m => m.ac), ['AC-2']);
});

test('empty evidence → everything missing; empty checklist → nothing missing', () => {
  assert.equal(ownerVerificationMissing(CHECKLIST, '').length, 3);
  assert.deepEqual(ownerVerificationMissing([], 'anything'), []);
});
