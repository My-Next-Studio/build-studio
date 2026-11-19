'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createNightly, workflowBusy } = require('./nightly');

const DEAD_PID = 2 ** 22 - 3; // above macOS/Linux pid ranges in practice: never alive

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-api-'));
  fs.mkdirSync(path.join(root, '.build-studio'));
  return root;
}

function writeRun(root, id, summary) {
  const dir = path.join(root, 'tmp', 'nightly-e2e', 'runs', id);
  fs.mkdirSync(dir, { recursive: true });
  if (summary) fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(summary));
  fs.writeFileSync(path.join(dir, 'run.log'), 'line 1\nline 2\n');
}

function setup({ now = Date.now(), wf = null, git = {}, oneshot } = {}) {
  const root = makeProject();
  const config = { name: 'demo', projectRoot: root, logsPath: path.join(root, 'tmp', '.logs'), nightly: { cmd: 'echo run', status_dir: 'tmp/nightly-e2e', label: 'E2E' } };
  let local = {};
  const spawned = [];
  const spawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.pid = DEAD_PID;
    child.unref = () => {};
    return child;
  };
  const gitAnswers = { 'rev-parse --abbrev-ref HEAD': 'main', ...git };
  const n = createNightly(config, {
    state: { loadWorkflow: () => wf },
    spawn,
    git: (args) => {
      const key = args.join(' ');
      const hit = Object.keys(gitAnswers).find((k) => key.startsWith(k));
      if (!hit) throw new Error(`unexpected git ${key}`);
      return gitAnswers[hit];
    },
    loadLocal: () => local,
    saveLocal: (patch) => { local = { ...local, ...patch }; return local; },
    now: () => now,
    ...(oneshot || {}),
  });
  return { root, config, n, spawned, setNow: (t) => { now = t; } };
}

async function withServer(n, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api', n.router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try { await fn(call); } finally { server.close(); }
}

test('not configured: the tab says so and actions refuse', async () => {
  const { n, config } = setup();
  delete config.nightly;
  await withServer(n, async (call) => {
    assert.deepEqual((await call('GET', '/ops/nightly')).body, { configured: false });
    assert.equal((await call('POST', '/ops/nightly/run')).status, 400);
  });
});

test('turning it on counts from now: no run for a slot that already passed today', async () => {
  const at10 = new Date(2026, 10, 19, 10, 0).getTime();
  const { n, spawned, setNow } = setup({ now: at10, git: { 'rev-parse --verify': 'f'.repeat(40) } });
  await withServer(n, async (call) => {
    const r = await call('POST', '/ops/nightly/schedule', { enabled: true, at: '03:30' });
    assert.equal(r.status, 200);
    assert.equal(r.body.schedule.enabled, true);
    assert.equal(r.body.schedule.nextAt, new Date(2026, 10, 20, 3, 30).toISOString());
    assert.equal(n.tick().action, 'none');
    assert.equal(spawned.length, 0);
    // Tomorrow 03:31 it is due and starts.
    setNow(new Date(2026, 10, 20, 3, 31).getTime());
    assert.equal(n.tick().action, 'start');
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].args.slice(0, 1), ['-lc']);
    assert.match(spawned[0].args[1], /&& echo run$/);
    assert.equal(spawned[0].opts.detached, true);
    // Dealt with: the next tick does nothing.
    assert.equal(n.tick().action, 'none');
    const after = await call('GET', '/ops/nightly');
    assert.equal(after.body.schedule.lastDecision.action, 'start');
    assert.equal(after.body.current.state, 'starting');
  });
});

test('a bad time is refused', async () => {
  const { n } = setup();
  await withServer(n, async (call) => {
    assert.equal((await call('POST', '/ops/nightly/schedule', { enabled: true, at: '3:30' })).status, 400);
  });
});

test('unchanged branch: the day is skipped, and the reason is shown', async () => {
  const { n, root, setNow } = setup({ now: new Date(2026, 10, 19, 10, 0).getTime(), git: { 'rev-parse --verify': `5a7d8fa${'0'.repeat(33)}` } });
  writeRun(root, '2026-11-19T02-30-04-105Z', { head: '5a7d8fa', branch: 'main', passed: 3, failed: 0, flaky: 0, failures: [], flakes: [] });
  await withServer(n, async (call) => {
    await call('POST', '/ops/nightly/schedule', { enabled: true, at: '03:30' });
    setNow(new Date(2026, 10, 20, 3, 31).getTime());
    assert.equal(n.tick().action, 'skip');
    const r = await call('GET', '/ops/nightly');
    assert.match(r.body.schedule.lastDecision.reason, /unchanged/);
  });
});

test('a workflow at work holds the run until it is not', async () => {
  const wf = { itemId: 'PHO-1', currentStep: 'task_execution', steps: { task_execution: { status: 'running', agents: [{ role: 'Dev', status: 'running' }] } } };
  const ctx = setup({ now: new Date(2026, 10, 19, 10, 0).getTime(), wf, git: { 'rev-parse --verify': 'f'.repeat(40) } });
  await withServer(ctx.n, async (call) => {
    await call('POST', '/ops/nightly/schedule', { enabled: true, at: '03:30' });
    ctx.setNow(new Date(2026, 10, 20, 3, 31).getTime());
    const d = ctx.n.tick();
    assert.equal(d.action, 'wait');
    assert.match(d.reason, /PHO-1/);
    assert.equal(ctx.spawned.length, 0);
  });
});

