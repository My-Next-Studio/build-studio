'use strict';

// merge_to_main runs `git merge` without blocking the event loop.
//
// A managed project can install a pre-merge-commit hook as its merge gate,
// and git runs it inside the merge; a real one takes ~35 s. These tests give a
// fixture repo a slow fake hook and drive the real router: another request
// must be served while the hook runs, a second merge request must be refused
// rather than overlap, and a failing hook must leave the checkout as before
// with the hook's output in the step error.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { execFileSync } = require('child_process');

const { createWorkflowRouter } = require('./workflow');
const { loadConfig } = require('../config');
const { createStateManager } = require('../state');
const { readItem } = require('../backlog');
const { gitMergeNoFf } = require('../git-merge');

const HOOK_SECONDS = 2;

test('merge_to_main: other requests are served while a slow pre-merge-commit hook runs', async () => {
  const fx = makeFixtureRepo();
  installHook(fx, { seconds: HOOK_SECONDS, exitCode: 0 });
  const srv = await mountRouter(fx.root);
  try {
    stageBugfixAtMerge(fx, srv);
    const mainBefore = gitRev(fx.root, 'main');

    let mergeDoneAt = null;
    const mergeStartedAt = Date.now();
    const merge = srv.post('/api/workflow/advance', {}).then((r) => { mergeDoneAt = Date.now(); return r; });

    // Wait until git is inside the hook. Under a blocking merge this loop
    // cannot run until the merge is over, and the ordering checks below fail.
    await waitFor(() => fs.existsSync(fx.hookStartedFile));

    const t0 = Date.now();
    const status = await srv.get('/api/workflow');
    const statusMs = Date.now() - t0;
    assert.equal(status.status, 200);
    assert.equal(mergeDoneAt, null, 'GET /workflow was only answered after the merge finished: the event loop was blocked');
    assert.ok(statusMs < 1000, `GET /workflow took ${statusMs} ms during the merge`);
    assert.equal(status.body.workflow.steps.merge_to_main.status, 'running');

    // A second merge for the same workflow is refused, not run alongside.
    const second = await srv.post('/api/workflow/advance', { action: 'retry' });
    assert.equal(second.status, 409, JSON.stringify(second.body));
    assert.match(second.body.error, /already running/);
    assert.equal(mergeDoneAt, null);

    // Cancel would move the checkout under the merge: refused too.
    const cancel = await srv.post('/api/workflow/cancel', {});
    assert.equal(cancel.status, 409, JSON.stringify(cancel.body));

    const res = await merge;
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(mergeDoneAt - mergeStartedAt >= HOOK_SECONDS * 1000 - 100, 'the hook did not actually run inside the merge');

    const wf = srv.state.loadWorkflow();
    assert.equal(wf.steps.merge_to_main.status, 'completed');
    assert.equal(wf.currentStep, 'capture_learnings');
    assert.notEqual(gitRev(fx.root, 'main'), mainBefore);
    assert.equal(currentBranch(fx.root), 'main');
    assert.equal(readItem(fx.root, './docs', 'LS-001').status, 'Done');
  } finally {
    await srv.close();
    fx.clean();
  }
});

test('merge_to_main: a failing hook aborts the merge, returns to main, and shows the hook output', async () => {
  const fx = makeFixtureRepo();
  installHook(fx, { seconds: 0, exitCode: 1 });
  const srv = await mountRouter(fx.root);
  try {
    stageBugfixAtMerge(fx, srv);
    const mainBefore = gitRev(fx.root, 'main');
    const branchBefore = gitRev(fx.root, 'fix/ls-001');

    const res = await srv.post('/api/workflow/advance', {});
    assert.equal(res.status, 500, JSON.stringify(res.body));

    const wf = srv.state.loadWorkflow();
    assert.equal(wf.currentStep, 'merge_to_main');
    assert.equal(wf.steps.merge_to_main.status, 'error');
    // Git forwards the hook's stdout to stderr, which lands in the message.
    assert.match(wf.steps.merge_to_main.error, /ci-check: 1 test failed \(fake\)/);
    assert.match(wf.steps.merge_to_main.error, /Failed to merge fix\/ls-001 into main/);

    assert.equal(gitRev(fx.root, 'main'), mainBefore);
    assert.equal(gitRev(fx.root, 'fix/ls-001'), branchBefore);
    assert.equal(currentBranch(fx.root), 'main');
    assert.equal(fs.existsSync(path.join(fx.root, '.git', 'MERGE_HEAD')), false, 'merge was not aborted');

    // The lock was released: a retry with the gate passing goes through.
    installHook(fx, { seconds: 0, exitCode: 0 });
    // The run branch is no longer checked out; a retry merges it from main.
    const retry = await srv.post('/api/workflow/advance', { action: 'retry' });
    assert.equal(retry.status, 200, JSON.stringify(retry.body));
    assert.equal(srv.state.loadWorkflow().steps.merge_to_main.status, 'completed');
  } finally {
    await srv.close();
    fx.clean();
  }
});

