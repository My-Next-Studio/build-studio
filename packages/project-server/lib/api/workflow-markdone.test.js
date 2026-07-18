'use strict';

// Tests for markPrdDoneContent — the pure project-state.md rewrite applied
// when a PRD's workflow merges. Regression focus: the Active PRD entry is a
// multi-line paragraph in most projects; replacing only its first line strips
// the title link and orphans the description under "None — … complete"
// (observed twice in launch-studio, PRD-014 and PRD-015).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { markPrdDoneContent } = require('./workflow');

const TODAY = '2026-07-19';

test('Active PRD: multi-line paragraph entry is replaced whole (no orphaned lines)', () => {
  const md = [
    '## Active PRD',
    '',
    '**[PRD-015 — Draft pipeline](prds/PRD-015-draft-pipeline.md)**',
    '(LS-044) — In Execution. ~2 days. Fixes the regenerate path and',
    'adds the empty-completion guard.',
    '',
    '## Backlog',
    '',
  ].join('\n');
  const { content } = markPrdDoneContent(md, 'PRD-015', TODAY);
  assert.match(content, /## Active PRD\n\nNone — PRD-015 complete\. Next: scope next PRD\.\n\n## Backlog/);
  assert.doesNotMatch(content, /LS-044/);
  assert.doesNotMatch(content, /empty-completion guard/);
});

test('Active PRD: subsections after the entry paragraph survive', () => {
  const md = [
    '## Active PRD',
    '',
    '- **PRD-002 — Foo.** Active, in Preparation.',
    '',
    '### Completed prep work',
    '',
    '- did a thing',
    '',
    '## Backlog',
  ].join('\n');
  const { content } = markPrdDoneContent(md, 'PRD-002', TODAY);
  assert.match(content, /None — PRD-002 complete/);
  assert.match(content, /### Completed prep work\n\n- did a thing/);
});

test('Active PRD: entry directly followed by a heading (no blank line) never consumes the heading', () => {
  const md = '## Active PRD\n- **PRD-9 — Bar.** Active.\n## Backlog\n';
  const { content } = markPrdDoneContent(md, 'PRD-9', TODAY);
  assert.match(content, /## Active PRD\nNone — PRD-9 complete\. Next: scope next PRD\.\n## Backlog/);
});

test('Backlog row: status cell flips to Done regardless of column order', () => {
  const md = [
    '## Backlog',
    '',
    '| Status | PRD | Notes |',
    '|---|---|---|',
    '| **Active — Preparation** | PRD-007 | stuff |',
    '',
    '## Active PRD',
    '',
    'None — nothing running.',
  ].join('\n');
  const { content, backlogRowChanged } = markPrdDoneContent(md, 'PRD-007', TODAY);
  assert.equal(backlogRowChanged, true);
  assert.match(content, /\| \*\*Done\.\*\* PRD-007 shipped 2026-07-19\. \| PRD-007 \| stuff \|/);
});

test('no Active PRD section and no matching row → content unchanged', () => {
  const md = '# Project\n\nJust prose.\n';
  const { content, backlogRowChanged } = markPrdDoneContent(md, 'PRD-001', TODAY);
  assert.equal(content, md);
  assert.equal(backlogRowChanged, false);
});
