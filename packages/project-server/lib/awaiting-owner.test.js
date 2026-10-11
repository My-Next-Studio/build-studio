'use strict';

// Findings only the owner can close are reported on their own marker line and
// held for the owner, instead of looping fix rounds that change nothing.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseAwaitingOwner, holdsForOwner, fixNoteForOwnerItems, AWAITING_OWNER_INSTRUCTIONS } = require('./awaiting-owner');
const { blockingCount } = require('./gate-blocked');

const OWNER_ONLY = [
  '**Approved:** no',
  '**Blocking:** 0  |  **Medium:** 0  |  **Low:** 0',
  '**Tests passed:** 15964/15966',
  '**Awaiting owner:** approve the 20 study queries and acknowledge the labelling guide (AC-1–AC-4)',
  '**Awaiting owner:** No Study result in LS-019 until the measured study has run (AC-5)',
].join('\n');

test('every marker line is an item, including one that starts with "No"', () => {
  assert.deepEqual(parseAwaitingOwner(OWNER_ONLY), [
    'approve the 20 study queries and acknowledge the labelling guide (AC-1–AC-4)',
    'No Study result in LS-019 until the measured study has run (AC-5)',
  ]);
});

test('a line filled with a negative is the absent line it was meant to be', () => {
  for (const negative of ['N/A', 'none', 'None — nothing waits on the owner', 'no', '—']) {
    assert.deepEqual(parseAwaitingOwner(`**Approved:** no\n**Awaiting owner:** ${negative}`), [], negative);
  }
});

test('owner items with no code defect and no approval hold the run', () => {
  assert.equal(holdsForOwner(OWNER_ONLY, blockingCount).length, 2);
});

test('a code defect beside them goes to the fix loop, not a hold', () => {
  const withDefect = OWNER_ONLY.replace('**Blocking:** 0', '**Blocking:** 1');
  assert.equal(holdsForOwner(withDefect, blockingCount), null);
});

test('a certified approval does not hold: the owner items stay informational', () => {
  const approved = OWNER_ONLY.replace('**Approved:** no', '**Approved:** yes');
  assert.equal(holdsForOwner(approved, blockingCount), null);
});

test('no marker, no hold', () => {
  assert.equal(holdsForOwner('**Approved:** no\n**Blocking:** 0', blockingCount), null);
});

test('the fix note lists the items and says they are not tasks', () => {
  const note = fixNoteForOwnerItems(['approve the queries']);
  assert.match(note, /these are not tasks/);
  assert.match(note, /- approve the queries/);
});

test('the instructions name the exact marker and keep it out of the blocking count', () => {
  assert.match(AWAITING_OWNER_INSTRUCTIONS, /\*\*Awaiting owner:\*\* </);
  assert.match(AWAITING_OWNER_INSTRUCTIONS, /Do NOT count it in `\*\*Blocking:\*\*`/);
});
