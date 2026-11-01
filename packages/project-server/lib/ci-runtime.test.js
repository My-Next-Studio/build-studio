'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  runnerSeconds, stepSeconds, median, evaluateBudget, applyWatch, needsNotice,
  storePath, readStore, writeStore, KEEP_RUNS, createCiRuntime,
} = require('./ci-runtime');

const at = (min) => new Date(Date.UTC(2026, 9, 1) + min * 60000).toISOString();
const job = (name, startMin, endMin, extra = {}) => ({ name, startedAt: at(startMin), completedAt: at(endMin), conclusion: 'success', ...extra });

/** A series of runs, one a day, with the given runner minutes. */
function series(minutes, { from = 0, steps } = {}) {
  return minutes.map((m, i) => ({
    id: from + i + 1,
    createdAt: at((from + i) * 1440),
    seconds: m * 60,
    steps: steps ? steps(i, m) : {},
  }));
}

// ── timings ──────────────────────────────────────────────────────────────────

test('runner time is the sum of job durations, not the wall clock', () => {
  // Two jobs in parallel for 10 minutes: 10 min of wall clock, 20 of runner time.
  assert.equal(runnerSeconds([job('a', 0, 10), job('b', 0, 10)]), 1200);
});

test('skipped jobs count nothing, even when GitHub reports them ending before they start', () => {
  const skipped = { name: 'preview', startedAt: at(5), completedAt: at(4), conclusion: 'skipped' };
  assert.equal(runnerSeconds([job('a', 0, 3), skipped]), 180);
});

test('step timings are keyed by job and step, so a notice can name what grew', () => {
  const j = job('gates', 0, 30, { steps: [
    { name: 'Lighthouse', startedAt: at(0), completedAt: at(20) },
    { name: 'Set up job', startedAt: at(20), completedAt: at(20) },
  ] });
  assert.deepEqual(stepSeconds([j]), { 'gates › Lighthouse': 1200 });
});

test('median of an even count is the mean of the middle two', () => {
  assert.equal(median([4, 1, 3, 2]), 3);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([]), null);
});

// ── the budget ───────────────────────────────────────────────────────────────

test('within 10% of the median is fine', () => {
  const r = evaluateBudget(series([100, 100, 102, 98, 109]), null);
  assert.equal(r.state, 'ok');
  assert.equal(r.flag, null);
});

test('more than 10% over the median of the runs before it is over budget', () => {
  const r = evaluateBudget(series([100, 100, 100, 100, 115]), null);
  assert.equal(r.state, 'over');
  assert.equal(r.flag.baselineSeconds, 6000);
  assert.equal(r.flag.latestSeconds, 6900);
  assert.equal(r.flag.overPct, 15);
  assert.equal(r.flag.since.id, 5);
});

test('quiet until three runs precede the one judged', () => {
  assert.equal(evaluateBudget(series([100, 100, 150]), null).state, 'quiet');
  assert.equal(evaluateBudget(series([100, 100, 100, 150]), null).state, 'over');
});

test('small workflows are not flagged for seconds of growth', () => {
  // 40 s → 60 s is 50% over and costs nothing.
  const runs = [40, 40, 40, 60].map((s, i) => ({ id: i + 1, createdAt: at(i * 1440), seconds: s }));
  assert.equal(evaluateBudget(runs, null).state, 'ok');
});

// The reason the flag keeps its baseline: a suite that grew and stayed grown
// would otherwise lose its notice once the rolling median caught up.
test('a suite that grew and stayed grown stays flagged against the old baseline', () => {
  const r = evaluateBudget(series([100, 100, 100, 100, 130, 130, 130, 130, 130, 130, 130, 130]), null);
  assert.equal(r.medianSeconds, 130 * 60, 'the rolling median has caught up');
  assert.equal(r.state, 'over');
  assert.equal(r.flag.baselineSeconds, 6000);
  assert.equal(r.flag.since.id, 5);
});

