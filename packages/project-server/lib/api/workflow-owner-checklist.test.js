'use strict';

// Tests for extractOwnerChecklist — parses the AC verifier's `### Owner
// action items` section into a deduped, section-bounded list. Used to
// surface owner-gated ACs (checks that need a human at the machine — Dock
// launch, native OS dialogs) informationally in demo_review; approving
// demo_review confirms them, logged to wf.ownerConfirmations, no evidence
// file required. (A dedicated owner_verification step used to gate on
// committed evidence for this checklist — removed 2026-07-22 as more
// friction than value in practice, launch-studio LS-074 dogfood.)

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { extractOwnerChecklist } = require('./workflow');

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

test('no section → empty checklist', () => {
  assert.deepEqual(extractOwnerChecklist('**Approved:** yes\nno owner items here'), []);
  assert.deepEqual(extractOwnerChecklist(''), []);
  assert.deepEqual(extractOwnerChecklist(null), []);
});

test('section at end of feedback (no following heading) still parses', () => {
  const list = extractOwnerChecklist('stuff\n\n### Owner action items\n- AC-3: quit/relaunch persistence');
  assert.deepEqual(list.map(i => i.ac), ['AC-3']);
});
