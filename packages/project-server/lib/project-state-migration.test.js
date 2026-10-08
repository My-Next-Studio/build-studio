'use strict';

// Moving the Key Decisions Log and the backlog index out of project-state.md,
// which every agent reads first, into files that only their readers open.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { planProjectStateMigration, applyProjectStateMigration } = require('./project-state-migration');
const { decisionsSince } = require('./draft-delta');
const bl = require('./backlog');

const STATE = [
  '# State', '', '## Learnings', '', 'See docs/learnings/.', '',
  '## Key Decisions Log', '',
  '| Date | Decision | Role | Reference |', '|------|----------|------|-----------|',
  '| 2026-09-12 | **Offline first.** long detail | CEO | ADR-003 |',
  '| 2026-09-01 | **Old decision.** detail | PM | x |', '',
  '## Active PRD', '', 'None.', '',
  '## Backlog (PRD-004 — new format)', '',
  'Auto-managed region.', '',
  '<!-- BACKLOG-START -->', '', '### Release 1', '',
  '- EX-001 — First  [Feature · Backlog]', '', '<!-- BACKLOG-END -->', '',
  '## Open Questions', '', '- none', '',
].join('\n');

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-ps-migrate-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return root;
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const ITEM = '---\nid: EX-001\ntitle: First\ntype: Feature\nstatus: Backlog\n---\n';

test('both sections move out, and project-state.md keeps a pointer under each heading', () => {
  const root = project({ 'docs/project-state.md': STATE, 'docs/backlog/EX-001.md': ITEM });
  try {
    assert.deepEqual(planProjectStateMigration(root).map((p) => p.action), ['move', 'move']);
    assert.deepEqual(applyProjectStateMigration(root), ['docs/decisions.md', 'docs/backlog-index.md', 'docs/project-state.md']);

    const log = read(root, 'docs/decisions.md');
    assert.match(log, /^# Key Decisions Log/);
    assert.match(log, /\| 2026-09-12 \| \*\*Offline first\.\*\*/);

    const index = read(root, 'docs/backlog-index.md');
    assert.match(index, /^# Backlog index/);
    assert.match(index, /## Backlog\n\nAuto-managed region\.\n\n<!-- BACKLOG-START -->/);

    const state = read(root, 'docs/project-state.md');
    assert.doesNotMatch(state, /Offline first|BACKLOG-START|EX-001/);
    assert.match(state, /## Key Decisions Log\n\nMoved to \[`docs\/decisions\.md`\]/);
    assert.match(state, /## Backlog \(PRD-004 — new format\)\n\nMoved to \[`docs\/backlog-index\.md`\]/);
    // The sections around them survive, in order.
    assert.match(state, /## Learnings\n\nSee docs\/learnings\/\.\n\n## Key Decisions Log/);
    assert.match(state, /\n## Active PRD\n\nNone\.\n\n## Backlog/);
    assert.match(state, /\n## Open Questions\n\n- none\n$/);

    // Running it again is a no-op.
    assert.deepEqual(planProjectStateMigration(root).map((p) => p.action), ['none', 'none']);
    assert.deepEqual(applyProjectStateMigration(root), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('after the move the backlog reads and writes the index file, with the same order', () => {
  const root = project({ 'docs/project-state.md': STATE, 'docs/backlog/EX-001.md': ITEM });
  try {
    const before = bl.readBacklog(root, 'docs').groups;
    applyProjectStateMigration(root);
    assert.equal(path.basename(bl.backlogIndexPath(root, 'docs')), 'backlog-index.md');
    assert.deepEqual(bl.readBacklog(root, 'docs').groups, before);

    const stateBefore = read(root, 'docs/project-state.md');
    bl.writeItem(root, 'docs', { id: 'EX-001', title: 'First', type: 'Feature', status: 'Drafted', body: '' });
    assert.equal(bl.refreshBacklogIndex(root, 'docs'), true);
    assert.match(read(root, 'docs/backlog-index.md'), /EX-001 — First\s+\[Feature · Drafted\]/);
    assert.equal(read(root, 'docs/project-state.md'), stateBefore, 'project-state.md is no longer written');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an existing target file is never overwritten while the section still has content', () => {
  const root = project({ 'docs/project-state.md': STATE, 'docs/decisions.md': '# Mine\n' });
  try {
    const plan = planProjectStateMigration(root);
    assert.equal(plan.find((p) => p.key === 'decisions').action, 'conflict');
    assert.equal(plan.find((p) => p.key === 'backlog').action, 'move');
    applyProjectStateMigration(root);
    assert.equal(read(root, 'docs/decisions.md'), '# Mine\n');
    assert.match(read(root, 'docs/project-state.md'), /Offline first/, 'the conflicting section stays put');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('nothing to move: no sections, an empty template table, or no project-state.md', () => {
  const a = project({ 'docs/project-state.md': '# S\n\n## Roles\n' });
  const b = project({ 'docs/project-state.md': '# S\n\n## Key Decisions Log\n\n| Date | Decision |\n|--|--|\n' });
  const c = project({ 'README.md': 'x' });
  try {
    for (const root of [a, b, c]) {
      assert.deepEqual(planProjectStateMigration(root).map((p) => p.action), ['none', 'none']);
    }
  } finally {
    for (const root of [a, b, c]) fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the draft delta reads decisions from the moved file', () => {
  const root = project({ 'docs/project-state.md': STATE });
  try {
    applyProjectStateMigration(root);
    const rows = decisionsSince(read(root, 'docs/decisions.md'), '2026-09-10');
    assert.deepEqual(rows.map((d) => d.text), ['Offline first.']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a stray backlog-index.md without markers does not take over from project-state.md', () => {
  const root = project({ 'docs/project-state.md': STATE, 'docs/backlog/EX-001.md': ITEM, 'docs/backlog-index.md': '# notes\n' });
  try {
    assert.equal(path.basename(bl.backlogIndexPath(root, 'docs')), 'project-state.md');
    assert.deepEqual(bl.readBacklog(root, 'docs').groups, [{ release: 'Release 1', items: ['EX-001'] }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('with two Backlog sections, the one holding the markers moves and the old table stays', () => {
  const state = [
    '# S', '', '## Backlog', '', '| PRD | Status |', '|--|--|', '| PRD-1 | Done |', '',
    '## Notes', '', 'x', '',
    '## Backlog (PRD-004 — new format)', '', '<!-- BACKLOG-START -->', '', '### R', '',
    '- EX-001 — First  [Feature · Backlog]', '', '<!-- BACKLOG-END -->', '',
  ].join('\n');
  const root = project({ 'docs/project-state.md': state, 'docs/backlog/EX-001.md': ITEM });
  try {
    assert.equal(planProjectStateMigration(root).find((p) => p.key === 'backlog').action, 'move');
    applyProjectStateMigration(root);
    const after = read(root, 'docs/project-state.md');
    assert.match(after, /\| PRD-1 \| Done \|/, 'the old table is left alone');
    assert.match(after, /## Backlog \(PRD-004 — new format\)\n\nMoved to/);
    assert.deepEqual(bl.readBacklog(root, 'docs').groups, [{ release: 'R', items: ['EX-001'] }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a section at the end of the file leaves no trailing blank line (docs lint MD012)', () => {
  const root = project({ 'docs/project-state.md': '# S\n\n## Backlog\n\n<!-- BACKLOG-START -->\n<!-- BACKLOG-END -->\n' });
  try {
    applyProjectStateMigration(root);
    assert.match(read(root, 'docs/project-state.md'), /item files\.\n$/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