test('workflowBusy: an idle or finished workflow is no reason to wait', () => {
  assert.equal(workflowBusy(null), null);
  assert.equal(workflowBusy({ currentStep: 'completed' }), null);
  assert.equal(workflowBusy({ itemId: 'X', currentStep: 'demo_review', steps: { demo_review: { status: 'waiting' } } }), null);
  assert.match(workflowBusy({ itemId: 'X', currentStep: 'merge_to_main', steps: { merge_to_main: { status: 'running' } } }), /X is in merge_to_main/);
});

test('Run now starts once; a second press while it starts is refused', async () => {
  const { n, spawned } = setup();
  await withServer(n, async (call) => {
    assert.equal((await call('POST', '/ops/nightly/run')).status, 200);
    const again = await call('POST', '/ops/nightly/run');
    assert.equal(again.status, 409);
    assert.equal(spawned.length, 1);
  });
});

test('a live runner lock refuses Run now', async () => {
  const { n, root } = setup();
  fs.mkdirSync(path.join(root, 'tmp', 'nightly-e2e'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp', 'nightly-e2e', 'run.lock'), String(process.pid));
  await withServer(n, async (call) => {
    const r = await call('POST', '/ops/nightly/run');
    assert.equal(r.status, 409);
    assert.match(r.body.error, new RegExp(String(process.pid)));
  });
});

test('run log: only a real run directory is read', async () => {
  const { n, root } = setup();
  writeRun(root, '2026-11-19T02-30-04-105Z', { head: 'a', passed: 1, failed: 0, flaky: 0 });
  await withServer(n, async (call) => {
    assert.equal((await call('GET', '/ops/nightly/runs/2026-11-19T02-30-04-105Z/log')).body.tail, 'line 1\nline 2');
    assert.equal((await call('GET', '/ops/nightly/runs/..%2F..%2Fetc/log')).status, 404);
    assert.equal((await call('GET', '/ops/nightly/runs/2026-11-20T02-30-04-105Z/log')).status, 404);
  });
});

test('brief and alerts follow the latest finished run', async () => {
  const { n, root } = setup();
  writeRun(root, '2026-11-18T02-30-00-000Z', { head: 'a', passed: 3, failed: 0, flaky: 0 });
  writeRun(root, '2026-11-19T02-30-00-000Z', { head: 'b', passed: 2, failed: 1, flaky: 0, failures: ['x.spec.ts:1 › chromium › t'] });
  await withServer(n, async (call) => {
    assert.deepEqual((await call('GET', '/ops/nightly/brief')).body, { configured: true, red: true, running: false });
  });
  const [alert] = n.alerts();
  assert.equal(alert.title, 'E2E run failed');
  assert.equal(alert.detail, '1 failed, 2 passed');
});

test('investigate: starts an agent with the run in its prompt, then shows its diagnosis', async () => {
  const started = [];
  const registry = new Map();
  const oneshot = {
    runOneShot: (opts) => { started.push(opts); registry.set('os1', { state: 'running' }); return { runId: 'os1', sessionName: 'oneshot-nightly-investigate-1' }; },
    getOneShotStatus: (id) => registry.get(id) || null,
  };
  const { n, root } = setup({ oneshot });
  const id = '2026-11-19T02-30-00-000Z';
  writeRun(root, id, { head: 'b', branch: 'main', passed: 2, failed: 1, flaky: 0, failures: ['x.spec.ts:1 › chromium › t'], flakes: [] });
  writeRun(root, '2026-11-18T02-30-00-000Z', { head: 'a', passed: 3, failed: 0, flaky: 0 });
  await withServer(n, async (call) => {
    assert.equal((await call('POST', '/ops/nightly/runs/2026-11-18T02-30-00-000Z/investigate')).status, 400, 'a green run has nothing to investigate');
    const r = await call('POST', `/ops/nightly/runs/${id}/investigate`);
    assert.equal(r.status, 200);
    assert.match(started[0].prompt, /x\.spec\.ts:1 › chromium › t/);
    assert.match(started[0].prompt, /Do not edit tracked files/);
    assert.equal((await call('POST', `/ops/nightly/runs/${id}/investigate`)).status, 409);
    assert.equal((await call('GET', `/ops/nightly/runs/${id}/investigation`)).body.state, 'running');
    // The agent writes its result and ends.
    const resultFile = /Markdown to (\S+) /.exec(started[0].prompt)[1];
    fs.writeFileSync(resultFile, '## Diagnosis\nTest bug.');
    registry.set('os1', { state: 'complete' });
    const done = await call('GET', `/ops/nightly/runs/${id}/investigation`);
    assert.equal(done.body.state, 'complete');
    assert.match(done.body.markdown, /Test bug/);
    // Forgotten by a restarted server, with no result: lost, not a spinner.
    fs.unlinkSync(resultFile);
    registry.clear();
    assert.equal((await call('GET', `/ops/nightly/runs/${id}/investigation`)).body.state, 'lost');
  });
});
