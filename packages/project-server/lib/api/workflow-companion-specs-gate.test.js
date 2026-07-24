'use strict';

// Tests for findIncompleteRequiredSpecs — the Preparation → Execution gate's
// pure predicate. Regression focus: launch-studio LS-094/PRD-039 (2026-07-24)
// started an execution workflow while its own §10 table still showed
// ADR-013's amendment Required/Pending — nothing at the actual start gate
// checked this, only QA's own defense-in-depth self-check at qa_tests caught
// it, a full round late. This function is what /api/workflow/start now
// checks before allowing an execution workflow to begin.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { findIncompleteRequiredSpecs } = require('./workflow');

function prdWithTable(rows) {
  return [
    '# PRD-999 — Test PRD',
    '',
    '## 10. Companion Specs',
    '',
    '| Spec | Owner | Path | Required | Status |',
    '|------|-------|------|----------|--------|',
    ...rows,
    '',
    '## 11. Something after',
  ].join('\n');
}

test('a Required row still Pending is reported incomplete', () => {
  const prd = prdWithTable([
    '| ADR-013 amendment | /architect | docs/adrs/ADR-013.md | Yes | Pending |',
  ]);
  const incomplete = findIncompleteRequiredSpecs(prd);
  assert.equal(incomplete.length, 1);
  assert.match(incomplete[0].spec, /ADR-013/);
  assert.equal(incomplete[0].status, 'Pending');
});

test('a Required row marked Done is not reported', () => {
  const prd = prdWithTable([
    '| ADR-013 amendment | /architect | docs/adrs/ADR-013.md | Yes | Done |',
  ]);
  assert.deepEqual(findIncompleteRequiredSpecs(prd), []);
});

test('a non-Required row is never reported, even when Pending', () => {
  const prd = prdWithTable([
    '| Optional perf note | /architect | docs/adrs/ADR-020.md | No | Pending |',
  ]);
  assert.deepEqual(findIncompleteRequiredSpecs(prd), []);
});

test('column order varies per project — resolved from the header row, not assumed', () => {
  // launch-studio's own order: Spec | Owner | Path | Required | Status
  // (matches updateCompanionSpecsInPrd's own column-order regression note)
  const prd = [
    '# PRD',
    '## Companion Specs',
    '| Spec | Owner | Path | Required | Status |',
    '|---|---|---|---|---|',
    '| UX-014 amendment | /ux | docs/ux/UX-014.md | Yes | Pending |',
  ].join('\n');
  const incomplete = findIncompleteRequiredSpecs(prd);
  assert.equal(incomplete.length, 1);
  assert.match(incomplete[0].spec, /UX-014/);
});

test('multiple incomplete rows are all reported', () => {
  const prd = prdWithTable([
    '| ADR-013 amendment | /architect | docs/adrs/ADR-013.md | Yes | Pending |',
    '| UX-014 amendment | /ux | docs/ux/UX-014.md | Yes | Pending |',
    '| PRD-039-copy | /brand | docs/brand/PRD-039-copy.md | Yes | Done |',
  ]);
  const incomplete = findIncompleteRequiredSpecs(prd);
  assert.deepEqual(incomplete.map(s => s.status), ['Pending', 'Pending']);
});

test('no Companion Specs section at all → nothing to gate on', () => {
  assert.deepEqual(findIncompleteRequiredSpecs('# PRD\n\nJust prose, no table.'), []);
  assert.deepEqual(findIncompleteRequiredSpecs(''), []);
});

test('table with no Required/Status columns resolvable → degrades to empty, never throws', () => {
  const prd = [
    '# PRD',
    '## Companion Specs',
    '| Spec | Notes |',
    '|---|---|',
    '| ADR-013 | something |',
  ].join('\n');
  assert.deepEqual(findIncompleteRequiredSpecs(prd), []);
});

test('real PRD-039 table reproduces the LS-094 incident exactly', () => {
  // The actual launch-studio PRD-039 §10 table at the time execution started:
  // ADR-013 + UX-014 both Required:Yes/Status:Pending, PRD-039-copy Done.
  const prd = prdWithTable([
    '| ADR-013 amendment: field split, staged schema | /architect | docs/adrs/ADR-013-content-pipeline.md | Yes | Pending |',
    '| UX-014 amendment: sync-state presentation | /ux | docs/ux/UX-014-content-studio.md | Yes | Pending |',
    '| PRD-039-copy: state vocabulary | /brand | docs/brand/PRD-039-copy.md | Yes | Done |',
  ]);
  const incomplete = findIncompleteRequiredSpecs(prd);
  assert.equal(incomplete.length, 2);
});
