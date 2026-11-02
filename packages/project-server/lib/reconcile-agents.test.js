'use strict';

// The reconcile track's agent steps: who is launched, where, how they report,
// and how the docs branch comes back.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const tracks = require('./reconcile-track');
const agents = require('./reconcile-agents');

function write(root, rel, body) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

/** A project with an integration worktree on reconcile/EX-004, and an open track. */
function setup({ tier = 'sensitive' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-agents-'));
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' });
  g(root, 'init', '-q', '-b', 'main');
  g(root, 'config', 'user.email', 't@example.com');
  g(root, 'config', 'user.name', 't');
  write(root, '.gitignore', 'tmp/\n');
  for (const c of ['architect', 'security', 'ux', 'brand', 'code_reviewer', 'qa', 'pm', 'ios_dev']) write(root, `.claude/commands/${c}.md`, `# ${c}\n`);
  write(root, 'docs/backlog/EX-004.md', 'record\n');
  write(root, 'app/a.txt', 'a\n');
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'init');
  const wt = path.join(root, 'tmp', '.worktrees', 'reconcile-EX-004');
  g(root, 'worktree', 'add', '-q', '-b', 'reconcile/EX-004', wt);
  const config = {
    projectRoot: root, name: 'Example App', port: 3999,
    roles: { review: [{ role: 'Architect', command: 'architect.md' }, { role: 'Security', command: 'security.md' }, { role: 'UX', command: 'ux.md' }, { role: 'Brand', command: 'brand.md' }, { role: 'QA', command: 'qa.md' }], execution: [{ role: 'iOS Dev', command: 'ios_dev.md' }] },
  };
  const track = {
    id: 'EX-004', status: 'open', createdAt: '2026-11-02T00:00:00.000Z', record: 'docs/backlog/EX-004.md', tier,
    source: { path: '/src/clone', branch: 'design/x', pin: 'refs/x', sha: 'abc' },
    target: { ref: 'main', integratedOn: g(root, 'rev-parse', 'main').trim() },
    worktree: wt, branch: 'reconcile/EX-004', floor: {},
    currentStep: 'align',
    steps: Object.fromEntries(tracks.STEPS.map((s) => [s, { status: 'pending' }])),
  };
  tracks.saveTrack(root, track);
  return { root, g, wt, config, track };
}

function fakeLauncher() {
  const calls = [];
  const launchAgents = (wf, list, opts) => {
    calls.push({ wf, list, opts });
    return list.map((a) => ({ ...a, status: 'running' }));
  };
  return { calls, launchAgents };
}

