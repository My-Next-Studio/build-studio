'use strict';

/**
 * Test-suite health measured on this machine — Operations → Tests. Design:
 * docs/plans/local-suite-watch.md.
 *
 * The CI runtime watch (lib/ci-runtime.js) judges GitHub CI on the default
 * branch. A project that merges locally and pushes rarely gives it almost
 * nothing to judge, while its suite grows with every story. This judges what is
 * measured here instead, per suite, with the same rule:
 *
 *   seconds  each merge-gate step, and the nightly run
 *   tests    each merge-gate step that reports a count, and the nightly run
 *   lines    lines of test code on the branch, counted by Build Studio
 *
 * A metric is over budget when it drifts more than 10% above the median of its
 * recent values (ci-runtime's evaluateBudget, unchanged), and optionally when it
 * crosses a cap set in config. A notice offers Accept (new baseline), Keep
 * watching, or a review. Separately, a review of the suite for overlap comes
 * due every `review_every` stories merged.
 *
 * Config (.build-studio/config.yaml):
 *
 *   suite_watch:
 *     gate_history: tmp/ci-check/history.jsonl   # the gate's run log, one JSON line per run
 *     test_paths: [apps/web/test, ":(glob)apps/web/src/**\/*.test.ts"]   # git pathspecs
 *     branch: main                 # where test code is counted (default: nightly.branch, else main)
 *     review_every: 10             # stories between overlap reviews; 0 turns the reminder off
 *     budget: { threshold: 0.1, window: 10, min_runs: 3 }
 *     caps:                        # optional ceilings, by series key
 *       nightly: { minutes: 35, tests: 320 }
 *       "gate:vitest": { tests: 5000 }
 *       code: { lines: 50000 }
 *
 * THE GATE HISTORY belongs to the project's gate, which appends one line per run:
 *
 *   {"at": ISO, "head": sha, "mode": "pre-merge", "ok": true,
 *    "steps": [{"name": "vitest", "seconds": 10.2, "tests": 4277}, …]}
 *
 * Only `ok: true` runs count: a failed run stops early, so its timings are not
 * comparable. `tests` is optional per step.
 *
 * Stored per machine, like the CI runtime store: the line counts are a cache of
 * git, and the markers and watches are the owner's decisions.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { evaluateBudget, applyWatch, needsNotice } = require('./ci-runtime');
const { assertInside } = require('./path-guard');

const METRICS = ['seconds', 'tests', 'lines'];

/** Growth smaller than this is ignored whatever the percentage. */
const MIN_EXCESS = { seconds: 60, tests: 25, lines: 1000 };
const DEFAULT_BUDGET = { threshold: 0.10, window: 10, min_runs: 3 };
const DEFAULT_REVIEW_EVERY = 10;
/** Recurring flakiness: a test unstable in at least this many of the last N runs. */
const FLAKY_WINDOW = 7;
const FLAKY_MIN = 3;
const KEEP_SAMPLES = 60;

function suiteWatchConfig(config) {
  const s = config && config.suite_watch;
  if (!s || typeof s !== 'object') return null;
  const root = config.projectRoot;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  let gateHistory = null;
  try { gateHistory = str(s.gate_history) ? assertInside(str(s.gate_history), root) : null; } catch (_) { return null; }
  const testPaths = (Array.isArray(s.test_paths) ? s.test_paths : []).map(str).filter(Boolean)
    // A pathspec that climbs out of the repository is refused, not trusted to git.
    .filter((p) => !p.replace(/^:\([^)]*\)/, '').split('/').includes('..'));
  const reviewEvery = Number.isInteger(s.review_every) && s.review_every >= 0 ? s.review_every : DEFAULT_REVIEW_EVERY;
  const budget = { ...DEFAULT_BUDGET, ...(s.budget && typeof s.budget === 'object' ? s.budget : {}) };
  const caps = {};
  for (const [key, c] of Object.entries((s.caps && typeof s.caps === 'object') ? s.caps : {})) {
    if (!c || typeof c !== 'object') continue;
    const cap = {};
    if (Number.isFinite(c.minutes)) cap.seconds = c.minutes * 60;
    if (Number.isFinite(c.seconds)) cap.seconds = c.seconds;
    if (Number.isFinite(c.tests)) cap.tests = c.tests;
    if (Number.isFinite(c.lines)) cap.lines = c.lines;
    caps[key] = cap;
  }
  const nightlyBranch = config.nightly && typeof config.nightly === 'object' ? str(config.nightly.branch) : null;
  return {
    gateHistory,
    testPaths,
    branch: str(s.branch) || nightlyBranch || 'main',
    reviewEvery,
    budget,
    caps,
  };
}

