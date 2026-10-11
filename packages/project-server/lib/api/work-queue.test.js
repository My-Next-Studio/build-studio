'use strict';

// The work queue's routes over a fixture git repo, against the plan's
// acceptance list (docs/plans/work-queue-and-remote-overview.md): a mixed
// queue in a chosen order that survives a restart, a blocked first entry that
// stays next with its reason, a start that re-checks and cannot duplicate, a
// run started elsewhere taking its entry, and reads that change no file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { execFileSync } = require('child_process');

const { createWorkflowRouter } = require('./workflow');
const { createDraftingRouter } = require('./drafting');
const { createWorkQueueRouter } = require('./work-queue');
const { loadConfig } = require('../config');
const { createStateManager } = require('../state');

function makeFixtureRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'work-queue-api-')));
  const item = (id, fm) => `---\nid: ${id}\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\nBody.\n`;
  const files = {
    '.build-studio/config.yaml': [
      'name: wq-fixture', 'port: 5199', 'docs_path: ./docs',
      'roles:', '  execution:', '    - role: Fullstack Dev', '      skill: fullstack_dev', '      branch_prefix: fs',
      '  review: []', '  standalone: []', '',
    ].join('\n'),
    '.gitignore': ['.build-studio/workflow-state.json', '.build-studio/run-state.json', '.build-studio/snapshots/', '.build-studio/draft-state.json', 'docs/agent-status.json', ''].join('\n'),
    'docs/prds/PRD-002-notes.md': '# PRD-002 Notes\n\n## Acceptance criteria\n- AC-1: a note can be saved\n',
    'docs/prds/PRD-005-tags.md': '# PRD-005 Tags\n',
    'docs/backlog/LS-002.md': item('LS-002', { title: 'Save notes', type: 'Feature', status: 'Reviewed', prd: 'docs/prds/PRD-002-notes.md' }),
    'docs/backlog/LS-003.md': item('LS-003', { title: 'Search', type: 'Feature', status: 'Backlog' }),
    'docs/backlog/LS-004.md': item('LS-004', { title: 'Crash on empty note', type: 'Bug', status: 'Backlog' }),
    'docs/backlog/LS-005.md': item('LS-005', { title: 'Tags', type: 'Feature', status: 'Drafted', prd: 'docs/prds/PRD-005-tags.md' }),
    'docs/project-state.md': '# Project State\n\n<!-- BACKLOG-START -->\n\n### Release 0.1\n\n'
      + '- LS-002 — Save notes  [Feature · Reviewed]\n- LS-003 — Search  [Feature · Backlog]\n'
      + '- LS-004 — Crash on empty note  [Bug · Backlog]\n- LS-005 — Tags  [Feature · Drafted]\n\n<!-- BACKLOG-END -->\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const g = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.com');
  g('config', 'user.name', 'Test');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return { root, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const idleTmux = { panePid: () => null, hasLiveDescendant: () => false, killSessionAndDevPorts: () => {}, killWindowAndChildren: () => {} };

async function mount(root) {
  const config = loadConfig(root);
  const state = createStateManager(config, () => {});
  const gitOps = { branchExists: () => false, removeWorktree: () => {}, deleteBranch: () => {}, commitsAhead: () => 0, mergeBranch: () => {}, abortMerge: () => {}, createBranchFromMain: () => {} };
  const workflowRouter = createWorkflowRouter(config, state, gitOps, idleTmux, () => {});
  const draftingRouter = createDraftingRouter(config, state, idleTmux);
  const app = express();
  app.use(express.json());
  app.use('/api', draftingRouter);
  app.use('/api', workflowRouter);
  app.use('/api', createWorkQueueRouter(config, { state, workflowRouter, draftingRouter }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, urlPath, body) => {
    const res = await fetch(base + urlPath, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  return { call, state, config, close: () => new Promise((r) => server.close(r)) };
}

const tracked = (root) => execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });

test('three entries in a chosen order, mixed phases and a bug, survive a restart', async () => {
  const repo = makeFixtureRepo();
  let srv = await mount(repo.root);
  try {
    for (const item of ['LS-005', 'LS-004', 'LS-003']) assert.equal((await srv.call('POST', '/api/work-queue', { item })).status, 201);
    const q = (await srv.call('GET', '/api/work-queue')).body;
    assert.deepEqual(q.pending.map((e) => e.item), ['LS-005', 'LS-004', 'LS-003']);
    // Move the bug to the front.
    const bug = q.pending[1];
    await srv.call('PATCH', `/api/work-queue/${bug.id}`, { position: 0 });
    await srv.close();

    srv = await mount(repo.root); // a restart: a new server over the same files
    const after = (await srv.call('GET', '/api/work-queue')).body;
    assert.deepEqual(after.pending.map((e) => e.item), ['LS-004', 'LS-005', 'LS-003']);
    assert.equal(after.next.action, 'bugfix');
    // The queue file is ignored, and the rule was committed: the tree stays clean.
    assert.equal(tracked(repo.root), '');
  } finally { await srv.close(); repo.clean(); }
});

test('a blocked first entry stays next, with the start’s own reason', async () => {
  const repo = makeFixtureRepo();
  const srv = await mount(repo.root);
  try {
    // Review LS-002, which is Reviewed: the review start refuses it.
    await srv.call('POST', '/api/work-queue', { item: 'LS-002', action: 'review' });
    await srv.call('POST', '/api/work-queue', { item: 'LS-005' });
    const q = (await srv.call('GET', '/api/work-queue')).body;
    assert.equal(q.next.entryId, q.pending[0].id);
    assert.equal(q.next.ready, false);
    assert.match(q.next.reason, /requires status "Drafted"/);
    assert.deepEqual(q.pending.map((e) => e.item), ['LS-002', 'LS-005'], 'the queue does not jump it');
  } finally { await srv.close(); repo.clean(); }
});

test('a start re-checks, links its run, and a repeated start makes no second run', async () => {
  const repo = makeFixtureRepo();
  const srv = await mount(repo.root);
  try {
    const added = (await srv.call('POST', '/api/work-queue', { item: 'LS-002' })).body.added;
    await srv.call('POST', '/api/work-queue', { item: 'LS-004' });
    const first = await srv.call('POST', `/api/work-queue/${added.id}/start`, {});
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.started.action, 'execute');
    const wf = srv.state.loadWorkflow();
    assert.equal(wf.itemId, 'LS-002');
    assert.equal(first.body.current.id, added.id);
    assert.equal(first.body.current.run.id, wf.id);
    assert.equal(first.body.current.status.state, 'running');
    assert.deepEqual(first.body.pending.map((e) => e.item), ['LS-004']);

    const again = await srv.call('POST', `/api/work-queue/${added.id}/start`, {});
    assert.equal(again.status, 200);
    assert.equal(again.body.alreadyStarted, true);
    assert.equal(srv.state.loadWorkflow().id, wf.id, 'no second run');

    // The next entry is not ready while that run holds the slot.
    assert.equal(again.body.next.ready, false);
    assert.equal(again.body.next.reason, 'workflow already active');
  } finally { await srv.close(); repo.clean(); }
});

test('a run started outside the queue takes the entry for its item', async () => {
  const repo = makeFixtureRepo();
  const srv = await mount(repo.root);
  try {
    await srv.call('POST', '/api/work-queue', { item: 'LS-005' });
    const entry = (await srv.call('POST', '/api/work-queue', { item: 'LS-002' })).body.added;
    const started = await srv.call('POST', '/api/workflow/start', { type: 'execution', input: 'LS-002' });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const q = (await srv.call('GET', '/api/work-queue')).body;
    assert.equal(q.current.id, entry.id);
    assert.equal(q.outsideQueue, null);
    assert.deepEqual(q.pending.map((e) => e.item), ['LS-005']);
  } finally { await srv.close(); repo.clean(); }
});

test('removing an entry never cancels its run, and reading changes no project file', async () => {
  const repo = makeFixtureRepo();
  const srv = await mount(repo.root);
  try {
    const entry = (await srv.call('POST', '/api/work-queue', { item: 'LS-002' })).body.added;
    await srv.call('POST', `/api/work-queue/${entry.id}/start`, {});
    const wfId = srv.state.loadWorkflow().id;
    const before = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo.root, encoding: 'utf8' });
    for (let i = 0; i < 3; i++) await srv.call('GET', '/api/work-queue');
    assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo.root, encoding: 'utf8' }), before);

    assert.equal((await srv.call('DELETE', `/api/work-queue/${entry.id}`)).status, 200);
    assert.equal(srv.state.loadWorkflow().id, wfId, 'the run carries on');
    const q = (await srv.call('GET', '/api/work-queue')).body;
    assert.equal(q.current, null);
    assert.equal(q.outsideQueue.id, wfId, 'now shown as work outside the queue');
  } finally { await srv.close(); repo.clean(); }
});

test('adding refuses an unknown item or action', async () => {
  const repo = makeFixtureRepo();
  const srv = await mount(repo.root);
  try {
    assert.equal((await srv.call('POST', '/api/work-queue', { item: 'LS-999' })).status, 404);
    assert.equal((await srv.call('POST', '/api/work-queue', { item: 'not an id' })).status, 400);
    assert.equal((await srv.call('POST', '/api/work-queue', { item: 'LS-002', action: 'deploy' })).status, 400);
  } finally { await srv.close(); repo.clean(); }
});
