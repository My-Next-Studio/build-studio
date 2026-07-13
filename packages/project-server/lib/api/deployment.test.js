'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const {
  createDeploymentRouter,
  resolveDeployTargets,
  normalizeDeployTarget,
  resolveCiFixStrategy,
  composeCiInvestigatePrompt,
  truncateTail,
} = require('./deployment');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-test-'));
}
function cleanDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}
function gitInit(dir) {
  const g = (args) => execFileSync('git', args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  g(['init']);
  g(['config', 'user.email', 't@t.t']);
  g(['config', 'user.name', 'test']);
}

function makeApp(config, deps) {
  const app = express();
  app.use(express.json());
  app.use('/api', createDeploymentRouter(config, null, deps || {}));
  return app;
}
async function req(app, method, url, body) {
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  } finally {
    server.close();
  }
}

// ─── pure helpers ─────────────────────────────────────────────────────────────

test('resolveCiFixStrategy — auto-deploy → pr, manual-deploy → push, explicit wins', () => {
  assert.equal(resolveCiFixStrategy({ deployment: { deployedOnPush: true } }), 'pr');
  assert.equal(resolveCiFixStrategy({ deployment: {} }), 'pr');            // deployedOnPush defaults truthy
  assert.equal(resolveCiFixStrategy({}), 'pr');
  assert.equal(resolveCiFixStrategy({ deployment: { deployedOnPush: false } }), 'push');
  assert.equal(resolveCiFixStrategy({ deployment: { deployedOnPush: true, ci_fix_strategy: 'push' } }), 'push');
  assert.equal(resolveCiFixStrategy({ deployment: { deployedOnPush: false, ci_fix_strategy: 'pr' } }), 'pr');
});

test('composeCiInvestigatePrompt — includes repo/run/result file + the no-commit guardrail', () => {
  const p = composeCiInvestigatePrompt({
    repo: 'owner/repo', workflow: 'ci.yml', runId: 12345, runTitle: 'build',
    logExcerpt: 'ERR: boom', resultFile: '/tmp/x.json',
  });
  assert.ok(p.includes('owner/repo'));
  assert.ok(p.includes('12345'));
  assert.ok(p.includes('/tmp/x.json'));
  assert.ok(p.includes('ERR: boom'));
  assert.ok(/DO NOT commit/i.test(p));
});

test('truncateTail — passes short strings, keeps the tail when over max', () => {
  assert.equal(truncateTail('hello', 100), 'hello');
  assert.equal(truncateTail('', 10), '');
  const t = truncateTail('x'.repeat(100) + 'TAIL', 10);
  assert.ok(t.endsWith('TAIL'));
  assert.ok(t.startsWith('…(truncated)…'));
});

// ─── ci-autofix toggle ────────────────────────────────────────────────────────

test('ci-autofix — defaults off, POST persists, GET reflects + writes a file', async () => {
  const projectRoot = makeTmpDir();
  try {
    const app = makeApp({ projectRoot, deployment: {} });
    assert.deepEqual((await req(app, 'GET', '/api/deployment/ci-autofix')).body, { enabled: false });
    assert.deepEqual((await req(app, 'POST', '/api/deployment/ci-autofix', { enabled: true })).body, { enabled: true });
    assert.deepEqual((await req(app, 'GET', '/api/deployment/ci-autofix')).body, { enabled: true });
    assert.ok(fs.existsSync(path.join(projectRoot, '.build-studio', 'ci-autofix.json')));
  } finally { cleanDir(projectRoot); }
});

// ─── guards (no gh / no network needed) ───────────────────────────────────────

test('ci-investigate — 409 on a dirty working tree, and no run is dispatched', async () => {
  const projectRoot = makeTmpDir();
  try {
    gitInit(projectRoot);
    fs.writeFileSync(path.join(projectRoot, 'dirty.txt'), 'x'); // untracked → dirty tree
    let called = 0;
    const runOneShotFn = () => { called++; return { runId: 'r', sessionName: 's' }; };
    const app = makeApp({ projectRoot, deployment: { repo: 'owner/repo' } }, { runOneShotFn });

    const r = await req(app, 'POST', '/api/deployment/ci-investigate', {});
    assert.equal(r.status, 409);
    assert.match(r.body.error, /uncommitted/i);
    assert.equal(called, 0, 'no investigation agent should be dispatched on a dirty tree');
  } finally { cleanDir(projectRoot); }
});

test('ci-investigate — 400 when deployment.repo is not set', async () => {
  const projectRoot = makeTmpDir();
  try {
    gitInit(projectRoot);
    const app = makeApp({ projectRoot, deployment: {} });
    const r = await req(app, 'POST', '/api/deployment/ci-investigate', {});
    assert.equal(r.status, 400);
    assert.match(r.body.error, /repo/i);
  } finally { cleanDir(projectRoot); }
});