/** The gate's successful runs, oldest first. Unreadable lines are skipped. */
function readGateHistory(file) {
  if (!file) return [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const runs = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch (_) { continue; }
    if (!r || r.ok !== true || !Array.isArray(r.steps) || !Number.isFinite(Date.parse(r.at))) continue;
    runs.push({ id: r.at, createdAt: r.at, head: r.head || null, mode: r.mode || null, steps: r.steps.filter((s) => s && typeof s.name === 'string') });
  }
  return runs.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

/**
 * Every measured series. A key names the suite and stays stable across runs:
 * `gate:<step>`, `nightly`, `code`.
 *
 * @param {object} p
 * @param {Array} p.gateRuns     readGateHistory()
 * @param {Array} p.nightlyRuns  lib/nightly readRuns()
 * @param {Array} p.codeSamples  the store's line counts
 */
function buildSeries({ gateRuns = [], nightlyRuns = [], nightlyLabel = 'Nightly', codeSamples = [] }) {
  const series = new Map();
  const get = (key, label, source) => {
    if (!series.has(key)) series.set(key, { key, label, source, points: { seconds: [], tests: [], lines: [] } });
    return series.get(key);
  };
  for (const run of gateRuns) {
    for (const step of run.steps) {
      const s = get(`gate:${step.name}`, step.name, 'gate');
      if (Number.isFinite(step.seconds)) s.points.seconds.push({ id: run.id, createdAt: run.createdAt, value: step.seconds, head: run.head });
      if (Number.isFinite(step.tests)) s.points.tests.push({ id: run.id, createdAt: run.createdAt, value: step.tests, head: run.head });
    }
  }
  // Only runs that ran the suite through: an empty or failed-to-start run says nothing about its size.
  for (const r of nightlyRuns) {
    if (!['passed', 'flaky', 'failed'].includes(r.outcome)) continue;
    const s = get('nightly', nightlyLabel, 'nightly');
    const sum = r.summary;
    const at = sum.finishedAt || r.startedAt;
    if (Number.isFinite(sum.durationSec)) s.points.seconds.push({ id: r.id, createdAt: at, value: sum.durationSec, head: sum.head || null });
    const tests = ['passed', 'failed', 'flaky', 'skipped'].reduce((n, k) => n + (Number(sum[k]) || 0), 0);
    if (tests > 0) s.points.tests.push({ id: r.id, createdAt: at, value: tests, head: sum.head || null });
  }
  for (const c of codeSamples) {
    if (!Number.isFinite(c.lines)) continue;
    get('code', 'Test code', 'code').points.lines.push({ id: c.head, createdAt: c.at, value: c.lines, head: c.head, byPath: c.byPath || null });
  }
  for (const s of series.values()) for (const m of METRICS) s.points[m].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return [...series.values()];
}

/**
 * One metric of one series, judged: ci-runtime's replay over `value` in place
 * of runner seconds, then the owner's watch and the cap.
 */
function judgeMetric(points, { metric, marker, watch, budget, cap }) {
  const b = { ...DEFAULT_BUDGET, ...budget, min_excess_seconds: MIN_EXCESS[metric] };
  const evaluation = applyWatch(
    evaluateBudget(points.map((p) => ({ id: p.id, createdAt: p.createdAt, seconds: p.value })), marker, b),
    watch,
    b,
  );
  const latest = points.length ? points[points.length - 1] : null;
  return {
    metric,
    state: evaluation.state,
    latest: latest ? { id: latest.id, at: latest.createdAt, value: latest.value, head: latest.head || null } : null,
    median: evaluation.medianSeconds,
    flag: evaluation.flag
      ? {
          baseline: evaluation.flag.baselineSeconds,
          latest: evaluation.flag.latestSeconds,
          overPct: evaluation.flag.overPct,
          since: evaluation.flag.since,
          watching: evaluation.flag.watching
            ? { value: evaluation.flag.watching.seconds, at: evaluation.flag.watching.at, grown: evaluation.flag.watching.grown }
            : null,
        }
      : null,
    notice: needsNotice(evaluation),
    cap: Number.isFinite(cap) ? cap : null,
    overCap: Number.isFinite(cap) && !!latest && latest.value > cap,
    trend: points.slice(-20).map((p) => p.value),
  };
}

/** Every series with each of its measured metrics judged. */
function evaluateSeries(series, store, cfg) {
  return series.map((s) => {
    const metrics = {};
    for (const m of METRICS) {
      if (!s.points[m].length) continue;
      metrics[m] = judgeMetric(s.points[m], {
        metric: m,
        marker: (store.markers || {})[s.key] || null,
        watch: (store.watching || {})[`${s.key}|${m}`] || null,
        budget: cfg.budget,
        cap: (cfg.caps[s.key] || {})[m],
      });
    }
    const code = s.key === 'code' && s.points.lines.length ? s.points.lines[s.points.lines.length - 1].byPath : null;
    return { key: s.key, label: s.label, source: s.source, metrics, ...(code ? { byPath: code } : {}) };
  });
}

/** Execution workflows completed after `sinceIso`, from the scorecard. */
function storiesSince(scorecardRows, sinceIso) {
  const since = Date.parse(sinceIso || '') || 0;
  const done = new Map();
  for (const r of scorecardRows) {
    if (!r || r.type !== 'execution' || !r.wfId) continue;
    const t = Date.parse(r.at || '');
    if (!Number.isFinite(t) || t <= since) continue;
    if (!done.has(r.wfId) || done.get(r.wfId).at < t) done.set(r.wfId, { id: r.wfId, item: r.input || null, at: t });
  }
  return [...done.values()].sort((a, b) => a.at - b.at).map((s) => ({ ...s, at: new Date(s.at).toISOString() }));
}

function readScorecard(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return []; }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch (_) { /* a torn line */ }
  }
  return rows;
}

