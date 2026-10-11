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
  const router = createWorkflowRouter(config, state, gitOps, tmuxOps, () => {});
  app.use('/api', router);
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
    state, config, router, close: () => new Promise((r) => server.close(r)),
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

// A QA agent marked done by hand has a report with no test counts. Approve
// refuses it; force approve used to refuse it too, because the override only
// reached the strict failing-tests gate (fazon, 2026-10-10).
async function atQaWithReport(srv, feedback, status = 'done') {
  await srv.post('/api/workflow/start', { type: 'execution', input: 'LS-002', preset: 'lean' });
  const wf = srv.state.loadWorkflow();
  wf.currentStep = 'qa_validation';
  wf.steps.qa_validation = { status: 'running', agents: [{ role: 'QA', window: 'qa-validate-r5', status, feedback }] };
  srv.state.saveWorkflow(wf);
}

test('force approve passes a QA agent marked done by hand, and records it', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    await atQaWithReport(srv, 'Manually marked as done.');
    const plain = await srv.post('/api/workflow/advance', { action: 'approve' });
    assert.equal(plain.status, 400);
    assert.match(plain.body.error, /recognizable test results/);

    const forced = await srv.post('/api/workflow/advance', { action: 'approve', override: true, note: 'owner accepts' });
    assert.equal(forced.status, 200, JSON.stringify(forced.body));
    const wf = srv.state.loadWorkflow();
    assert.equal(wf.steps.qa_validation.status, 'completed');
    assert.notEqual(wf.currentStep, 'qa_validation');
    assert.match(wf.steps.qa_validation.overrides.at(-1).reason, /owner accepts \(bypassed: QA report gates\)/);
  } finally { await srv.close(); repo.clean(); }
});

test('force approve still waits for a QA agent that is running', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    await atQaWithReport(srv, '', 'running');
    const forced = await srv.post('/api/workflow/advance', { action: 'approve', override: true });
    assert.equal(forced.status, 400);
    assert.match(forced.body.error, /still running/);
  } finally { await srv.close(); repo.clean(); }
});

// A QA round that still blocks after a fix round which changed nothing is held
// for the owner instead of going back to the devs for the same state again.
const BLOCKING_QA = '**Approved:** no\n**Blocking:** 1  |  **Medium:** 0  |  **Low:** 0\n**Tests passed:** 5655/5685 (carried from round 4)\n\n### Findings\n1. BLOCKING: the go-live gate exits 1.';

async function tickOnce(srv) {
  await srv.post('/api/workflow/auto-advance', { enabled: true });
  await new Promise((r) => setTimeout(r, 900)); // the first tick runs after 500 ms
  await srv.post('/api/workflow/auto-advance', { enabled: false });
}

test('auto-advance holds a blocking QA round that follows a fix round with no change', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    await atQaWithReport(srv, BLOCKING_QA);
    const wf = srv.state.loadWorkflow();
    wf.round = 5;
    wf.qaUnchangedRound = 5;
    srv.state.saveWorkflow(wf);
    await tickOnce(srv);
    const after = srv.state.loadWorkflow();
    assert.equal(after.currentStep, 'qa_validation');
    assert.match(after.steps.qa_validation.autoAdvanceError, /changed no code/);
  } finally { await srv.close(); repo.clean(); }
});

test('auto-advance does not hold a blocking QA round after a fix round that changed code', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    await atQaWithReport(srv, BLOCKING_QA);
    const wf = srv.state.loadWorkflow();
    wf.round = 5;
    wf.qaUnchangedRound = 4; // an earlier round was unchanged, this one is not
    srv.state.saveWorkflow(wf);
    await tickOnce(srv);
    assert.equal(srv.state.loadWorkflow().steps.qa_validation.autoAdvanceError, undefined);
  } finally { await srv.close(); repo.clean(); }
});

// Findings only the owner can close (lib/awaiting-owner.js): auto-advance
// holds instead of approving on Blocking: 0 or starting a fix round, and send
// to devs refuses unless the owner directs it.
const OWNER_ONLY_QA = '**Approved:** no\n**Blocking:** 0  |  **Medium:** 0  |  **Low:** 0\n**Tests passed:** 120/120\n\n**Awaiting owner:** approve the study queries (AC-1)';

test('auto-advance holds a QA round whose only open findings wait on the owner', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    await atQaWithReport(srv, OWNER_ONLY_QA);
    await tickOnce(srv);
    const after = srv.state.loadWorkflow();
    assert.equal(after.currentStep, 'qa_validation');
    assert.notEqual(after.steps.qa_validation.status, 'completed');
    assert.match(after.steps.qa_validation.autoAdvanceError, /waiting on you, not on a developer: approve the study queries/);
  } finally { await srv.close(); repo.clean(); }
});