test('ci-investigate — rejects a non-integer/negative runId (argument-injection guard)', async () => {
  const projectRoot = makeTmpDir();
  try {
    gitInit(projectRoot); // clean tree → passes the clean-tree guard, reaches runId validation
    let called = 0;
    const runOneShotFn = () => { called++; return { runId: 'r', sessionName: 's' }; };
    const app = makeApp({ projectRoot, deployment: { repo: 'owner/repo' } }, { runOneShotFn });

    for (const bad of ['--log-failed', 'abc', '-1', 0, -5]) {
      const r = await req(app, 'POST', '/api/deployment/ci-investigate', { runId: bad });
      assert.equal(r.status, 400, `runId ${JSON.stringify(bad)} should be rejected`);
      assert.match(r.body.error, /positive integer/i);
    }
    assert.equal(called, 0, 'no agent dispatched for an invalid runId');
  } finally { cleanDir(projectRoot); }
});

test('ci-fix-accept — 400 when there is nothing to accept (clean tree)', async () => {
  const projectRoot = makeTmpDir();
  try {
    gitInit(projectRoot);
    const app = makeApp({ projectRoot, deployment: {} });
    const r = await req(app, 'POST', '/api/deployment/ci-fix-accept', {});
    assert.equal(r.status, 400);
    assert.match(r.body.error, /No fix to accept/i);
  } finally { cleanDir(projectRoot); }
});

test('ci-investigate/:runId/status — 404 for an unknown run', async () => {
  const projectRoot = makeTmpDir();
  try {
    const app = makeApp({ projectRoot, deployment: {} }, { getOneShotStatusFn: () => null });
    const r = await req(app, 'GET', '/api/deployment/ci-investigate/nope/status');
    assert.equal(r.status, 404);
  } finally { cleanDir(projectRoot); }
});

// ─── multi-target deploy model (PRD-033 / ADR-024 D-5) ──────────────────────────

test('resolveDeployTargets — backward-compatible: no targets[] synthesizes one github-workflow target', () => {
  const targets = resolveDeployTargets({ deployment: { repo: 'o/r', ci_workflow: 'ci.yml', deployedOnPush: false } });
  assert.equal(targets.length, 1);
  assert.equal(targets[0].kind, 'github-workflow');
  assert.equal(targets[0].repo, 'o/r');
  assert.equal(targets[0].canDeploy, true); // dispatch click required → button shown
});

test('resolveDeployTargets — auto-on-push github target is NOT manually deployable (no redundant button)', () => {
  const [t] = resolveDeployTargets({ deployment: { repo: 'o/r', ci_workflow: 'ci.yml', deployedOnPush: true } });
  assert.equal(t.canDeploy, false);
});

test('resolveDeployTargets — explicit web + iOS targets (example-app shape)', () => {
  const targets = resolveDeployTargets({ deployment: { targets: [
    { id: 'web', label: 'Web', kind: 'github-workflow', repo: 'o/r', ci_workflow: 'deploy.yml', deployedOnPush: true },
    { id: 'ios', label: 'iOS', kind: 'local-command', command: 'bundle exec fastlane metadata_validate', cwd: 'ios' },
  ] } });
  assert.deepEqual(targets.map(t => t.id), ['web', 'ios']);
  assert.equal(targets[0].canDeploy, false);                 // web auto-on-push → no button
  assert.equal(targets[1].kind, 'local-command');
  assert.equal(targets[1].canDeploy, true);                  // local lane always triggerable
});

test('normalizeDeployTarget — a local-command without a command is not deployable', () => {
  assert.equal(normalizeDeployTarget({ id: 'x', kind: 'local-command' }, 0).canDeploy, false);
});

test('POST /deployment/deploy — local-command target runs the host command and returns output', async () => {
  const projectRoot = makeTmpDir();
  try {
    const app = makeApp({ projectRoot, deployment: { targets: [
      { id: 'ios', label: 'iOS', kind: 'local-command', command: 'echo DEPLOY_OK', cwd: '.' },
    ] } });
    const r = await req(app, 'POST', '/api/deployment/deploy', { targetId: 'ios' });
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.match(r.body.output, /DEPLOY_OK/);
  } finally { cleanDir(projectRoot); }
});

test('POST /deployment/deploy — failing local-command returns 500 with the error', async () => {
  const projectRoot = makeTmpDir();
  try {
    const app = makeApp({ projectRoot, deployment: { targets: [
      { id: 'ios', label: 'iOS', kind: 'local-command', command: 'exit 3', cwd: '.' },
    ] } });
    const r = await req(app, 'POST', '/api/deployment/deploy', { targetId: 'ios' });
    assert.equal(r.status, 500);
    assert.match(r.body.error, /iOS failed/);
  } finally { cleanDir(projectRoot); }
});

test('POST /deployment/deploy — unknown targetId → 400', async () => {
  const projectRoot = makeTmpDir();
  try {
    const app = makeApp({ projectRoot, deployment: { targets: [
      { id: 'ios', kind: 'local-command', command: 'echo hi' },
    ] } });
    const r = await req(app, 'POST', '/api/deployment/deploy', { targetId: 'nope' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Unknown deploy target/);
  } finally { cleanDir(projectRoot); }
});

test('POST /deployment/deploy — a non-deployable target (auto-on-push) → 400', async () => {
  const projectRoot = makeTmpDir();
  try {
    const app = makeApp({ projectRoot, deployment: { targets: [
      { id: 'web', kind: 'github-workflow', repo: 'o/r', ci_workflow: 'd.yml', deployedOnPush: true },
    ] } });
    const r = await req(app, 'POST', '/api/deployment/deploy', { targetId: 'web' });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not manually deployable/);
  } finally { cleanDir(projectRoot); }
});
