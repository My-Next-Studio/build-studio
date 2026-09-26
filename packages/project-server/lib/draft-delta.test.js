'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { computeDraftDelta, formatDraftDelta, decisionsSince } = require('./draft-delta');

// A real repo with dated commits: "since the last draft" is a question about
// commit history, and a mocked git would only restate the assumption.

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-delta-'));
  const run = (args, date) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) },
  });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.email', 't@example.com']);
  run(['config', 'user.name', 'T']);
  const write = (f, body) => {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), body);
  };
  const commit = (date, msg) => { run(['add', '-A']); run(['commit', '-q', '-m', msg], date); };
  return { root, write, commit, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const item = (id, status, prd = 'null', title = `Item ${id}`) =>
  `---\nid: ${id}\ntitle: ${title}\ntype: Feature\nstatus: ${status}\nprd: ${prd}\n---\n\nbody\n`;
const doc = (title, status, body = 'body') => `# ${title}\n\n**Status:** ${status}\n\n${body}\n`;

const SINCE = '2026-09-10T12:00:00Z';

function fixture() {
  const r = repo();
  r.write('docs/adrs/ADR-001-store.md', doc('ADR-001 — Store', 'Accepted'));
  r.write('docs/adrs/ADR-002-sync.md', doc('ADR-002 — Sync', 'Accepted'));
  r.write('docs/prds/PRD-001-a.md', doc('PRD-001 — A', 'Draft'));
  r.write('docs/backlog/X-1.md', item('X-1', 'Backlog'));
  r.write('docs/backlog/X-2.md', item('X-2', 'Backlog'));
  r.write('docs/project-state.md', [
    '# State', '', '## Key Decisions Log', '',
    '| Date | Decision | Role | Reference |', '|------|----------|------|-----------|',
    '| 2026-09-01 | **Old decision.** detail | CEO | x |', '', '## Next', '',
  ].join('\n'));
  r.commit('2026-09-05T10:00:00Z', 'before the last draft');

  // After the last draft:
  r.write('docs/adrs/ADR-001-store.md', doc('ADR-001 — Store', 'Superseded by ADR-003'));
  r.write('docs/adrs/ADR-002-sync.md', doc('ADR-002 — Sync', 'Accepted', 'a reworded paragraph'));
  r.write('docs/adrs/ADR-003-store-v2.md', doc('ADR-003 — Store v2', 'Accepted'));
  r.write('docs/prds/PRD-002-b.md', doc('PRD-002 — B', 'Draft'));
  r.write('docs/backlog/X-1.md', item('X-1', 'Reviewed', 'PRD-002-b.md'));
  r.write('docs/backlog/X-2.md', item('X-2', 'Backlog', 'null', 'Item X-2 retitled'));
  const ps = fs.readFileSync(path.join(r.root, 'docs/project-state.md'), 'utf8')
    .replace('| 2026-09-01 |', '| 2026-09-12 | **Offline first.** long detail | CEO | ADR-003 |\n| 2026-09-01 |');
  r.write('docs/project-state.md', ps);
  r.commit('2026-09-12T09:00:00Z', 'after the last draft');
  return r;
}

test('reports new and status-changed documents, counts body-only edits', () => {
  const r = fixture();
  try {
    const d = computeDraftDelta({ projectRoot: r.root, docsPath: path.join(r.root, 'docs'), since: SINCE });
    assert.deepStrictEqual(d.adrs.map((a) => [a.file, a.status, a.was, a.isNew]).sort(), [
      ['ADR-001-store.md', 'Superseded by ADR-003', 'Accepted', false],
      ['ADR-003-store-v2.md', 'Accepted', null, true],
    ]);
    assert.deepStrictEqual(d.prds.map((p) => p.file), ['PRD-002-b.md']);
    assert.deepStrictEqual(d.items.map((i) => [i.id, i.status, i.was]), [['X-1', 'Reviewed', 'Backlog']]);
    assert.equal(d.otherEdits, 2); // ADR-002 reworded, X-2 retitled
    assert.deepStrictEqual(d.decisions, [{ date: '2026-09-12', text: 'Offline first.' }]);
  } finally { r.cleanup(); }
});

test("the session's own drafts are listed, tagged, not hidden", () => {
  const r = fixture();
  try {
    const d = computeDraftDelta({ projectRoot: r.root, docsPath: path.join(r.root, 'docs'), since: SINCE, own: ['X-1'] });
    assert.equal(d.items.find((i) => i.id === 'X-1').mine, true);
    assert.equal(d.prds.find((p) => p.file === 'PRD-002-b.md').mine, true);
    const text = formatDraftDelta(d, SINCE);
    assert.match(text, /X-1 — Item X-1 \[Reviewed, was Backlog, drafted in this session\]/);
    assert.match(text, /ADR-001 — Store — Status: Superseded by ADR-003 \(was: Accepted; ADR-001-store\.md\)/);
    assert.match(text, /2 other ADR\/PRD\/backlog files were edited without a status change/);
    assert.match(text, /since your last draft \(2026-09-10\)/);
  } finally { r.cleanup(); }
});

test('nothing changed, or no git history → no section at all', () => {
  const r = fixture();
  try {
    const d = computeDraftDelta({ projectRoot: r.root, docsPath: path.join(r.root, 'docs'), since: '2026-09-20T00:00:00Z' });
    assert.equal(formatDraftDelta(d, '2026-09-20T00:00:00Z'), '');
  } finally { r.cleanup(); }
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-delta-nogit-'));
  try {
    const d = computeDraftDelta({ projectRoot: bare, docsPath: path.join(bare, 'docs'), since: SINCE });
    assert.equal(formatDraftDelta(d, SINCE), '');
  } finally { fs.rmSync(bare, { recursive: true, force: true }); }
});

test('decisionsSince stops at the next section and keeps the bold headline', () => {
  const src = '## Key Decisions Log\n\n| Date | Decision | R | Ref |\n|--|--|--|--|\n'
    + '| 2026-09-15 | **Keep it.** because | CEO | x |\n| 2026-09-15 | plain text row | PM | y |\n'
    + '\n## Active PRD\n\n| 2026-09-30 | not a decision | x | y |\n';
  assert.deepStrictEqual(decisionsSince(src, '2026-09-15').map((d) => d.text), ['Keep it.', 'plain text row']);
  assert.deepStrictEqual(decisionsSince(src, '2026-09-16'), []);
});