/**
 * Tests unstable (red or flaky) in at least FLAKY_MIN of the last FLAKY_WINDOW
 * nightly runs that ran the suite, most unstable first. Line numbers are
 * dropped from the identity (lib/nightly testKey) so an edited spec keeps it.
 */
function recurringFlaky(nightlyRuns, testKey) {
  const recent = nightlyRuns.filter((r) => ['passed', 'flaky', 'failed'].includes(r.outcome)).slice(0, FLAKY_WINDOW);
  const byKey = new Map();
  for (const r of recent) {
    const seen = new Set();
    for (const [list, kind] of [[r.summary.flakes || [], 'flaky'], [r.summary.failures || [], 'failed']]) {
      for (const name of list) {
        const key = testKey(name);
        if (seen.has(key)) continue;
        seen.add(key);
        const e = byKey.get(key) || { test: name, flaky: 0, failed: 0 };
        e[kind] += 1;
        byKey.set(key, e);
      }
    }
  }
  return [...byKey.values()]
    .filter((e) => e.flaky > 0 && e.flaky + e.failed >= FLAKY_MIN)
    .map((e) => ({ ...e, of: recent.length }))
    .sort((a, b) => (b.flaky + b.failed) - (a.flaky + a.failed) || a.test.localeCompare(b.test));
}

function fmtValue(metric, v) {
  if (v == null) return '—';
  if (metric === 'seconds') {
    const s = Math.round(v);
    if (s < 120) return `${s}s`;
    const m = Math.round(s / 60);
    return m < 120 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
  }
  return `${Math.round(v).toLocaleString('en-US')} ${metric === 'tests' ? 'tests' : 'lines'}`;
}

const METRIC_NAME = { seconds: 'time', tests: 'test count', lines: 'test code' };

