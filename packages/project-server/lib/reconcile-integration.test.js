'use strict';

// The integration step: renumber collisions on a branch cut from the pin, then
// one import commit (no source history), keep-out applied, conflicts stopped
// for the owner and continued.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const backlog = require('./backlog');
const tracks = require('./reconcile-track');
const integration = require('./reconcile-integration');

function write(root, rel, body) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}
const item = (id, extra = '') => `---\nid: ${id}\ntitle: ${id}\ntype: Task\nstatus: Backlog\nrelease: Now\ncreated: '2026-11-01'\nprd: null\ndepends_on: []\n---\n\nBody.${extra}\n`;
const index = (ids) => `# Backlog\n\n${backlog.BACKLOG_START}\n\n### Now\n${ids.map((i) => `- ${i} — ${i}  [Task · Backlog]`).join('\n')}\n\n${backlog.BACKLOG_END}\n`;

/**
 * main: EX-001, app/a.txt, app/shared.txt. The clone's branch (2 commits) changes
 * app/a.txt, adds app/b.txt, a handover file and its own EX-002 plus a PRD that
 * links it.
 */
async function setup({ mainAlsoFilesEx002 = false, conflict = false, keepOut = ['HANDOVER.md'] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-integration-'));
  const project = path.join(dir, 'project');
  const clone = path.join(dir, 'clone');
  fs.mkdirSync(project);
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' });
  g(project, 'init', '-q', '-b', 'main');
  g(project, 'config', 'user.email', 't@example.com');
  g(project, 'config', 'user.name', 't');
  write(project, '.gitignore', 'tmp/\n');
  write(project, 'docs/backlog/EX-001.md', item('EX-001'));
  write(project, 'docs/backlog-index.md', index(['EX-001']));
  write(project, 'app/a.txt', 'a\n');
  write(project, 'app/shared.txt', 'line 1\nline 2\n');
  g(project, 'add', '-A');
  g(project, 'commit', '-q', '-m', 'init');
  g(dir, 'clone', '-q', project, clone);
  g(clone, 'config', 'user.email', 't@example.com');
  g(clone, 'config', 'user.name', 't');
  g(clone, 'checkout', '-q', '-b', 'design/x');
  write(clone, 'app/a.txt', 'a, redesigned\n');
  g(clone, 'commit', '-q', '-am', 'first');
  write(clone, 'app/b.txt', 'b\n');
  write(clone, 'HANDOVER.md', 'chronological log\n');
  write(clone, 'docs/backlog/EX-002.md', item('EX-002'));
  write(clone, 'docs/prds/PRD-002-x.md', '# PRD-002\n\n**Backlog item:** EX-002\n');
  if (conflict) write(clone, 'app/shared.txt', 'line 1, from the branch\nline 2\n');
  g(clone, 'add', '-A');
  g(clone, 'commit', '-q', '-m', 'second');

  // Main moves on after the branch was cut.
  if (mainAlsoFilesEx002) {
    write(project, 'docs/backlog/EX-002.md', item('EX-002', ' Filed on main.'));
    write(project, 'docs/backlog-index.md', index(['EX-001', 'EX-002']));
  }
  if (conflict) write(project, 'app/shared.txt', 'line 1, from main\nline 2\n');
  if (mainAlsoFilesEx002 || conflict) { g(project, 'add', '-A'); g(project, 'commit', '-q', '-m', 'main moves on'); }

  const started = await tracks.startTrack({ projectRoot: project, sourcePath: clone });
  // The interview wrote what stays out, and was committed.
  const recPath = path.join(project, started.track.record);
  const rec = fs.readFileSync(recPath, 'utf8').replace('```reconcile-keep-out\n```', `\`\`\`reconcile-keep-out\n${keepOut.join('\n')}\n\`\`\``);
  fs.writeFileSync(recPath, rec);
  g(project, 'add', '-A');
  g(project, 'commit', '-q', '-m', 'interview');
  const t = tracks.loadTrack(project, started.recordId);
  tracks.saveTrack(project, { ...t, currentStep: 'integration', steps: { ...t.steps, intent_interview: { status: 'done' } } });
  return { dir, project, clone, g, id: started.recordId };
}

test('one import commit: the source\'s changes without its history, keep-out restored', async () => {
  const { dir, project, g, id } = await setup();
  try {
    const t = integration.integrate({ projectRoot: project, id });
    assert.equal(t.steps.integration.status, 'done');
    assert.equal(t.currentStep, 'align');
    assert.equal(t.branch, `reconcile/${id}`);
    const wt = t.worktree;
    assert.equal(g(project, 'rev-list', '--count', `main..reconcile/${id}`).trim(), '1');
    assert.equal(fs.readFileSync(path.join(wt, 'app/a.txt'), 'utf8'), 'a, redesigned\n');
    assert.ok(fs.existsSync(path.join(wt, 'app/b.txt')));
    assert.equal(fs.existsSync(path.join(wt, 'HANDOVER.md')), false, 'kept out');
    assert.equal(g(wt, 'status', '--porcelain'), '');
    assert.match(g(wt, 'log', '-1', '--format=%s'), new RegExp(`feat\\(${id}\\): import design/x`));
    // The source's own commits are not in the branch's history.
    const sourceMsgs = g(project, 'log', '--format=%s', `reconcile/${id}`);
    assert.doesNotMatch(sourceMsgs, /^first$|^second$/m);
    // The project checkout stayed on main.
    assert.equal(g(project, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an id both sides allocated is renumbered on the incoming side, references with it', async () => {
  const { dir, project, g, id } = await setup({ mainAlsoFilesEx002: true });
  try {
    // main has EX-001, EX-002 (its own) and the record; the source's EX-002 collides.
    const t = integration.integrate({ projectRoot: project, id });
    assert.equal(t.steps.integration.status, 'done');
    const to = t.integration.renumbered['EX-002'];
    assert.ok(to && to !== 'EX-002');
    assert.ok(Number(to.split('-')[1]) > Number(id.split('-')[1]), 'above the record too');
    const wt = t.worktree;
    assert.match(fs.readFileSync(path.join(wt, 'docs/backlog/EX-002.md'), 'utf8'), /Filed on main/, 'the target keeps its EX-002');
    assert.match(fs.readFileSync(path.join(wt, `docs/backlog/${to}.md`), 'utf8'), new RegExp(`id: ${to}`));
    assert.match(fs.readFileSync(path.join(wt, 'docs/prds/PRD-002-x.md'), 'utf8'), new RegExp(`Backlog item:\\*\\* ${to}`));
    assert.equal(tracks.loadTrack(project, id).floor.EX, Number(to.split('-')[1]));
    // The renumbering is its own reviewable commit on the incoming branch.
    assert.match(g(project, 'log', '-1', '--format=%s', `reconcile/${id}-incoming`), /renumber/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a conflict stops for the owner; once resolved, continue finishes the import', async () => {
  const { dir, project, g, id } = await setup({ conflict: true });
  try {
    let t = integration.integrate({ projectRoot: project, id });
    assert.equal(t.steps.integration.status, 'conflict');
    assert.deepEqual(t.steps.integration.conflicts, ['app/shared.txt']);
    assert.throws(() => integration.continueIntegration({ projectRoot: project, id }), /still unmerged/);
    fs.writeFileSync(path.join(t.worktree, 'app/shared.txt'), 'line 1, both\nline 2\n');
    g(t.worktree, 'add', 'app/shared.txt');
    t = integration.continueIntegration({ projectRoot: project, id });
    assert.equal(t.steps.integration.status, 'done');
    assert.equal(fs.readFileSync(path.join(t.worktree, 'app/shared.txt'), 'utf8'), 'line 1, both\nline 2\n');
    assert.equal(g(project, 'rev-list', '--count', `main..reconcile/${id}`).trim(), '1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('integration waits for the interview, and abort throws the branch away', async () => {
  const { dir, project, g, id } = await setup();
  try {
    const t0 = tracks.loadTrack(project, id);
    tracks.saveTrack(project, { ...t0, steps: { ...t0.steps, intent_interview: { status: 'running' } } });
    assert.throws(() => integration.integrate({ projectRoot: project, id }), /finish the intent interview first/);
    tracks.saveTrack(project, { ...t0, steps: { ...t0.steps, intent_interview: { status: 'done' } } });
    const t = integration.integrate({ projectRoot: project, id });
    assert.throws(() => integration.integrate({ projectRoot: project, id }), /already exists/);
    const a = integration.abortIntegration({ projectRoot: project, id });
    assert.equal(a.steps.integration.status, 'pending');
    assert.equal(fs.existsSync(t.worktree), false);
    assert.equal(g(project, 'branch', '--list', `reconcile/${id}`).trim(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('renumberMap and rewriteIds', () => {
  const map = integration.renumberMap(['EX-002', 'EX-003', 'PRD-002'], { targetMax: { EX: 5, PRD: 2 }, sourceMax: { EX: 3, PRD: 2 }, floor: { EX: 7 } });
  assert.deepEqual(map, { 'EX-002': 'EX-008', 'EX-003': 'EX-009', 'PRD-002': 'PRD-003' });
  assert.equal(integration.rewriteIds('EX-002 then EX-003, not EX-0021', { 'EX-002': 'EX-003', 'EX-003': 'EX-004' }), 'EX-003 then EX-004, not EX-0021');
});
