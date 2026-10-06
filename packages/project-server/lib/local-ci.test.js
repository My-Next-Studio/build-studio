'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { localCiConfig, interpret, freshness } = require('./local-ci');

const HEAD = 'abcdef1234567890';
const passed = (over = {}) => ({ state: 'passed', full: true, dirty: false, commit: HEAD, pid: 1, startedAt: '2026-10-06T10:00:00Z', steps: [], ...over });
const judge = (status, run = null, { statusAlive = false, runAlive = false } = {}) => interpret({ status, run, statusAlive, runAlive });

test('config: absent or incomplete means no button', () => {
  const root = '/p';
  assert.equal(localCiConfig({ projectRoot: root }), null);
  assert.equal(localCiConfig({ projectRoot: root, deployment: { repo: 'a/b' } }), null);
  assert.equal(localCiConfig({ projectRoot: root, deployment: { local_ci: { cmd: 'x' } } }), null, 'status is required');
  assert.equal(localCiConfig({ projectRoot: root, deployment: { local_ci: { cmd: 'x', status: '../out.json' } } }), null, 'must stay inside the project');
  assert.deepEqual(
    localCiConfig({ projectRoot: root, deployment: { local_ci: { cmd: ' npm run ci:local ', cwd: 'web', status: 'web/.ci-local/status.json' } } }),
    { cmd: 'npm run ci:local', cwd: path.join(root, 'web'), statusFile: path.join(root, 'web/.ci-local/status.json') },
  );
});

test('the badge is ✔ only for a full, clean, passed run of HEAD', () => {
  const badge = (s) => freshness({ status: s, verdict: judge(s), head: HEAD });
  assert.deepEqual(badge(passed()), { tone: 'ok', label: 'Local CI ✔ for abcdef1' });
  assert.match(badge(passed({ commit: 'ffff000' })).label, /not run for HEAD/);
  assert.equal(badge(passed({ dirty: true })).tone, 'warn');
  assert.match(badge(passed({ dirty: true })).label, /dirty tree/);
  assert.match(badge(passed({ full: false })).label, /partial run/);
  assert.match(badge(null).label, /not run/);
  const failed = { state: 'failed', pid: 1, steps: [{ label: 'gates: npm test', status: 'failed' }] };
  assert.deepEqual(badge(failed), { tone: 'warn', label: 'Local CI failed at gates: npm test' });
});

test('running with a dead pid is interrupted; with a live one, running', () => {
  const s = { state: 'running', pid: 99, startedAt: '2026-10-06T10:00:00Z', current: { index: 3, total: 16, label: 'x' } };
  assert.equal(judge(s, null, { statusAlive: false }).state, 'interrupted');
  assert.equal(judge(s, null, { statusAlive: true }).state, 'running');
  assert.match(freshness({ status: s, verdict: judge(s, null, { statusAlive: true }), head: HEAD }).label, /step 3 of 16/);
});

test("a cancel Build Studio sent reads as cancelled, even when the runner wrote failed", () => {
  const run = { pid: 5, startedAt: '2026-10-06T10:00:00Z', cancelRequestedAt: '2026-10-06T10:05:00Z' };
  const s = { state: 'failed', pid: 6, startedAt: '2026-10-06T10:00:01Z', steps: [{ label: 'a', status: 'failed' }] };
  assert.equal(judge(s, run).state, 'cancelled');
});

test('a run that died before writing status is failed, not the previous result', () => {
  const run = { pid: 5, startedAt: '2026-10-06T11:00:00Z', exitCode: 127 };
  const old = passed({ startedAt: '2026-10-06T09:00:00Z' });
  const v = judge(old, run);
  assert.equal(v.state, 'failed');
  assert.equal(v.statusIsCurrent, false, 'the old status is not shown as this run');
  assert.equal(judge(old, run, { runAlive: true }).state, 'starting');
});