/** The Monitor rows: growth and caps, recurring flakiness, a review due. */
function deriveAlerts({ evaluated, flaky, review, project }) {
  const open = { fn: 'operations', tab: 'tests', label: 'Tests' };
  const out = [];
  for (const s of evaluated) {
    for (const m of Object.values(s.metrics)) {
      if (m.overCap) {
        out.push({
          source: 'suite-watch', kind: 'suite-cap', project, id: `suite-cap:${s.key}:${m.metric}`, severity: 'moderate',
          title: `${s.label} ${METRIC_NAME[m.metric]} is over its cap`,
          detail: `${fmtValue(m.metric, m.latest.value)} against a cap of ${fmtValue(m.metric, m.cap)}. Open Tests to review the suite, or raise the cap in suite_watch.caps.`,
          open, since: m.latest.at,
        });
      } else if (m.notice) {
        out.push({
          source: 'suite-watch', kind: 'suite-growth', project, id: `suite-growth:${s.key}:${m.metric}`, severity: 'low',
          title: `${s.label} ${METRIC_NAME[m.metric]} is ${m.flag.overPct}% over its baseline`,
          detail: `${fmtValue(m.metric, m.flag.latest)} against ${fmtValue(m.metric, m.flag.baseline)}. Open Tests to start a review, keep watching, or accept the new size.`,
          open, since: m.flag.since.createdAt,
        });
      }
    }
  }
  if (flaky.length) {
    out.push({
      source: 'suite-watch', kind: 'suite-flaky', project, id: `suite-flaky:${project}`, severity: 'moderate',
      title: `${flaky.length} ${flaky.length === 1 ? 'test keeps' : 'tests keep'} flaking`,
      detail: `${flaky.slice(0, 2).map((f) => `${f.test} (${f.flaky + f.failed} of ${f.of})`).join('; ')}${flaky.length > 2 ? ` and ${flaky.length - 2} more` : ''}.`,
      open, since: null,
    });
  }
  if (review && review.due) {
    out.push({
      source: 'suite-watch', kind: 'suite-review-due', project, id: `suite-review:${project}`, severity: 'low',
      title: `Test-suite review due: ${review.stories.length} stories since the last`,
      detail: 'Each story adds its own tests and nothing consolidates them. Open Tests to start a review, or skip this round.',
      open, since: review.since,
    });
  }
  return out;
}

// ── the store ────────────────────────────────────────────────────────────────

function storePath(projectRoot, home = os.homedir()) {
  const tag = crypto.createHash('sha1').update(path.resolve(projectRoot)).digest('hex').slice(0, 10);
  return path.join(home, '.build-studio', 'suite-watch', `${path.basename(projectRoot).replace(/[^A-Za-z0-9._-]/g, '_')}-${tag}.json`);
}

function readStore(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    return { code: s.code || [], markers: s.markers || {}, watching: s.watching || {}, review: s.review || {} };
  } catch (_) {
    return { code: [], markers: {}, watching: {}, review: {} };
  }
}

function writeStore(file, store) {
  const code = [...(store.code || [])].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-KEEP_SAMPLES);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...store, code }, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

/**
 * Lines of test code, from `git grep -c ''` output (`<rev>:<path>:<count>`
 * per file), totalled and per configured path.
 */
function countLines(grepOutput, rev, testPaths) {
  const byPath = {};
  let lines = 0;
  let files = 0;
  const strip = (p) => p.replace(/^:\([^)]*\)/, '');
  for (const raw of String(grepOutput || '').split('\n')) {
    if (!raw) continue;
    const rest = raw.startsWith(`${rev}:`) ? raw.slice(rev.length + 1) : raw;
    const i = rest.lastIndexOf(':');
    if (i < 0) continue;
    const file = rest.slice(0, i);
    const n = Number(rest.slice(i + 1));
    if (!Number.isFinite(n)) continue;
    lines += n;
    files += 1;
    // Attribute to the first configured path that is a plain prefix of it, else to "other".
    const owner = testPaths.map(strip).find((p) => !/[*?[]/.test(p) && (file === p || file.startsWith(p.replace(/\/$/, '') + '/')));
    const k = owner || 'other';
    byPath[k] = (byPath[k] || 0) + n;
  }
  return { lines, files, byPath };
}

module.exports = {
  METRICS, MIN_EXCESS, DEFAULT_BUDGET, DEFAULT_REVIEW_EVERY, FLAKY_WINDOW, FLAKY_MIN,
  suiteWatchConfig, readGateHistory, buildSeries, judgeMetric, evaluateSeries,
  storiesSince, readScorecard, recurringFlaky, deriveAlerts, fmtValue,
  storePath, readStore, writeStore, countLines,
};