test('one slow run that recovers clears itself', () => {
  const r = evaluateBudget(series([100, 100, 100, 100, 130, 101]), null);
  assert.equal(r.state, 'ok');
  assert.equal(r.flag, null);
});

test('gradual drift is caught once it adds up', () => {
  // 3% a run: no single run is a jump, the median lags behind.
  const mins = Array.from({ length: 15 }, (_, i) => Math.round(100 * 1.03 ** i));
  assert.equal(evaluateBudget(series(mins), null).state, 'over');
});

test('runs before the marker do not count', () => {
  const runs = series([100, 100, 100, 100, 130, 130, 130, 131]);
  const marker = { at: runs[4].createdAt, reason: 'accepted' };
  const r = evaluateBudget(runs, marker);
  assert.equal(r.state, 'ok');
  assert.equal(r.runs, 4);
});

test('after a marker the check is quiet again until three runs precede the judged one', () => {
  const runs = series([100, 100, 100, 100, 60, 61]);
  assert.equal(evaluateBudget(runs, { at: runs[4].createdAt }).state, 'quiet');
});

// After a maintenance pass the old, slower runs would hide regrowth: here the
// suite shrinks to 60 and grows back to 80, which is 33% over the new size but
// under the old median.
test('without a marker, regrowth after a shrink would hide behind the old median', () => {
  const runs = series([100, 100, 100, 100, 60, 60, 60, 60, 80]);
  assert.equal(evaluateBudget(runs, null).state, 'ok');
  assert.equal(evaluateBudget(runs, { at: runs[4].createdAt }).state, 'over');
});

test('the notice names the steps that grew most', () => {
  const runs = series([100, 100, 100, 100, 130], {
    steps: (i) => ({
      'gates › Lighthouse': i === 4 ? 2400 : 600,
      'gates › npm test': i === 4 ? 1500 : 1200,
      'gates › lint': 60,
    }),
  });
  const r = evaluateBudget(runs, null);
  assert.deepEqual(r.flag.grownSteps.map((s) => [s.step, s.deltaSeconds]), [
    ['gates › Lighthouse', 1800],
    ['gates › npm test', 300],
  ]);
});

test('a renamed job is compared with its steps under the old name, not reported as new', () => {
  // launch-studio: "Build native · Unit · Electron smoke" became "Unit · Electron smoke".
  const runs = series([10, 10, 10, 10, 14], {
    steps: (i) => (i === 4
      ? { 'Unit › Run npm run test:e2e': 420, 'Unit › Run npm run lint': 120, 'Lint › Run npm ci': 60 }
      : { 'Build › Run npm run test:e2e': 360, 'Build › Run npm ci': 30, 'Lint › Run npm ci': 60 }),
  });
  const r = evaluateBudget(runs, null);
  assert.deepEqual(r.flag.grownSteps.map((s) => [s.step, s.beforeSeconds, s.nowSeconds]), [
    ['Unit › Run npm run lint', 0, 120], // genuinely new under the old job too
    ['Unit › Run npm run test:e2e', 360, 420],
  ]);
});

test('a new step in a job that already existed starts from zero', () => {
  const runs = series([10, 10, 10, 10, 14], {
    steps: (i) => (i === 4 ? { 'gates › npm test': 600, 'gates › a11y': 240 } : { 'gates › npm test': 600, 'other › a11y': 240 }),
  });
  const r = evaluateBudget(runs, null);
  assert.deepEqual(r.flag.grownSteps.map((s) => [s.step, s.beforeSeconds]), [['gates › a11y', 0]]);
});

test('the threshold and floor come from config', () => {
  const runs = series([100, 100, 100, 100, 108]);
  assert.equal(evaluateBudget(runs, null).state, 'ok');
  assert.equal(evaluateBudget(runs, null, { threshold: 0.05 }).state, 'over');
});

// ── the store ────────────────────────────────────────────────────────────────

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ci-runtime-'));

