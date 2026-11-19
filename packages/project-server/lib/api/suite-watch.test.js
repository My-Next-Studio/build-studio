'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSuiteWatch } = require('./suite-watch');

const day = (n) => new Date(Date.UTC(2026, 10, n, 12)).toISOString();

function setup({ now = Date.parse(day(19)), reviewEvery = 2, gate = [], scorecard = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-api-'));
  fs.mkdirSync(path.join(root, '.build-studio'));
  fs.mkdirSync(path.join(root, 'tmp', 'ci-check'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp', 'ci-check', 'history.jsonl'), gate.map((g) => JSON.stringify(g)).join('\n'));
  fs.writeFileSync(path.join(root, '.build-studio', 'scorecard.jsonl'), scorecard.map((r) => JSON.stringify(r)).join('\n'));
  const config = {
    name: 'demo', projectRoot: root, statePath: path.join(root, '.build-studio'),
    suite_watch: { gate_history: 'tmp/ci-check/history.jsonl', test_paths: ['test'], review_every: reviewEvery },
  };
  let clock = now;
  const registry = new Map();
  const items = new Map();
  const started = [];
  const gitCalls = [];
  const sw = createSuiteWatch(config, {
    now: () => clock,
    storeFile: path.join(root, 'store.json'),
    git: (args) => {
      gitCalls.push(args.join(' '));
      if (args[0] === 'rev-parse') return 'a'.repeat(40) + '\n';
      if (args[0] === 'grep') return `${'a'.repeat(40)}:test/x.test.ts:120\n${'a'.repeat(40)}:test/y.test.ts:30\n`;
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
    runOneShot: (opts) => { started.push(opts); registry.set('os1', { state: 'running' }); return { runId: 'os1', sessionName: 'oneshot-suite-review-1' }; },
    getOneShotStatus: (id) => registry.get(id) || null,
    createItem: (_root, _docs, item) => { items.set('PHO-099', { ...item, status: 'Backlog' }); return { id: 'PHO-099' }; },
    readItem: (_root, _docs, id) => items.get(id) || null,
    scopedCommit: async () => ({ committed: true }),
  });
  return { root, config, sw, registry, items, started, gitCalls, setClock: (t) => { clock = t; } };
}

async function withServer(sw, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api', sw.router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try { await fn(call); } finally { server.close(); }
}

const gateRun = (n, tests) => ({ at: day(n), ok: true, head: `h${n}`, mode: 'pre-merge', steps: [{ name: 'vitest', seconds: 10, tests }] });

test('not configured', async () => {
  const { sw, config } = setup();
  delete config.suite_watch;
  await withServer(sw, async (call) => {
    assert.deepEqual((await call('GET', '/ops/suite')).body, { configured: false });
    assert.equal((await call('POST', '/ops/suite/review')).status, 400);
  });
});

test('test code is counted once per branch head', async () => {
  const { sw, gitCalls } = setup();
  await sw.tick();
  await sw.tick();
  assert.equal(gitCalls.filter((c) => c.startsWith('grep')).length, 1);
  const code = sw.snapshot().series.find((s) => s.key === 'code');
  assert.equal(code.metrics.lines.latest.value, 150);
  assert.deepEqual(code.byPath, { test: 150 });
});

test('growth: a notice, then Keep watching quiets it, then Accept restarts the baseline', async () => {
  const { sw } = setup({ gate: [gateRun(1, 4000), gateRun(2, 4010), gateRun(3, 4020), gateRun(4, 4600)] });
  await withServer(sw, async (call) => {
    let s = (await call('GET', '/ops/suite')).body;
    const tests = () => s.series.find((x) => x.key === 'gate:vitest').metrics.tests;
    assert.equal(tests().notice, true);
    assert.equal(sw.alerts().filter((a) => a.kind === 'suite-growth').length, 1);
    s = (await call('POST', '/ops/suite/watch', { key: 'gate:vitest', metric: 'tests' })).body;
    assert.equal(tests().notice, false);
    assert.equal(tests().state, 'over');
    s = (await call('POST', '/ops/suite/accept', { key: 'gate:vitest' })).body;
    assert.notEqual(tests().state, 'over');
    assert.equal((await call('POST', '/ops/suite/watch', { key: 'gate:vitest', metric: 'tests' })).status, 409);
    assert.equal((await call('POST', '/ops/suite/accept', { key: 'nope' })).status, 404);
  });
});

test('review: due after N stories since first seen; skip restarts the count', async () => {
  const ctx = setup({ now: Date.parse(day(10)), reviewEvery: 2 });
  ctx.sw.snapshot(); // first seen: the count starts here
  fs.writeFileSync(path.join(ctx.root, '.build-studio', 'scorecard.jsonl'), [
    { at: day(5), wfId: 'execution-0', type: 'execution', input: 'PHO-0' },
    { at: day(11), wfId: 'execution-1', type: 'execution', input: 'PHO-1' },
    { at: day(12), wfId: 'execution-2', type: 'execution', input: 'PHO-2' },
  ].map((r) => JSON.stringify(r)).join('\n'));
  await withServer(ctx.sw, async (call) => {
    const s = (await call('GET', '/ops/suite')).body;
    assert.deepEqual(s.review.stories.map((x) => x.item), ['PHO-1', 'PHO-2'], 'stories before it was first seen do not count');
    assert.equal(s.review.due, true);
    assert.equal(ctx.sw.alerts().filter((a) => a.kind === 'suite-review-due').length, 1);
    ctx.setClock(Date.parse(day(13)));
    const skipped = (await call('POST', '/ops/suite/review/skip')).body;
    assert.equal(skipped.review.due, false);
    assert.equal(skipped.review.stories.length, 0);
  });
});

test('review: agent → filed as a backlog Task → implemented restarts baselines and the count', async () => {
  const ctx = setup({ gate: [gateRun(1, 4000), gateRun(2, 4010), gateRun(3, 4020), gateRun(4, 4600)] });
  await withServer(ctx.sw, async (call) => {
    const r = await call('POST', '/ops/suite/review', { reason: 'growth', focus: 'vitest tests' });
    assert.equal(r.status, 200);
    assert.equal(r.body.review.pass.state, 'running');
    assert.match(ctx.started[0].prompt, /growth notice on vitest tests/);
    assert.match(ctx.started[0].prompt, /ANALYSIS ONLY/);
    assert.equal((await call('POST', '/ops/suite/review')).status, 409);

    // The agent writes its result; the next tick files it.
    const resultFile = r.body.review.pass.resultFile;
    fs.writeFileSync(resultFile, JSON.stringify({ title: 'Test suite: merge the i18n deck tests', summary: 'S', body: '## Why' }));
    ctx.registry.set('os1', { state: 'complete' });
    await ctx.sw.tick();
    let s = ctx.sw.snapshot();
    assert.equal(s.review.pass.state, 'filed');
    assert.equal(s.review.pass.itemId, 'PHO-099');
    assert.match(ctx.items.get('PHO-099').body, /started from a growth notice on vitest tests/);
    assert.equal(fs.existsSync(resultFile), false);
    assert.equal((await call('POST', '/ops/suite/review')).status, 409, 'one filed review at a time');

    // Its PRD merges.
    ctx.items.get('PHO-099').status = 'Implemented';
    ctx.setClock(Date.parse(day(20)));
    await ctx.sw.tick();
    s = ctx.sw.snapshot();
    assert.equal(s.review.pass.state, 'done');
    assert.equal(s.review.since, day(20).replace(/\.\d{3}Z$/, '.000Z'));
    assert.equal(s.series.find((x) => x.key === 'gate:vitest').metrics.tests.state, 'no-data', 'judged only from runs after the new baseline');
  });
});

test('review: lost when the server forgot the agent and no result exists', async () => {
  const ctx = setup();
  await withServer(ctx.sw, async (call) => {
    await call('POST', '/ops/suite/review');
    ctx.registry.clear();
    await ctx.sw.tick();
    assert.equal(ctx.sw.snapshot().review.pass.state, 'lost');
    // A lost review can be started again.
    assert.equal((await call('POST', '/ops/suite/review')).status, 200);
  });
});