test('router start: a merge left running by a stopped server becomes a retryable error', async () => {
  const fx = makeFixtureRepo();
  const srv0 = await mountRouter(fx.root);
  stageBugfixAtMerge(fx, srv0);
  const wf0 = srv0.state.loadWorkflow();
  wf0.steps.merge_to_main = { status: 'running', startedAt: '2026-11-14T10:00:00.000Z' };
  srv0.state.saveWorkflow(wf0);
  await srv0.close();

  const srv = await mountRouter(fx.root);
  try {
    const wf = srv.state.loadWorkflow();
    assert.equal(wf.steps.merge_to_main.status, 'error');
    assert.match(wf.steps.merge_to_main.error, /stopped while this merge was running/);
  } finally {
    await srv.close();
    fx.clean();
  }
});

test('gitMergeNoFf: a hook that outlives the timeout is killed and named in the error', async () => {
  const fx = makeFixtureRepo();
  installHook(fx, { seconds: 3, exitCode: 0 });
  try {
    execFileSync('git', ['checkout', '-q', '-b', 'side'], { cwd: fx.root });
    fs.writeFileSync(path.join(fx.root, 'side.txt'), 'x\n');
    execFileSync('git', ['add', '-A'], { cwd: fx.root });
    execFileSync('git', ['commit', '-q', '-m', 'side'], { cwd: fx.root });
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: fx.root });

    await assert.rejects(
      gitMergeNoFf(fx.root, 'side', 'Merge side', { timeoutMs: 300 }),
      /timed out after 0\.3 s .*pre-merge-commit hook may be hanging/,
    );
  } finally {
    fx.clean();
  }
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function gitRev(root, ref) {
  return execFileSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8' }).trim();
}

function currentBranch(root) {
  return execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
}

async function waitFor(cond, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > until) throw new Error('waitFor: condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

// A pre-merge-commit hook outside the repo (core.hooksPath), so the working
// tree stays clean. It marks that it started, prints like a CI summary, sleeps,
// and exits with `exitCode`.
function installHook(fx, { seconds, exitCode }) {
  const hook = path.join(fx.hooksDir, 'pre-merge-commit');
  fs.writeFileSync(hook, [
    '#!/bin/sh',
    `touch "${fx.hookStartedFile}"`,
    'echo "ci-check: running fake gate"',
    `sleep ${seconds}`,
    exitCode === 0 ? 'echo "ci-check: all green"' : 'echo "ci-check: 1 test failed (fake)"',
    `exit ${exitCode}`,
    '',
  ].join('\n'));
  fs.chmodSync(hook, 0o755);
  try { fs.unlinkSync(fx.hookStartedFile); } catch (_) {}
  execFileSync('git', ['config', 'core.hooksPath', fx.hooksDir], { cwd: fx.root });
}

// A bugfix run at merge_to_main: committed fix/ls-001 branch, checked out.
function stageBugfixAtMerge(fx, srv) {
  execFileSync('git', ['checkout', '-q', '-b', 'fix/ls-001'], { cwd: fx.root });
  const abs = path.join(fx.root, 'src/save.js');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'module.exports = (body) => String(body || "");\n');
  execFileSync('git', ['add', '-A'], { cwd: fx.root });
  execFileSync('git', ['commit', '-q', '-m', 'fix: LS-001 empty save'], { cwd: fx.root });

  srv.state.saveWorkflow({
    id: 'bugfix-merge-async', type: 'bugfix', input: 'LS-001', itemId: 'LS-001',
    prdPath: 'docs/backlog/LS-001.md', currentStep: 'merge_to_main',
    branch: 'fix/ls-001', defaultBranch: 'main', reviewBranch: 'fix/ls-001',
    round: 1, feedback: [], sessionName: 'wf-merge-async',
    steps: {
      task_execution: { status: 'completed', agents: [] },
      qa_validation: { status: 'completed', agents: [] },
      code_review: { status: 'completed', agents: [] },
      merge_to_main: { status: 'pending' },
      capture_learnings: { status: 'pending', agents: [] },
    },
    taskExecution: { currentTaskIndex: 0, taskStates: { '0': { status: 'done', agents: [] } } },
  });
}

function makeFixtureRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-async-test-'));
  const hooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-async-hooks-'));
  const files = {
    '.build-studio/config.yaml': [
      'name: merge-async-fixture',
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
    'docs/backlog/LS-001.md':
      '---\nid: LS-001\ntitle: Crash on empty save\ntype: Bug\nstatus: Fixing\n---\n\nThe Save button throws on an empty note.\n',
    'docs/project-state.md':
      '# Project State\n\n<!-- BACKLOG-START -->\n\n### Release 0.1\n\n' +
      '- LS-001 — Crash on empty save  [Bug · Fixing]\n\n<!-- BACKLOG-END -->\n',
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

  return {
    root,
    hooksDir,
    hookStartedFile: path.join(hooksDir, 'started'),
    clean: () => {
      for (const d of [root, hooksDir]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
    },
  };
}

async function mountRouter(root) {
  const config = loadConfig(root);
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
      {
        hostname: '127.0.0.1', port, path: urlPath, method,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => { buf += c; });
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(buf); } catch { parsed = buf; }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });

  return {
    state,
    get: (p) => send('GET', p),
    post: (p, b) => send('POST', p, b),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
