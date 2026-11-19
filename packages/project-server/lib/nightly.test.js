'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nl = require('./nightly');

const root = '/tmp/proj';
const base = { projectRoot: root, nightly: { cmd: 'npm run e2e:nightly', status_dir: 'tmp/nightly-e2e' } };

function run(id, summary) {
  return { id, startedAt: nl.runIdToIso(id), summary, outcome: nl.outcome(summary) };
}
const green = (head, extra = {}) => ({ head, branch: 'main', passed: 10, failed: 0, flaky: 0, failures: [], flakes: [], ...extra });

test('config: cmd and status_dir are required; the rest has defaults', () => {
  assert.equal(nl.nightlyConfig({ projectRoot: root }), null);
  assert.equal(nl.nightlyConfig({ projectRoot: root, nightly: { cmd: 'x' } }), null);
  const s = nl.nightlyConfig(base);
  assert.equal(s.statusDir, '/tmp/proj/tmp/nightly-e2e');
  assert.equal(s.branch, 'main');
  assert.equal(s.label, 'Nightly');
  assert.equal(s.enabled, false);
  assert.equal(s.at, '03:30');
});

test('config: the time chosen on this machine wins over the yaml default', () => {
  const cfg = { ...base, nightly: { ...base.nightly, at: '02:00' } };
  assert.equal(nl.nightlyConfig(cfg).at, '02:00');
  const s = nl.nightlyConfig(cfg, { nightly: { enabled: true, at: '04:15' } });
  assert.equal(s.enabled, true);
  assert.equal(s.at, '04:15');
  assert.equal(nl.nightlyConfig(cfg, { nightly: { enabled: true, at: '25:00' } }).at, '02:00');
});

test('config: a status_dir outside the project is refused', () => {
  assert.equal(nl.nightlyConfig({ projectRoot: root, nightly: { cmd: 'x', status_dir: '../elsewhere' } }), null);
});

test('outcome: error, then failed, then flaky, then passed', () => {
  assert.equal(nl.outcome({ error: 'Docker down' }), 'error');
  assert.equal(nl.outcome({ failed: 1, flaky: 3 }), 'failed');
  assert.equal(nl.outcome({ failed: 0, flaky: 1 }), 'flaky');
  assert.equal(nl.outcome({ passed: 3, failed: 0, flaky: 0 }), 'passed');
  assert.equal(nl.outcome({ passed: 0, failed: 0, flaky: 0 }), 'empty');
  assert.equal(nl.outcome(null), null);
});

test('readRuns: newest first, an unfinished run kept with no summary, junk ignored', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-'));
  const mk = (id, summary) => {
    fs.mkdirSync(path.join(dir, 'runs', id), { recursive: true });
    if (summary) fs.writeFileSync(path.join(dir, 'runs', id, 'summary.json'), JSON.stringify(summary));
  };
  mk('2026-11-18T02-30-00-000Z', green('aaaaaaa'));
  mk('2026-11-19T02-30-00-000Z', null);
  mk('not-a-run', green('bbbbbbb'));
  const runs = nl.readRuns(dir);
  assert.deepEqual(runs.map((r) => r.id), ['2026-11-19T02-30-00-000Z', '2026-11-18T02-30-00-000Z']);
  assert.equal(runs[0].summary, null);
  assert.equal(runs[0].startedAt, '2026-11-19T02:30:00.000Z');
  assert.equal(runs[1].outcome, 'passed');
  assert.deepEqual(nl.readRuns(path.join(dir, 'absent')), []);
});

test('recurring: the same test across runs, with its line number moved, is one test', () => {
  const runs = [
    run('2026-11-19T02-30-00-000Z', green('c', { failed: 1, failures: ['feed.spec.ts:431 › chromium › opens a photo'], flakes: ['a.spec.ts:1 › chromium › once'] })),
    run('2026-11-18T02-30-00-000Z', green('b', { flaky: 1, flakes: ['feed.spec.ts:428 › chromium › opens a photo'] })),
    run('2026-11-17T02-30-00-000Z', { error: 'Docker down' }),
  ];
  const r = nl.recurring(runs);
  assert.equal(r.length, 1);
  assert.equal(r[0].test, 'feed.spec.ts:431 › chromium › opens a photo');
  assert.equal(r[0].failed, 1);
  assert.equal(r[0].flaky, 1);
  assert.equal(r[0].runs, 2, 'a run that could not run is not counted');
});

test('slots: the latest and next local occurrences of a time', () => {
  const now = new Date(2026, 10, 19, 10, 0).getTime();
  assert.equal(nl.latestSlot(now, '03:30'), new Date(2026, 10, 19, 3, 30).getTime());
  assert.equal(nl.latestSlot(now, '22:00'), new Date(2026, 10, 18, 22, 0).getTime());
  assert.equal(nl.nextSlot(now, '03:30'), new Date(2026, 10, 20, 3, 30).getTime());
});

test('sameCommit: an abbreviated sha matches its full form, and nothing shorter than 7', () => {
  assert.ok(nl.sameCommit('5a7d8fa', '5a7d8fa1234567890'));
  assert.ok(!nl.sameCommit('5a7d8fb', '5a7d8fa1234567890'));
  assert.ok(!nl.sameCommit('5a7', '5a7d8fa'));
  assert.ok(!nl.sameCommit(null, '5a7d8fa'));
});

// ── decide ──────────────────────────────────────────────────────────────────

