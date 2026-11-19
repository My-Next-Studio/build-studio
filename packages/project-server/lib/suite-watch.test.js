'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sw = require('./suite-watch');
const { testKey } = require('./nightly');

const root = '/tmp/proj';
const day = (n) => new Date(Date.UTC(2026, 10, n, 12)).toISOString();

test('config: off without the block; paths, caps and defaults resolved', () => {
  assert.equal(sw.suiteWatchConfig({ projectRoot: root }), null);
  const c = sw.suiteWatchConfig({
    projectRoot: root,
    nightly: { branch: 'trunk' },
    suite_watch: {
      gate_history: 'tmp/ci-check/history.jsonl',
      test_paths: ['apps/web/test', ':(glob)src/**/*.test.ts', '../outside', ''],
      caps: { nightly: { minutes: 35, tests: 320 }, code: { lines: 50000 } },
    },
  });
  assert.equal(c.gateHistory, '/tmp/proj/tmp/ci-check/history.jsonl');
  assert.deepEqual(c.testPaths, ['apps/web/test', ':(glob)src/**/*.test.ts']);
  assert.equal(c.branch, 'trunk');
  assert.equal(c.reviewEvery, 10);
  assert.deepEqual(c.caps.nightly, { seconds: 2100, tests: 320 });
  assert.equal(sw.suiteWatchConfig({ projectRoot: root, suite_watch: { gate_history: '../x' } }), null);
  assert.equal(sw.suiteWatchConfig({ projectRoot: root, suite_watch: { review_every: 0 } }).reviewEvery, 0);
});

test('gate history: only successful runs, oldest first, torn lines skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-'));
  const file = path.join(dir, 'history.jsonl');
  fs.writeFileSync(file, [
    JSON.stringify({ at: day(2), ok: true, head: 'b', steps: [{ name: 'vitest', seconds: 11, tests: 4300 }] }),
    JSON.stringify({ at: day(1), ok: true, head: 'a', steps: [{ name: 'vitest', seconds: 10, tests: 4200 }] }),
    JSON.stringify({ at: day(3), ok: false, steps: [{ name: 'vitest', seconds: 2 }] }),
    '{"at": "torn',
  ].join('\n'));
  const runs = sw.readGateHistory(file);
  assert.deepEqual(runs.map((r) => r.head), ['a', 'b']);
  assert.deepEqual(sw.readGateHistory(path.join(dir, 'absent')), []);
});

const nightly = (id, summary) => ({ id, startedAt: id, summary, outcome: summary.error ? 'error' : summary.failed ? 'failed' : summary.flaky ? 'flaky' : summary.passed ? 'passed' : 'empty' });

test('series: gate steps, the nightly run (only full runs) and test code', () => {
  const series = sw.buildSeries({
    gateRuns: [{ id: day(1), createdAt: day(1), head: 'a', steps: [{ name: 'vitest', seconds: 10, tests: 4200 }, { name: 'pgtap', seconds: 35 }] }],
    nightlyRuns: [
      nightly(day(2), { finishedAt: day(2), durationSec: 1900, passed: 290, failed: 2, flaky: 2, skipped: 0 }),
      nightly(day(3), { error: 'Docker did not start' }),
      nightly(day(4), { passed: 0, failed: 0, flaky: 0, durationSec: 2 }),
    ],
    nightlyLabel: 'E2E',
    codeSamples: [{ head: 'c', at: day(1), lines: 42300, byPath: { 'apps/web/test': 30000 } }],
  });
  const by = Object.fromEntries(series.map((s) => [s.key, s]));
  assert.deepEqual(Object.keys(by).sort(), ['code', 'gate:pgtap', 'gate:vitest', 'nightly']);
  assert.equal(by['gate:vitest'].points.tests[0].value, 4200);
  assert.equal(by['gate:pgtap'].points.tests.length, 0);
  assert.equal(by.nightly.label, 'E2E');
  assert.deepEqual(by.nightly.points.seconds.map((p) => p.value), [1900]);
  assert.deepEqual(by.nightly.points.tests.map((p) => p.value), [294]);
  assert.equal(by.code.points.lines[0].value, 42300);
});

const pts = (values) => values.map((v, i) => ({ id: `r${i}`, createdAt: day(i + 1), value: v }));

test('judge: the CI-runtime rule on any metric, with its own minimum size', () => {
  // Tests: 10% and at least 25 tests.
  const over = sw.judgeMetric(pts([4000, 4010, 4020, 4500]), { metric: 'tests', budget: {} });
  assert.equal(over.state, 'over');
  assert.equal(over.notice, true);
  assert.equal(over.flag.baseline, 4010);
  // 20% of a 10-second step is two seconds: not worth a notice.
  const small = sw.judgeMetric(pts([10, 10, 10, 12]), { metric: 'seconds', budget: {} });
  assert.equal(small.state, 'ok');
  // Too few runs to judge.
  assert.equal(sw.judgeMetric(pts([100, 200]), { metric: 'tests', budget: {} }).state, 'quiet');
});

