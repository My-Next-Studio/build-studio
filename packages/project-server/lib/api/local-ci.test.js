'use strict';

// The router against a real process: a fake runner that writes the status file
// the way the real one does and runs each step in a BLOCKING spawnSync, which
// is what makes cancel hard (a signal to the runner alone waits for the step).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLocalCiRouter } = require('./local-ci');

const RUNNER = `
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const file = path.resolve('.ci-local/status.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
const steps = (process.env.STEPS || 'a:0,b:0').split(',').map(s => { const [label, sec] = s.split(':'); return { label, sec }; });
const status = { state: 'running', full: true, commit: 'x', dirty: false, pid: process.pid,
  startedAt: new Date().toISOString(), finishedAt: null, current: null,
  steps: steps.map(s => ({ label: s.label, status: 'pending', seconds: null })) };
const save = () => { status.updatedAt = new Date().toISOString(); fs.writeFileSync(file + '.tmp', JSON.stringify(status)); fs.renameSync(file + '.tmp', file); };
const finish = st => { status.state = st; status.finishedAt = new Date().toISOString(); save(); };
process.on('SIGTERM', () => { finish('cancelled'); process.exit(130); });
save();
steps.forEach((s, i) => {
  status.current = { index: i + 1, total: steps.length, label: s.label }; status.steps[i].status = 'running'; save();
  console.log('step ' + s.label);
  const r = spawnSync('sleep', [s.sec]);
  status.steps[i].status = r.status === 0 ? 'passed' : 'failed'; status.steps[i].seconds = Number(s.sec);
  if (r.status !== 0) { finish('failed'); process.exit(1); }
  save();
});
finish('passed');
`;

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-ci-test-'));
  fs.mkdirSync(path.join(root, 'web'));
  fs.writeFileSync(path.join(root, 'web', 'runner.js'), RUNNER);
  return root;
}

async function withServer(root, steps, fn) {
  const config = {
    projectRoot: root, logsPath: path.join(root, 'tmp', '.logs'),
    deployment: { local_ci: { cmd: `STEPS=${steps} ${JSON.stringify(process.execPath)} runner.js`, cwd: 'web', status: 'web/.ci-local/status.json' } },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createLocalCiRouter(config));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/api/deployment/local-ci`;
  const call = async (sub = '', method = 'GET') => {
    const res = await fetch(base + sub, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
    return { status: res.status, body: await res.json() };
  };
  try { return await fn(call, config); } finally { server.close(); }
}

const until = async (cond, ms = 10000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await cond();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
};

test('no local_ci block: not configured, and start is refused', async () => {
  const app = express();
  app.use('/api', createLocalCiRouter({ projectRoot: os.tmpdir(), deployment: { repo: 'a/b' } }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/deployment/local-ci`;
    assert.deepEqual(await (await fetch(base)).json(), { configured: false });
    assert.equal((await fetch(`${base}/start`, { method: 'POST' })).status, 400);
  } finally { server.close(); }
});

test('a run goes from running to passed, logging its output', async () => {
  const root = makeProject();
  await withServer(root, 'a:0,b:0', async (call) => {
    const start = await call('/start', 'POST');
    assert.equal(start.status, 200);
    const done = await until(async () => { const r = await call(); return r.body.verdict.state === 'passed' && r.body; });
    assert.equal(done.status.steps.length, 2);
    assert.match(done.logTail, /step a\nstep b/);
    assert.equal(done.canCancel, false);
  });
});

test('one run at a time, and cancel stops a blocking step and reads as cancelled', async () => {
  const root = makeProject();
  await withServer(root, 'slow:30,never:0', async (call) => {
    assert.equal((await call('/start', 'POST')).status, 200);
    await until(async () => (await call()).body.verdict.state === 'running');
    assert.equal((await call('/start', 'POST')).status, 409, 'a second run is refused');

    const t = Date.now();
    const c = await call('/cancel', 'POST');
    assert.equal(c.status, 200);
    const after = await until(async () => { const r = await call(); return r.body.verdict.state === 'cancelled' && r.body; });
    assert.ok(Date.now() - t < 8000, 'the 30-second step did not have to finish first');
    assert.equal(after.canCancel, false);
    assert.equal(after.status.steps[1].status, 'pending', 'the next step never started');
  });
});

test('a status left running by a dead process reads as interrupted', async () => {
  const root = makeProject();
  fs.mkdirSync(path.join(root, 'web', '.ci-local'), { recursive: true });
  fs.writeFileSync(path.join(root, 'web', '.ci-local', 'status.json'), JSON.stringify({
    state: 'running', pid: 2147483646, startedAt: '2026-10-06T10:00:00Z', current: { index: 4, total: 16, label: 'gates: x' }, steps: [],
  }));
  await withServer(root, 'a:0', async (call) => {
    const r = await call();
    assert.equal(r.body.verdict.state, 'interrupted');
    assert.equal(r.body.badge.tone, 'warn');
    assert.equal(r.body.canCancel, false, 'nothing of ours to cancel');
    assert.equal((await call('/cancel', 'POST')).status, 409);
  });
});

test('a command that dies before writing status is failed, with its log', async () => {
  const root = makeProject();
  const config = {
    projectRoot: root, logsPath: path.join(root, 'tmp', '.logs'),
    deployment: { local_ci: { cmd: 'echo boom >&2; exit 3', cwd: 'web', status: 'web/.ci-local/status.json' } },
  };
  const app = express();
  app.use('/api', createLocalCiRouter(config));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/deployment/local-ci`;
    await fetch(`${base}/start`, { method: 'POST' });
    const r = await until(async () => { const b = await (await fetch(base)).json(); return b.verdict.state === 'failed' && b; });
    assert.equal(r.verdict.beforeStatus, true);
    assert.match(r.logTail, /boom/);
  } finally { server.close(); }
});