test('the store is machine-wide and keyed by repo, not inside the managed project', () => {
  assert.equal(storePath('Acme/site', '/home/x'), '/home/x/.build-studio/ci-runtime/Acme__site.json');
});

test('the store keeps the newest runs per workflow and the markers', () => {
  const file = path.join(tmp(), 's.json');
  const runs = {};
  for (let i = 0; i < KEEP_RUNS + 5; i++) runs[i + 1] = { id: i + 1, workflow: 'Web', createdAt: at(i), seconds: 60 };
  runs[999] = { id: 999, workflow: 'Docs', createdAt: at(0), seconds: 60 };
  writeStore(file, { runs, markers: { Web: { at: at(3) } } });
  const s = readStore(file);
  assert.equal(Object.values(s.runs).filter((r) => r.workflow === 'Web').length, KEEP_RUNS);
  assert.ok(!s.runs[1], 'the oldest went');
  assert.ok(s.runs[999], 'another workflow keeps its own');
  assert.deepEqual(s.markers, { Web: { at: at(3) } });
});

test('an unreadable store reads as empty', () => {
  assert.deepEqual(readStore(path.join(tmp(), 'nope.json')), { runs: {}, markers: {}, watching: {} });
});

// ── keep watching ────────────────────────────────────────────────────────────

test('keep watching quiets the notice at the size seen, and keeps the baseline', () => {
  const judged = applyWatch(evaluateBudget(series([10, 10, 10, 10, 14, 15])), { sinceId: 5, seconds: 14 * 60, at: at(0) });
  assert.equal(judged.state, 'over', 'still over the old baseline');
  assert.equal(judged.flag.baselineSeconds, 600);
  assert.equal(judged.flag.watching.grown, false, '15 min is within 10% of the 14 seen');
  assert.equal(needsNotice(judged), false);
});

test('the notice comes back once it grows 10% and two minutes past the size seen', () => {
  const judged = applyWatch(evaluateBudget(series([10, 10, 10, 10, 14, 17])), { sinceId: 5, seconds: 14 * 60, at: at(0) });
  assert.equal(judged.flag.watching.grown, true);
  assert.equal(judged.flag.watching.grownSeconds, 180);
  assert.equal(needsNotice(judged), true);
});

test('a watch ends with its episode: back within budget, the next breach is announced', () => {
  // Over at run 5, back within budget at run 6, over again at run 9.
  const judged = applyWatch(evaluateBudget(series([10, 10, 10, 10, 14, 10, 10, 10, 14])), { sinceId: 5, seconds: 14 * 60, at: at(0) });
  assert.equal(judged.flag.since.id, 9);
  assert.equal(judged.flag.watching, undefined);
  assert.equal(needsNotice(judged), true);
});

// ── fetching and the actions ─────────────────────────────────────────────────