test('judge: a marker restarts the baseline; a watch quiets the notice until it grows again', () => {
  const p = pts([4000, 4010, 4020, 4500, 4510]);
  const accepted = sw.judgeMetric(p, { metric: 'tests', budget: {}, marker: { at: day(4) } });
  assert.notEqual(accepted.state, 'over');
  const flagged = sw.judgeMetric(p, { metric: 'tests', budget: {} });
  const watched = sw.judgeMetric(p, { metric: 'tests', budget: {}, watch: { sinceId: flagged.flag.since.id, seconds: 4500, at: day(5) } });
  assert.equal(watched.state, 'over');
  assert.equal(watched.notice, false);
  const grew = sw.judgeMetric(pts([4000, 4010, 4020, 4500, 5100]), { metric: 'tests', budget: {}, watch: { sinceId: flagged.flag.since.id, seconds: 4500, at: day(5) } });
  assert.equal(grew.notice, true);
});

test('judge: a cap is crossed by the latest value alone', () => {
  const m = sw.judgeMetric(pts([1900, 2200]), { metric: 'seconds', budget: {}, cap: 2100 });
  assert.equal(m.overCap, true);
  assert.equal(sw.judgeMetric(pts([1900]), { metric: 'seconds', budget: {}, cap: 2100 }).overCap, false);
});

test('stories: execution workflows completed since the review, counted once each', () => {
  const rows = [
    { at: day(1), wfId: 'execution-1', type: 'execution', input: 'PHO-1' },
    { at: day(3), wfId: 'execution-2', type: 'execution', input: 'PHO-2' },
    { at: day(3), wfId: 'execution-2', type: 'execution', input: 'PHO-2' },
    { at: day(4), wfId: 'review-1', type: 'review', input: 'PHO-3' },
    { at: day(5), wfId: 'execution-3', type: 'execution', input: 'PHO-4' },
  ];
  assert.deepEqual(sw.storiesSince(rows, day(2)).map((s) => s.item), ['PHO-2', 'PHO-4']);
});

test('flaky: a test unstable in 3 of the last 7 full runs recurs; red-only does not', () => {
  const r = (n, flakes, failures = []) => nightly(day(n), { passed: 10, failed: failures.length, flaky: flakes.length, flakes, failures });
  const runs = [
    r(9, ['feed.spec.ts:352 › chromium › keeps'], ['detail.spec.ts:1385 › chromium › bytes']),
    r(8, [], ['feed.spec.ts:350 › chromium › keeps', 'detail.spec.ts:1385 › chromium › bytes']),
    r(7, ['feed.spec.ts:352 › chromium › keeps'], ['detail.spec.ts:1385 › chromium › bytes']),
    nightly(day(6), { error: 'Docker did not start' }),
  ];
  const f = sw.recurringFlaky(runs, testKey);
  assert.equal(f.length, 1);
  assert.equal(f[0].flaky, 2);
  assert.equal(f[0].failed, 1);
  assert.equal(f[0].of, 3);
});

test('countLines: totals and per configured path from git grep -c', () => {
  const out = ['abc:apps/web/test/a.test.ts:120', 'abc:apps/web/test/b.test.ts:30', 'abc:supabase/tests/x.sql:50', 'abc:src/c.test.ts:7'].join('\n');
  const c = sw.countLines(out, 'abc', ['apps/web/test', 'supabase/tests/', ':(glob)src/**/*.test.ts']);
  assert.equal(c.lines, 207);
  assert.equal(c.files, 4);
  assert.deepEqual(c.byPath, { 'apps/web/test': 150, 'supabase/tests/': 50, other: 7 });
});

test('alerts: cap moderate, growth low, flaky moderate, review due low; all open Tests', () => {
  const capM = sw.judgeMetric(pts([1900, 2200]), { metric: 'seconds', budget: {}, cap: 2100 });
  const grow = sw.judgeMetric(pts([4000, 4010, 4020, 4500]), { metric: 'tests', budget: {} });
  const alerts = sw.deriveAlerts({
    evaluated: [{ key: 'nightly', label: 'E2E', metrics: { seconds: capM, tests: grow } }],
    flaky: [{ test: 'feed.spec.ts:352 › chromium › keeps', flaky: 2, failed: 1, of: 7 }],
    review: { due: true, stories: new Array(10).fill({}), since: day(1) },
    project: 'p',
  });
  assert.deepEqual(alerts.map((a) => [a.kind, a.severity]), [
    ['suite-cap', 'moderate'], ['suite-growth', 'low'], ['suite-flaky', 'moderate'], ['suite-review-due', 'low'],
  ]);
  assert.ok(alerts.every((a) => a.open.tab === 'tests'));
  assert.match(alerts[0].detail, /37 min against a cap of 35 min/);
});

test('store: per project root, survives a missing file, keeps the newest samples', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-home-'));
  const file = sw.storePath('/Volumes/x/phoclub', home);
  assert.match(file, /suite-watch\/phoclub-[0-9a-f]{10}\.json$/);
  assert.notEqual(file, sw.storePath('/Volumes/y/phoclub', home));
  const s = sw.readStore(file);
  s.code = Array.from({ length: 70 }, (_, i) => ({ head: `h${i}`, at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(), lines: i }));
  sw.writeStore(file, s);
  const back = sw.readStore(file);
  assert.equal(back.code.length, 60);
  assert.equal(back.code[59].head, 'h69');
});