test('send to devs refuses owner-only findings, and accepts them with the owner’s notes', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    await atQaWithReport(srv, OWNER_ONLY_QA);
    const refused = await srv.post('/api/workflow/advance', { action: 'send_to_devs' });
    assert.equal(refused.status, 400);
    assert.deepEqual(refused.body.awaitingOwner, ['approve the study queries (AC-1)']);

    const directed = await srv.post('/api/workflow/advance', { action: 'send_to_devs', notes: 'Queries approved; run the study.' });
    assert.equal(directed.status, 200, JSON.stringify(directed.body));
    assert.equal(srv.state.loadWorkflow().steps.qa_validation.status, 'completed');
  } finally { await srv.close(); repo.clean(); }
});

// The work queue asks "would this start?" with the start's own checks
// (startWorkflow's dryRun): the same refusals, and nothing created.
test('readiness: a startable run is ready, and nothing is created', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    const r = srv.router.workflowReadiness({ type: 'execution', input: 'LS-002' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.ready, true);
    assert.equal(r.json.branch, 'exec/LS-002');
    assert.equal(r.json.preset, 'lean');
    assert.equal(srv.state.loadWorkflow(), null);
    const branches = execFileSync('git', ['branch', '--list', 'exec/*'], { cwd: repo.root, encoding: 'utf8' });
    assert.equal(branches.trim(), '');
    assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: repo.root, encoding: 'utf8' }).trim(), 'main');
  } finally { await srv.close(); repo.clean(); }
});

test('readiness refuses exactly as the start does', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    // LS-002 is Reviewed, so a review run is refused with the start's own reason.
    const body = { type: 'review', input: 'LS-002' };
    const ready = srv.router.workflowReadiness(body);
    const start = await srv.post('/api/workflow/start', body);
    assert.equal(ready.status, 409);
    assert.deepEqual({ status: ready.status, json: ready.json }, { status: start.status, json: start.body });

    // With a workflow active, every readiness check says so.
    await srv.post('/api/workflow/start', { type: 'execution', input: 'LS-002' });
    const busy = srv.router.workflowReadiness({ type: 'execution', input: 'LS-002' });
    assert.equal(busy.status, 409);
    assert.equal(busy.json.error, 'workflow already active');
  } finally { await srv.close(); repo.clean(); }
});

// The run's last step, owner_checks (owner, 2026-10-11): the manual checks the
// run recommended. With checks it waits for the owner's Done, which asks for
// no proof; with none the run completes. Ticks never complete it.
async function atCaptureLearnings(srv, ownerChecks) {
  await srv.post('/api/workflow/start', { type: 'execution', input: 'LS-002', preset: 'lean' });
  const wf = srv.state.loadWorkflow();
  wf.currentStep = 'capture_learnings';
  wf.steps.capture_learnings = { status: 'pending', agents: [] };
  if (ownerChecks) wf.ownerChecks = ownerChecks;
  srv.state.saveWorkflow(wf);
}

test('owner checks: with checks the run stops there, a tick leaves it, and Done completes it', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    await atCaptureLearnings(srv, [{ text: 'Look at every view at 1024 × 720', step: 'qa_validation' }]);
    await srv.post('/api/workflow/advance', {}); // a clean run skips capture, then reaches owner_checks
    let wf = srv.state.loadWorkflow();
    assert.equal(wf.currentStep, 'owner_checks');
    assert.deepEqual(wf.steps.owner_checks.checks.map((c) => c.text), ['Look at every view at 1024 × 720']);
    assert.equal(wf.steps.owner_checks.status, 'pending');

    await tickOnce(srv);
    await srv.post('/api/workflow/advance', {});
    assert.equal(srv.state.loadWorkflow().currentStep, 'owner_checks', 'nothing but Done completes it');

    const done = await srv.post('/api/workflow/advance', { action: 'approve' });
    assert.equal(done.status, 200);
    wf = srv.state.loadWorkflow();
    assert.equal(wf.currentStep, 'completed');
    assert.equal(wf.steps.owner_checks.status, 'completed');
  } finally { await srv.close(); repo.clean(); }
});

test('owner checks: with none, the run completes by itself', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    await atCaptureLearnings(srv, null);
    await srv.post('/api/workflow/advance', {});
    const wf = srv.state.loadWorkflow();
    assert.equal(wf.currentStep, 'completed');
    assert.equal(wf.steps.owner_checks.status, 'completed');
  } finally { await srv.close(); repo.clean(); }
});

test('owner checks are gathered from every report as it arrives', async () => {
  const repo = makeFixtureRepo();
  const srv = await mountRouter(repo.root);
  try {
    await srv.post('/api/workflow/start', { type: 'execution', input: 'LS-002', preset: 'lean' });
    const wf = srv.state.loadWorkflow();
    wf.currentStep = 'qa_validation';
    wf.steps.qa_validation = { status: 'running', agents: [{ role: 'QA', status: 'running', window: 'qa-validate' }] };
    srv.state.saveWorkflow(wf);
    const r = await srv.post('/api/workflow/feedback', { role: 'QA', step: 'qa_validation', feedback: '**Approved:** yes\n**Blocking:** 0\n**Tests passed:** 10/10\n\n### Owner checks\n- Inspect the fatal error screen\n' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(srv.state.loadWorkflow().ownerChecks, [{ text: 'Inspect the fatal error screen', step: 'qa_validation' }]);
  } finally { await srv.close(); repo.clean(); }
});