const NOW = new Date(2026, 10, 19, 3, 31).getTime();
const SLOT = new Date(2026, 10, 19, 3, 30).getTime();
const YESTERDAY = new Date(2026, 10, 18, 3, 30).getTime();
const settings = { ...nl.nightlyConfig(base), enabled: true, at: '03:30' };
const idle = { state: 'idle' };
const due = (over = {}) => nl.decide({
  settings, schedulerState: { handledSlot: YESTERDAY }, now: NOW, current: idle,
  workflowBusy: null, checkoutBranch: 'main', branchHead: 'ffffffffffffffff',
  runs: [run('2026-11-18T02-30-00-000Z', green('aaaaaaa'))], ...over,
});

test('decide: off, or already dealt with today, is nothing', () => {
  assert.equal(due({ settings: { ...settings, enabled: false } }).action, 'none');
  assert.equal(due({ schedulerState: { handledSlot: SLOT } }).action, 'none');
});

test('decide: no record of a handled slot never runs — the schedule is seeded first', () => {
  assert.equal(due({ schedulerState: {} }).action, 'none');
});

test('decide: due, with new commits on the branch, starts', () => {
  assert.deepEqual(due(), { action: 'start', slot: SLOT });
});

test('decide: a missed slot is caught up later the same day', () => {
  assert.equal(due({ now: new Date(2026, 10, 19, 14, 0).getTime() }).action, 'start');
});

test('decide: the branch unchanged since the last answer skips the day', () => {
  const d = due({ branchHead: 'aaaaaaa1111111' });
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /main unchanged since the last run \(aaaaaaa\)/);
});

test('decide: a run that could not be carried out is not an answer — it runs again', () => {
  const runs = [run('2026-11-18T02-30-00-000Z', { head: 'aaaaaaa', branch: 'main', error: 'Docker did not start' })];
  assert.equal(due({ runs, branchHead: 'aaaaaaa1111111' }).action, 'start');
});

test('decide: a run in which no test ran is not an answer either', () => {
  const runs = [run('2026-11-18T02-30-00-000Z', green('aaaaaaa', { passed: 0 }))];
  assert.equal(due({ runs, branchHead: 'aaaaaaa1111111' }).action, 'start');
});

test('decide: a red result on unchanged code is still an answer — it is not re-run', () => {
  const runs = [run('2026-11-18T02-30-00-000Z', green('aaaaaaa', { failed: 2 }))];
  assert.equal(due({ runs, branchHead: 'aaaaaaa1111111' }).action, 'skip');
});

test('decide: a run on another branch is not the answer for this one', () => {
  const runs = [run('2026-11-18T02-30-00-000Z', green('aaaaaaa', { branch: 'exec/X-1' }))];
  assert.equal(due({ runs, branchHead: 'aaaaaaa1111111' }).action, 'start');
});

test('decide: waits while a workflow is at work, or the checkout is elsewhere', () => {
  const busy = due({ workflowBusy: 'PHO-023 has an agent at work' });
  assert.equal(busy.action, 'wait');
  assert.match(busy.reason, /PHO-023/);
  const elsewhere = due({ checkoutBranch: 'exec/PHO-023' });
  assert.equal(elsewhere.action, 'wait');
  assert.match(elsewhere.reason, /checkout is on exec\/PHO-023, not main/);
});

test('decide: a run already going (started by hand) takes the slot', () => {
  assert.equal(due({ current: { state: 'running' } }).action, 'skip');
});

// ── currentState ────────────────────────────────────────────────────────────

test('currentState: the lock or our process alive is running', () => {
  const s = nl.currentState({ lock: { pid: 5, alive: true }, record: null, recordAlive: false, newestRun: run('2026-11-19T02-30-00-000Z', null), now: NOW });
  assert.equal(s.state, 'running');
  assert.equal(s.startedAt, '2026-11-19T02:30:00.000Z');
  assert.equal(nl.currentState({ lock: { pid: 5, alive: false }, record: null, recordAlive: false, newestRun: null, now: NOW }).state, 'idle');
});

test('currentState: just started and not yet visible is starting; finished already is idle', () => {
  const record = { startedAt: new Date(NOW - 5000).toISOString() };
  assert.equal(nl.currentState({ lock: null, record, recordAlive: false, newestRun: null, now: NOW }).state, 'starting');
  const after = run(new Date(NOW - 3000).toISOString().replace(/[:.]/g, '-'), green('a'));
  assert.equal(nl.currentState({ lock: null, record, recordAlive: false, newestRun: after, now: NOW }).state, 'idle');
  assert.equal(nl.currentState({ lock: null, record: { startedAt: new Date(NOW - 10 * 60000).toISOString() }, recordAlive: false, newestRun: null, now: NOW }).state, 'idle');
});

// ── failureAlert ────────────────────────────────────────────────────────────

test('failureAlert: red raises one, twice in a row raises it high, green or flaky clears it', () => {
  const opts = { project: 'p', label: 'E2E' };
  const red = run('2026-11-19T02-30-00-000Z', green('b', { failed: 2 }));
  const err = run('2026-11-18T02-30-00-000Z', { error: 'Docker did not start' });
  const ok = run('2026-11-17T02-30-00-000Z', green('a'));
  const one = nl.failureAlert([red, ok], opts);
  assert.equal(one.severity, 'moderate');
  assert.equal(one.id, 'nightly:p');
  assert.deepEqual(one.open, { fn: 'operations', tab: 'tests', label: 'Tests' });
  assert.equal(nl.failureAlert([red, err, ok], opts).severity, 'high');
  assert.equal(nl.failureAlert([ok, red], opts), null);
  assert.equal(nl.failureAlert([run('2026-11-19T02-30-00-000Z', green('b', { flaky: 2 }))], opts), null);
  // A run still going does not hide the last finished one.
  assert.equal(nl.failureAlert([run('2026-11-20T02-30-00-000Z', null), red], opts).severity, 'moderate');
});
