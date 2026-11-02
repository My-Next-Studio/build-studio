'use strict';

// Reconcile tracks: the preparation half of a reconcile, kept outside the
// workflow slot (docs/plans/reconciliation-workflow.md). Starting one runs
// intake and files the record above the id floor; the floor holds for every
// item filed while the track is open.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const backlog = require('./backlog');
const track = require('./reconcile-track');

function write(root, rel, body) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

const item = (id, title) => `---\nid: ${id}\ntitle: ${title}\ntype: Task\nstatus: Backlog\nrelease: Now\ncreated: '2026-11-01'\nprd: null\ndepends_on: []\n---\n\nBody.\n`;

/** A project with EX-001 on main, and a clone on a branch that filed EX-002 and EX-003. */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-track-'));
  const project = path.join(dir, 'project');
  const clone = path.join(dir, 'clone');
  fs.mkdirSync(project);
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' });
  g(project, 'init', '-q', '-b', 'main');
  g(project, 'config', 'user.email', 't@example.com');
  g(project, 'config', 'user.name', 't');
  write(project, '.gitignore', 'tmp/\n');
  write(project, 'docs/backlog/EX-001.md', item('EX-001', 'Already here'));
  write(project, 'docs/backlog-index.md', `# Backlog\n\n${backlog.BACKLOG_START}\n\n### Now\n- EX-001 — Already here  [Task · Backlog]\n\n${backlog.BACKLOG_END}\n`);
  write(project, 'app/Home.swift', 'struct Home {}\n');
  g(project, 'add', '-A');
  g(project, 'commit', '-q', '-m', 'init');
  g(dir, 'clone', '-q', project, clone);
  g(clone, 'config', 'user.email', 't@example.com');
  g(clone, 'config', 'user.name', 't');
  g(clone, 'checkout', '-q', '-b', 'design/new-home');
  write(clone, 'docs/backlog/EX-002.md', item('EX-002', 'New home'));
  write(clone, 'docs/backlog/EX-003.md', item('EX-003', 'New home, part two'));
  write(clone, 'app/Home.swift', 'struct Home { let mascot = true }\n');
  return { dir, project, clone, g };
}

const commitAll = (g, cwd, msg) => { g(cwd, 'add', '-A'); g(cwd, 'commit', '-q', '-m', msg); };

test('a dirty source is refused: no track, no record, nothing pinned', async () => {
  const { dir, project, clone, g } = setup();
  try {
    const r = await track.startTrack({ projectRoot: project, sourcePath: clone });
    assert.equal(r.refused, true);
    assert.match(r.markdown, /Intake refused/);
    assert.deepEqual(track.listTracks(project), []);
    assert.equal(fs.existsSync(path.join(project, 'docs/backlog/EX-002.md')), false);
    assert.equal(g(project, 'for-each-ref', 'refs/build-studio'), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('starting a track files the record above the ids the source allocated', async () => {
  const { dir, project, clone, g } = setup();
  try {
    commitAll(g, clone, 'new home');
    const r = await track.startTrack({ projectRoot: project, sourcePath: clone, brief: 'docs/inputs/handover.md' });
    assert.equal(r.refused, false);
    // EX-002 and EX-003 belong to the source; the record takes EX-004, not EX-002.
    assert.equal(r.recordId, 'EX-004');
    assert.equal(r.commit.committed, true);
    const rec = backlog.readItem(project, 'docs', 'EX-004');
    assert.equal(rec.title, 'Reconcile design/new-home');
    assert.match(rec.body, /## Approved behaviour/);
    assert.match(rec.body, /```reconcile-keep-out\n```/);
    assert.match(rec.body, /Ids allocated by the source: EX-002, EX-003/);
    const t = track.loadTrack(project, 'EX-004');
    assert.equal(t.status, 'open');
    assert.deepEqual(t.floor, { EX: 3 });
    assert.equal(t.currentStep, 'intent_interview');
    assert.equal(t.steps.intake.status, 'done');
    assert.equal(t.record, 'docs/backlog/EX-004.md');
    assert.ok(fs.existsSync(path.join(track.trackDir(project, 'EX-004'), 'intake.md')));
    // Nothing of the track is tracked by git.
    assert.equal(g(project, 'status', '--porcelain'), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('while a track is open every new item skips the source\'s ids; cancelling lifts the floor', async () => {
  const { dir, project, clone, g } = setup();
  try {
    commitAll(g, clone, 'new home');
    // The source's ids go up to EX-003, but only EX-001 exists on main.
    const { recordId } = await track.startTrack({ projectRoot: project, sourcePath: clone });
    fs.rmSync(path.join(project, 'docs/backlog', `${recordId}.md`)); // as if the record were elsewhere
    assert.equal(backlog.nextItemId(project, 'docs', 'EX'), 'EX-004');
    track.cancelTrack(project, recordId, 'test');
    assert.equal(track.idFloor(project, 'EX'), 0);
    assert.equal(backlog.nextItemId(project, 'docs', 'EX'), 'EX-002');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the reconcile skills are copied in when missing, and committed with the record', async () => {
  const { dir, project, clone, g } = setup();
  try {
    commitAll(g, clone, 'new home');
    const r = await track.startTrack({ projectRoot: project, sourcePath: clone });
    assert.deepEqual(r.skillsAdded.sort(), ['.claude/skills/reconcile_decisions/SKILL.md', '.claude/skills/reconcile_interview/SKILL.md']);
    assert.equal(g(project, 'status', '--porcelain'), '', 'committed, nothing left untracked');
    // A project's own copy is never overwritten.
    fs.writeFileSync(path.join(project, '.claude/skills/reconcile_interview/SKILL.md'), 'edited\n');
    assert.deepEqual(track.ensureSkills(project), []);
    assert.equal(fs.readFileSync(path.join(project, '.claude/skills/reconcile_interview/SKILL.md'), 'utf8'), 'edited\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('floorFromIds keeps the highest number per prefix', () => {
  assert.deepEqual(track.floorFromIds(['DR-148', 'DR-154', 'PRD-068', 'PRD-074', 'UX-070', 'junk']), { DR: 154, PRD: 74, UX: 70 });
  assert.deepEqual(track.floorFromIds([]), {});
});

test('an unreadable track never stops an item being filed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-track-bad-'));
  try {
    write(root, 'tmp/reconcile/EX-009/track.json', '{ not json');
    assert.equal(track.idFloor(root, 'EX'), 0);
    assert.deepEqual(track.listTracks(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('track ids cannot escape tmp/reconcile', () => {
  assert.throws(() => track.trackDir('/p', '../etc'), /invalid track id/);
  assert.throws(() => track.trackDir('/p', ''), /invalid track id/);
});
