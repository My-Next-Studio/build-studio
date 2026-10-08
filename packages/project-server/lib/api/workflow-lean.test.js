'use strict';

// Starting a lean execution run (lean-execution.js), over a fixture git repo:
// the preset is accepted only for execution, refused when the build steps are
// not on Claude, and the run gets the lean sequence and the lean task. The
// steps that launch agents are not driven here; they need tmux.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { execFileSync } = require('child_process');

const { createWorkflowRouter, stepSequence } = require('./workflow');
const { loadConfig } = require('../config');
const { createStateManager } = require('../state');
const { LEAN_EXECUTION_STEPS } = require('../lean-execution');

function makeFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lean-test-'));
  const files = {
    '.build-studio/config.yaml': [
      'name: lean-fixture',
      'port: 5198',
      'docs_path: ./docs',
      'roles:',
      '  execution:',
      '    - role: Fullstack Dev',
      '      skill: fullstack_dev',
      '      branch_prefix: fs',
      '  review: []',
      '  standalone: []',
      '',
    ].join('\n'),
    '.gitignore': [
      '.build-studio/workflow-state.json',
      '.build-studio/run-state.json',
      '.build-studio/snapshots/',
      'docs/agent-status.json',
      '',
    ].join('\n'),
    'docs/prds/PRD-001-notes.md': '# PRD-001 Notes\n\n## Acceptance criteria\n- AC-1: a note can be saved\n',
    'docs/backlog/LS-002.md':
      '---\nid: LS-002\ntitle: Save notes\ntype: Feature\nstatus: Reviewed\nprd: docs/prds/PRD-001-notes.md\n---\n\nSave a note.\n',
    'docs/project-state.md':
      '# Project State\n\n<!-- BACKLOG-START -->\n\n### Release 0.1\n\n'
      + '- LS-002 — Save notes  [Feature · Reviewed]\n\n<!-- BACKLOG-END -->\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  execFileSync('git', ['branch', '-M', 'main'], { cwd: root });
  return { root, clean: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
}

async function mountRouter(root, configure) {
  const config = loadConfig(root);
  if (configure) configure(config);
  const state = createStateManager(config, () => {});
  const gitOps = {
    branchExists: () => false, removeWorktree: () => {}, deleteBranch: () => {},
    commitsAhead: () => 0, mergeBranch: () => {}, abortMerge: () => {},
    createBranchFromMain: () => {},
  };
  const tmuxOps = { killSessionAndDevPorts: () => {}, killWindowAndChildren: () => {} };
  const app = express();
  app.use(express.json());
  app.use('/api', createWorkflowRouter(config, state, gitOps, tmuxOps, () => {}));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const send = (method, urlPath, body) => new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed = {};
          try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
  return {
    post: (urlPath, body) => send('POST', urlPath, body || {}),
    get: (urlPath) => send('GET', urlPath),
    state, config, close: () => new Promise((r) => server.close(r)),
  };
}

test('start lean: the run carries the preset and only the lean steps', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    const res = await srv.post('/api/workflow/start', { type: 'execution', input: 'LS-002', preset: 'lean' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const wf = res.body.workflow;
    assert.equal(wf.preset, 'lean');
    assert.deepEqual(Object.keys(wf.steps), LEAN_EXECUTION_STEPS);
    assert.equal(wf.currentStep, 'planning');
    assert.deepEqual(stepSequence(wf, srv.config), LEAN_EXECUTION_STEPS);
  } finally { await srv.close(); repo.clean(); }
});

test('start without a preset is lean: lean is the default', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    const res = await srv.post('/api/workflow/start', { type: 'execution', input: 'LS-002' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.workflow.preset, 'lean');
    assert.deepEqual(Object.keys(res.body.workflow.steps), LEAN_EXECUTION_STEPS);
    assert.equal(res.body.workflow.presetFallback, undefined);
  } finally { await srv.close(); repo.clean(); }
});

test('start with preset full is the full chain', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    const res = await srv.post('/api/workflow/start', { type: 'execution', input: 'LS-002', preset: 'full' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.workflow.preset, undefined);
    assert.ok(res.body.workflow.steps.qa_tests, 'the full chain keeps qa_tests');
  } finally { await srv.close(); repo.clean(); }
});

test('a defaulted lean start falls back to the full chain when the build group runs on another CLI', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root, (config) => {
    config.cli = { ...(config.cli || {}), groups: { ...((config.cli || {}).groups || {}), build: { cli: 'codex' } } };
  });
  try {
    const res = await srv.post('/api/workflow/start', { type: 'execution', input: 'LS-002' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.workflow.preset, undefined);
    assert.ok(res.body.workflow.steps.qa_tests, 'the full chain keeps qa_tests');
    assert.match(res.body.workflow.presetFallback, /task_execution runs on codex/);
  } finally { await srv.close(); repo.clean(); }
});

test('a review start is unaffected by the lean default', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    const res = await srv.post('/api/workflow/start', { type: 'review', input: 'LS-002' });
    assert.notEqual(res.body.leanRefused, true);
    assert.equal((res.body.workflow || {}).preset, undefined);
  } finally { await srv.close(); repo.clean(); }
});

test('start lean is refused when the build group runs on another CLI', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root, (config) => {
    config.cli = { ...(config.cli || {}), groups: { ...((config.cli || {}).groups || {}), build: { cli: 'codex' } } };
  });
  try {
    const res = await srv.post('/api/workflow/start', { type: 'execution', input: 'LS-002', preset: 'lean' });
    assert.equal(res.status, 400);
    assert.equal(res.body.leanRefused, true);
    assert.match(res.body.error, /task_execution runs on codex/);
    // Refused before anything changed: no workflow and no run branch.
    assert.equal(srv.state.loadWorkflow(), null);
    const branches = execFileSync('git', ['branch', '--list', 'exec/*'], { cwd: repo.root, encoding: 'utf8' });
    assert.equal(branches.trim(), '');
  } finally { await srv.close(); repo.clean(); }
});

test('a preset on a review run is refused', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    const res = await srv.post('/api/workflow/start', { type: 'review', input: 'LS-002', preset: 'lean' });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /execution runs only/);
  } finally { await srv.close(); repo.clean(); }
});

test('lean planning synthesises the lean task, with no planner agent', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root, (config) => {
    // Lean is monolithic whatever the project chose.
    config.step_strategies = { task_execution: 'fine-grained' };
  });
  try {
    await srv.post('/api/workflow/start', { type: 'execution', input: 'LS-002', preset: 'lean' });
    const res = await srv.post('/api/workflow/advance', {});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const wf = srv.state.loadWorkflow();
    assert.equal(wf.currentStep, 'task_execution');
    assert.equal(wf.taskPlan.monolithic, true);
    assert.match(wf.taskPlan.tasks[0].description, /no pre-implementation tests/);
  } finally { await srv.close(); repo.clean(); }
});

test('GET /workflow exposes the lean sequence for the hub timeline', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    const res = await srv.get('/api/workflow');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.projectWorkflowSteps.lean, LEAN_EXECUTION_STEPS);
  } finally { await srv.close(); repo.clean(); }
});