function fakeGh(runsByWorkflow, calls = []) {
  return async (cmd, args) => {
    calls.push(args.join(' '));
    const out = (v) => ({ stdout: JSON.stringify(v) });
    if (args[0] === 'repo') return out({ defaultBranchRef: { name: 'main' } });
    if (args[0] === 'workflow') {
      return out(Object.keys(runsByWorkflow).map((name, i) => ({ id: i + 1, name, state: 'active' })).concat([{ id: 99, name: 'Old', state: 'disabled_manually' }]));
    }
    if (args[0] === 'run' && args[1] === 'list') {
      const name = Object.keys(runsByWorkflow)[Number(args[args.indexOf('--workflow') + 1]) - 1];
      return out(runsByWorkflow[name].map((m, i) => ({ databaseId: `${name}-${i}`, createdAt: at(i * 1440), headSha: `sha${i}`, displayTitle: `push ${i}`, url: `u${i}` })));
    }
    if (args[0] === 'run' && args[1] === 'view') {
      const [name, i] = args[2].split('-');
      return out({ jobs: [job('all', 0, runsByWorkflow[name][Number(i)])] });
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
}

test('only successful pushes on the default branch are asked for, and each run is viewed once', async () => {
  const calls = [];
  const rt = createCiRuntime({ deployment: { repo: 'a/b' } }, {
    execFileAsync: fakeGh({ Web: [100, 100, 100, 100] }, calls), storeFile: path.join(tmp(), 's.json'),
  });
  await rt.refresh();
  const list = calls.find((c) => c.startsWith('run list'));
  assert.match(list, /--event push/);
  assert.match(list, /--status success/);
  assert.match(list, /--branch main/);
  assert.equal(calls.filter((c) => c.startsWith('run view')).length, 4);
  assert.ok(!calls.some((c) => c.includes('--workflow 99')), 'disabled workflows are skipped');
  await rt.refresh();
  assert.equal(calls.filter((c) => c.startsWith('run view')).length, 4, 'no run is viewed twice');
});

test('an over-budget workflow becomes a Monitor alert, and accepting it starts a new baseline', async () => {
  const rt = createCiRuntime({ name: 'site', deployment: { repo: 'a/b' } }, {
    execFileAsync: fakeGh({ Web: [100, 100, 100, 100, 130], Docs: [3, 3, 3, 3, 3] }), storeFile: path.join(tmp(), 's.json'),
  });
  await rt.refresh();
  const web = rt.get().workflows.find((w) => w.name === 'Web');
  assert.equal(web.state, 'over');
  const alerts = rt.alerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].id, 'ci-runtime:Web');
  assert.equal(alerts[0].severity, 'low');
  assert.deepEqual(alerts[0].open, { fn: 'operations', tab: 'cicd', label: 'CI/CD' }, 'the row opens the tab with the actions');

  assert.throws(() => rt.accept('Docs'), /not over its runtime budget/);
  const after = rt.accept('Web');
  const w = after.workflows.find((x) => x.name === 'Web');
  assert.equal(w.marker.reason, 'accepted');
  assert.equal(w.state, 'quiet');
  assert.deepEqual(rt.alerts(), []);
});

test('keep watching takes the row off the Monitor, and accepting later ends the watch', async () => {
  const file = path.join(tmp(), 's.json');
  const rt = createCiRuntime({ name: 'site', deployment: { repo: 'a/b' } }, {
    execFileAsync: fakeGh({ Web: [100, 100, 100, 100, 130] }), storeFile: file,
  });
  await rt.refresh();
  assert.throws(() => rt.watch('Docs'), /not over its runtime budget/);
  const web = rt.watch('Web').workflows.find((w) => w.name === 'Web');
  assert.equal(web.state, 'over');
  assert.equal(web.flag.watching.seconds, 130 * 60);
  assert.deepEqual(rt.alerts(), []);
  assert.ok(readStore(file).watching.Web, 'kept on this machine');

  rt.accept('Web');
  assert.deepEqual(readStore(file).watching, {});
});

test('a maintenance marker applies to every workflow', async () => {
  const rt = createCiRuntime({ deployment: { repo: 'a/b' } }, {
    execFileAsync: fakeGh({ Web: [100, 100], Docs: [3, 3] }), storeFile: path.join(tmp(), 's.json'),
  });
  await rt.refresh();
  assert.deepEqual(rt.markBaseline(at(1440), 'maintenance').sort(), ['Docs', 'Web']);
  assert.ok(rt.get().workflows.every((w) => w.marker && w.marker.reason === 'maintenance'));
});

test('no repo, or ci_runtime_budget: false, makes no GitHub calls at all', () => {
  const boom = async () => { throw new Error('called gh'); };
  for (const config of [{ deployment: {} }, { deployment: { repo: 'a/b', ci_runtime_budget: false } }]) {
    const rt = createCiRuntime(config, { execFileAsync: boom, storeFile: path.join(tmp(), 's.json') });
    rt.prime();
    assert.deepEqual(rt.get(), { configured: false, workflows: [] });
    assert.deepEqual(rt.alerts(), []);
  }
});