test('align launches the builder in the worktree and the PM in a docs worktree, reporting to the track', () => {
  const { root, config, track, wt } = setup();
  try {
    const { calls, launchAgents } = fakeLauncher();
    const t = agents.launchStep({ config, track, stepKey: 'align', launchAgents });
    assert.equal(t.steps.align.status, 'running');
    assert.deepEqual(calls.map((c) => c.list[0].role), ['iOS Dev', 'PM']);
    assert.equal(calls[0].opts.cwd, wt);
    assert.equal(calls[1].opts.cwd, t.steps.align.docsWorktree);
    assert.ok(fs.existsSync(t.steps.align.docsWorktree));
    for (const c of calls) {
      assert.equal(c.opts.feedbackPath, '/api/reconcile/EX-004/feedback');
      assert.equal(c.opts.stepKey, 'align');
      assert.equal(c.wf.type, 'reconcile');
      assert.match(c.wf.sessionName, /^rc-Example-App-EX-004$/);
    }
    assert.match(calls[0].list[0].instruction, /meet the approved acceptance criteria/);
    assert.match(calls[1].list[0].instruction, /verbatim/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('when both have reported, the docs branch is merged back and the track moves to review', () => {
  const { root, g, config, track, wt } = setup();
  try {
    const { launchAgents } = fakeLauncher();
    let t = agents.launchStep({ config, track, stepKey: 'align', launchAgents });
    // The builder commits code; the PM commits a PRD in the docs worktree.
    write(wt, 'app/a.txt', 'a, aligned\n');
    g(wt, 'commit', '-q', '-am', 'align code');
    write(t.steps.align.docsWorktree, 'docs/prds/PRD-001.md', '# ACs\n');
    g(t.steps.align.docsWorktree, 'add', '-A');
    g(t.steps.align.docsWorktree, 'commit', '-q', '-m', 'acs');
    t = agents.recordFeedback({ config, id: 'EX-004', role: 'iOS Dev', step: 'align', feedback: 'done' });
    assert.equal(t.steps.align.status, 'running', 'waits for the PM');
    t = agents.recordFeedback({ config, id: 'EX-004', role: 'pm', step: 'align', feedback: 'done' });
    assert.equal(t.steps.align.status, 'done');
    assert.equal(t.currentStep, 'team_review');
    assert.ok(fs.existsSync(path.join(wt, 'docs/prds/PRD-001.md')));
    assert.equal(fs.readFileSync(path.join(wt, 'app/a.txt'), 'utf8'), 'a, aligned\n');
    assert.equal(fs.existsSync(path.join(root, 'tmp/.worktrees/reconcile-EX-004-docs')), false);
    assert.throws(() => agents.recordFeedback({ config, id: 'EX-004', role: 'PM', step: 'align', feedback: 'again' }), /not running/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the review roster follows the tier; the step closes only when every review file exists', () => {
  const { root, config, track } = setup({ tier: 'sensitive' });
  try {
    assert.deepEqual(agents.reviewRoster(config, 'light', root).map((r) => r.role), ['UX', 'Brand', 'QA']);
    assert.deepEqual(agents.reviewRoster(config, 'sensitive', root).map((r) => r.role), ['Architect', 'Security', 'UX', 'Brand', 'Code Reviewer', 'QA']);
    const { calls, launchAgents } = fakeLauncher();
    let t = agents.launchStep({ config, track: { ...track, currentStep: 'team_review' }, stepKey: 'team_review', launchAgents });
    assert.equal(calls.length, 6);
    assert.ok(calls.every((c) => c.opts.cwd === track.worktree), 'reviewers read the integration worktree');
    assert.match(calls.find((c) => c.list[0].role === 'Code Reviewer').list[0].instruction, /removed or changed/);
    assert.match(calls.find((c) => c.list[0].role === 'QA').list[0].instruction, /rerun it on the commit before/);
    const dir = agents.reviewsDir(config, t);
    for (const c of calls) t = agents.recordFeedback({ config, id: 'EX-004', role: c.list[0].role, step: 'team_review', feedback: '**Verdict:** accept' });
    assert.equal(t.steps.team_review.status, 'running', 'no review files yet');
    for (const c of calls) write(dir, `${c.list[0].role.toLowerCase().replace(/\s+/g, '-')}.md`, '**Verdict:** accept\n');
    t = agents.completeStep({ config, track: tracks.loadTrack(root, 'EX-004'), stepKey: 'team_review' });
    assert.equal(t.currentStep, 'owner_decision');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('apply hands over to ready; an unknown role or step is refused', () => {
  const { root, config, track } = setup();
  try {
    const { launchAgents } = fakeLauncher();
    let t = agents.launchStep({ config, track: { ...track, currentStep: 'apply' }, stepKey: 'apply', launchAgents });
    assert.deepEqual(t.steps.apply.agents.map((a) => a.role), ['iOS Dev', 'Docs']);
    assert.throws(() => agents.recordFeedback({ config, id: 'EX-004', role: 'Nobody', step: 'apply', feedback: 'x' }), /no agent Nobody/);
    t = agents.recordFeedback({ config, id: 'EX-004', role: 'iOS Dev', step: 'apply', feedback: 'x' });
    t = agents.recordFeedback({ config, id: 'EX-004', role: 'Docs', step: 'apply', feedback: 'x' });
    assert.equal(t.currentStep, 'ready');
    assert.throws(() => agents.launchStep({ config, track: t, stepKey: 'owner_decision', launchAgents }), /not a reconcile agent step/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
