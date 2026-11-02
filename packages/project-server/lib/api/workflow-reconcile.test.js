'use strict';

// The reconcile workflow type: the verify-and-merge half of a reconcile track,
// run in the workflow slot (docs/plans/reconciliation-workflow.md). Starting it
// takes over the track's branch from the track's worktree; cancelling hands the
// branch back instead of deleting it. Agent steps are not driven here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { execFileSync } = require('child_process');

const { createWorkflowRouter, stepSequence, reconcileSequence, fixReturnStep } = require('./workflow');
const { loadConfig } = require('../config');
const { createStateManager } = require('../state');
const tracks = require('../reconcile-track');

function fixture({ step = 'ready', tier = 'sensitive' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-reconcile-'));
  const files = {
    '.build-studio/config.yaml': 'name: rc-fixture\nport: 5199\ndocs_path: ./docs\nroles:\n  execution:\n    - role: Fullstack Dev\n      skill: fullstack_dev\n  review: []\n  standalone: []\n',
    '.gitignore': '.build-studio/workflow-state.json\n.build-studio/run-state.json\n.build-studio/snapshots/\ndocs/agent-status.json\ntmp/\n',
    'docs/backlog/LS-010.md': '---\nid: LS-010\ntitle: Reconcile design/x\ntype: Task\nstatus: Backlog\nprd: null\n---\n\nRecord.\n',
    'docs/project-state.md': '# Project State\n\n<!-- BACKLOG-START -->\n\n### Now\n\n- LS-010 — Reconcile design/x  [Task · Backlog]\n\n<!-- BACKLOG-END -->\n',
    'app/a.txt': 'a\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  const wt = path.join(root, 'tmp', '.worktrees', 'reconcile-LS-010');
  g('worktree', 'add', '-q', '-b', 'reconcile/LS-010', wt);
  fs.writeFileSync(path.join(wt, 'app/a.txt'), 'a, from outside\n');
  execFileSync('git', ['commit', '-q', '-am', 'feat(LS-010): import design/x'], { cwd: wt });
  tracks.saveTrack(root, {
    id: 'LS-010', status: 'open', createdAt: '2026-11-02T00:00:00.000Z', record: 'docs/backlog/LS-010.md', tier,
    source: { pin: 'refs/x', sha: 'abc' }, target: { ref: 'main' }, floor: { LS: 12 },
    worktree: wt, branch: 'reconcile/LS-010', currentStep: step,
    steps: Object.fromEntries(tracks.STEPS.map((s) => [s, { status: s === 'ready' ? 'pending' : 'done' }])),
  });
  return { root, wt, g, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function mount(root) {
  const config = loadConfig(root);
  const state = createStateManager(config, () => {});
  const gitOps = { branchExists: () => false, removeWorktree: () => {}, deleteBranch: () => {}, commitsAhead: () => 0, mergeBranch: () => {}, abortMerge: () => {}, createBranchFromMain: () => {} };
  const tmuxOps = { killSessionAndDevPorts: () => {}, killWindowAndChildren: () => {} };
  const app = express();
  app.use(express.json());
  app.use('/api', createWorkflowRouter(config, state, gitOps, tmuxOps, () => {}));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: res.status, body: await res.json() };
  };
  return { post, state, close: () => new Promise((r) => server.close(r)) };
}

test('the sequence: security_audit only in the Sensitive tier, owner_checks at the end', () => {
  assert.deepEqual(reconcileSequence({}, { reconcileTier: 'sensitive' }), ['qa_validation', 'security_audit', 'merge_to_main', 'capture_learnings', 'owner_checks']);
  assert.deepEqual(reconcileSequence({}, { reconcileTier: 'standard' }), ['qa_validation', 'merge_to_main', 'capture_learnings', 'owner_checks']);
  assert.deepEqual(stepSequence({ type: 'reconcile', reconcileTier: 'light' }, {}), ['qa_validation', 'merge_to_main', 'capture_learnings', 'owner_checks']);
});

test('a reconcile run\'s fix rounds return to the step that sent them, not code_review', () => {
  assert.equal(fixReturnStep({ type: 'reconcile', fixSource: 'security_audit' }), 'security_audit');
  assert.equal(fixReturnStep({ type: 'reconcile' }), 'qa_validation');
  assert.equal(fixReturnStep({ type: 'execution' }), 'code_review');
  assert.equal(fixReturnStep({ type: 'execution', returnTo: 'demo_review' }), 'demo_review');
});

test('starting takes over the track\'s branch in the main checkout; the track is verifying', async () => {
  const { root, wt, g, clean } = fixture();
  const api = await mount(root);
  try {
    const r = await api.post('/workflow/start', { type: 'reconcile', input: 'LS-010' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const wf = api.state.loadWorkflow();
    assert.equal(wf.type, 'reconcile');
    assert.equal(wf.currentStep, 'qa_validation');
    assert.deepEqual(Object.keys(wf.steps), ['qa_validation', 'security_audit', 'merge_to_main', 'capture_learnings', 'owner_checks']);
    assert.equal(wf.branch, 'reconcile/LS-010');
    assert.equal(wf.reviewBranch, 'reconcile/LS-010');
    assert.equal(wf.itemId, 'LS-010');
    assert.equal(wf.prdPath, 'docs/backlog/LS-010.md');
    assert.equal(wf.reconcileTier, 'sensitive');
    assert.equal(g('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'reconcile/LS-010');
    assert.equal(fs.readFileSync(path.join(root, 'app/a.txt'), 'utf8'), 'a, from outside\n');
    assert.equal(fs.existsSync(wt), false, 'the track gave up its worktree');
    const t = tracks.loadTrack(root, 'LS-010');
    assert.equal(t.status, 'verifying');
    assert.equal(t.worktree, null);
    // The floor still holds while verifying: nothing is merged yet.
    assert.equal(tracks.idFloor(root, 'LS'), 12);
  } finally {
    await api.close();
    clean();
  }
});

test('cancelling hands the branch back to the track, never deletes it', async () => {
  const { root, g, clean } = fixture();
  const api = await mount(root);
  try {
    assert.equal((await api.post('/workflow/start', { type: 'reconcile', input: 'LS-010' })).status, 200);
    const c = await api.post('/workflow/cancel', { deleteWorktrees: true });
    assert.equal(c.status, 200);
    assert.equal(c.body.deletedBranches, false);
    assert.equal(g('branch', '--list', 'reconcile/LS-010').trim(), 'reconcile/LS-010');
    const t = tracks.loadTrack(root, 'LS-010');
    assert.equal(t.status, 'open');
    assert.equal(t.currentStep, 'ready');
  } finally {
    await api.close();
    clean();
  }
});

test('a track that is not ready, or does not exist, cannot be started', async () => {
  const { root, clean } = fixture({ step: 'apply' });
  const api = await mount(root);
  try {
    const notReady = await api.post('/workflow/start', { type: 'reconcile', input: 'LS-010' });
    assert.equal(notReady.status, 409);
    assert.match(notReady.body.error, /not ready/);
    const missing = await api.post('/workflow/start', { type: 'reconcile', input: 'LS-099' });
    assert.equal(missing.status, 404);
  } finally {
    await api.close();
    clean();
  }
});
