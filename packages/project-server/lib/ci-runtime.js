'use strict';

/**
 * CI runtime per workflow on the default branch, and a budget that notices when
 * a suite grows. Design: docs/plans/test-suite-drift.md.
 *
 * Every workflow step is scoped to one PRD, so a test suite only ever grows. One
 * managed project's CI reached two to three hours for a small site before anyone
 * looked. This measures what CI already reports and raises a notice when a
 * workflow's runner time drifts more than 10% over its own recent median.
 *
 * Choices worth knowing before changing anything here:
 *
 * - **CI on the default branch, not QA.** QA runs only the part of a suite a
 *   branch touches, so its runtime is not comparable run to run. CI on the
 *   default branch runs everything, every time.
 * - **Runner time, not wall clock.** A run's duration is the sum of its jobs'
 *   own durations, so time spent queued behind another run is not "growth".
 * - **Successful push runs only.** A failed or cancelled run stops early.
 * - **The budget is derived by replaying history**, not by remembering a flag.
 *   Walking the runs since the last baseline marker in order gives the same
 *   answer every time, so nothing can get stuck "over budget" after the cause
 *   is gone, and nothing needs a migration when the rule changes.
 * - **Stored machine-wide**, under ~/.build-studio/ci-runtime/, keyed by repo.
 *   The run timings are a cache of GitHub and the markers are the owner's
 *   decisions about that repo; neither belongs in the managed project's git,
 *   and writing into it would mean a .gitignore change and a commit per project.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createCache } = require('./github-cache');

const execFileAsync = promisify(execFile);

const DEFAULT_BUDGET = {
  /** Over budget when more than this fraction above the baseline median. */
  threshold: 0.10,
  /** The median is taken over at most this many runs before the one judged. */
  window: 10,
  /** Quiet until at least this many runs since the marker precede the one judged. */
  min_runs: 3,
  /**
   * Growth smaller than this is ignored whatever the percentage. A 40-second
   * docs check that takes 50 seconds is 25% over and costs nothing.
   */
  min_excess_seconds: 120,
};

/** Runs kept per workflow. The replay only needs the runs since the marker. */
const KEEP_RUNS = 60;
/** Runs asked for per workflow on each refresh; also the seed on first use. */
const FETCH_RUNS = 12;
/** Pushes land a few times a day at most; a run takes minutes to hours. */
const TTL_REFRESH = 30 * 60 * 1000;

// ── pure: timings ────────────────────────────────────────────────────────────

function spanSeconds(startedAt, completedAt) {
  const a = Date.parse(startedAt || '');
  const b = Date.parse(completedAt || '');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  // A skipped job is reported as completing before it starts.
  return Math.max(0, Math.round((b - a) / 1000));
}

/** Runner seconds of one run: the sum of its jobs' durations. */
function runnerSeconds(jobs) {
  return (jobs || []).reduce((sum, j) => (
    j && j.conclusion !== 'skipped' ? sum + spanSeconds(j.startedAt, j.completedAt) : sum
  ), 0);
}

/** Seconds per step, keyed `job › step`, so a notice can say what grew. */
function stepSeconds(jobs) {
  const out = {};
  for (const j of jobs || []) {
    if (!j || j.conclusion === 'skipped') continue;
    for (const s of j.steps || []) {
      if (!s || !s.name) continue;
      const secs = spanSeconds(s.startedAt, s.completedAt);
      if (!secs) continue;
      const key = `${j.name} › ${s.name}`;
      out[key] = (out[key] || 0) + secs;
    }
  }
  return out;
}

function median(xs) {
  const v = (xs || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

// ── pure: the budget ─────────────────────────────────────────────────────────

function isOver(seconds, baseline, b) {
  return seconds > baseline * (1 + b.threshold) && seconds - baseline >= b.min_excess_seconds;
}

/**
 * The steps that grew most between the baseline runs and `run`, largest first.
 * Only growth of a minute or more is worth naming.
 */
function grownSteps(baselineRuns, run, limit = 3) {
  const keys = new Set(Object.keys(run.steps || {}));
  for (const r of baselineRuns) for (const k of Object.keys(r.steps || {})) keys.add(k);
  const out = [];
  for (const k of keys) {
    const before = median(baselineRuns.map((r) => (r.steps || {})[k] || 0)) || 0;
    const now = (run.steps || {})[k] || 0;
    if (now - before >= 60) out.push({ step: k, beforeSeconds: before, nowSeconds: now, deltaSeconds: now - before });
  }
  return out.sort((a, b) => b.deltaSeconds - a.deltaSeconds).slice(0, limit);
}

/**
 * Judge one workflow's series.
 *
 * Replays the successful runs since the marker in order. A run that is over the
 * median of the runs before it opens a flag, and the flag keeps that baseline:
 * it stays open while later runs are still over it, so a suite that grew and
 * stayed grown keeps its notice even after the rolling median has caught up.
 * A run back within budget closes it. The growth went away (a noisy runner, or
 * someone fixed it), and there is nothing left to act on.
 *
 * @param {Array<{id, createdAt, seconds, steps}>} runs  any order
 * @param {{at: string}|null} marker
 * @returns {{state: 'no-data'|'quiet'|'ok'|'over', runs: number, latest, medianSeconds, flag}}
 */
function evaluateBudget(runs, marker, budget = {}) {
  const b = { ...DEFAULT_BUDGET, ...budget };
  const since = (runs || [])
    .filter((r) => r && Number.isFinite(r.seconds) && r.seconds > 0)
    .filter((r) => !marker || !marker.at || Date.parse(r.createdAt) >= Date.parse(marker.at))
    .sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt));
  if (since.length === 0) return { state: 'no-data', runs: 0, latest: null, medianSeconds: null, flag: null };

  let flag = null;
  for (let i = 0; i < since.length; i++) {
    const run = since[i];
    if (flag) {
      if (!isOver(run.seconds, flag.baselineSeconds, b)) flag = null;
      else flag.latest = run;
      continue;
    }
    const prior = since.slice(Math.max(0, i - b.window), i);
    if (prior.length < b.min_runs) continue;
    const baseline = median(prior.map((r) => r.seconds));
    if (isOver(run.seconds, baseline, b)) {
      flag = { baselineSeconds: baseline, baselineRuns: prior, first: run, latest: run };
    }
  }

  const latest = since[since.length - 1];
  const recent = since.slice(-b.window);
  const base = {
    runs: since.length,
    latest: { id: latest.id, createdAt: latest.createdAt, seconds: latest.seconds, url: latest.url || null },
    medianSeconds: median(recent.map((r) => r.seconds)),
  };
  if (!flag) {
    return { ...base, state: since.length - 1 < b.min_runs ? 'quiet' : 'ok', flag: null };
  }
  return {
    ...base,
    state: 'over',
    flag: {
      baselineSeconds: flag.baselineSeconds,
      latestSeconds: flag.latest.seconds,
      overPct: Math.round(((flag.latest.seconds - flag.baselineSeconds) / flag.baselineSeconds) * 100),
      since: { id: flag.first.id, createdAt: flag.first.createdAt, sha: flag.first.sha || null, title: flag.first.title || null },
      grownSteps: grownSteps(flag.baselineRuns, flag.latest),
    },
  };
}

/**
 * "Keep watching": the owner has seen this size and keeps the old baseline.
 * The flag stays (the table still reports it), but the notice is quiet until a
 * run is over budget again measured from the size they saw. A watch belongs to
 * one episode, the flag that opened with `sinceId`: once CI comes back within
 * budget that flag closes, and the next one is new and is announced.
 *
 * Adds `flag.watching = {seconds, at, grown, grownSeconds}` when a watch applies.
 */
function applyWatch(evaluation, watch, budget = {}) {
  const flag = evaluation.flag;
  if (!flag || !watch || watch.sinceId !== flag.since.id) return evaluation;
  const b = { ...DEFAULT_BUDGET, ...budget };
  return {
    ...evaluation,
    flag: {
      ...flag,
      watching: {
        seconds: watch.seconds,
        at: watch.at,
        grown: isOver(flag.latestSeconds, watch.seconds, b),
        grownSeconds: flag.latestSeconds - watch.seconds,
      },
    },
  };
}

/** Over budget and not being watched quietly: the notice and the Monitor row show. */
function needsNotice(w) {
  return !!(w && w.flag && !(w.flag.watching && !w.flag.watching.grown));
}

// ── the store ────────────────────────────────────────────────────────────────

function storePath(repo, home = os.homedir()) {
  return path.join(home, '.build-studio', 'ci-runtime', `${String(repo).replace(/[^A-Za-z0-9._-]/g, '__')}.json`);
}

function readStore(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
    return { runs: s.runs || {}, markers: s.markers || {}, watching: s.watching || {} };
  } catch (_) {
    return { runs: {}, markers: {}, watching: {} };
  }
}

function writeStore(file, store) {
  // Drop the oldest runs per workflow beyond KEEP_RUNS.
  const byWf = new Map();
  for (const r of Object.values(store.runs)) {
    if (!byWf.has(r.workflow)) byWf.set(r.workflow, []);
    byWf.get(r.workflow).push(r);
  }
  const runs = {};
  for (const list of byWf.values()) {
    list.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    for (const r of list.slice(0, KEEP_RUNS)) runs[r.id] = r;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ runs, markers: store.markers, watching: store.watching || {} }, null, 2) + '\n');
}

/**
 * A marker per workflow; `all` sets one on every workflow seen so far. A new
 * baseline ends any watch on the old one.
 */
function setMarker(store, workflow, marker) {
  const names = workflow === '*'
    ? [...new Set(Object.values(store.runs).map((r) => r.workflow))]
    : [workflow];
  if (!store.watching) store.watching = {};
  for (const n of names) {
    store.markers[n] = marker;
    delete store.watching[n];
  }
  return names;
}

// ── GitHub ───────────────────────────────────────────────────────────────────

/**
 * @param {object} config  the loaded project config; `deployment.repo` gates it,
 *   `deployment.ci_runtime_budget: false` turns it off, an object overrides
 *   DEFAULT_BUDGET's keys.
 * @param {object} [deps]  injectable exec, store file and clock (tests)
 */
function createCiRuntime(config, deps = {}) {
  const exec = deps.execFileAsync || execFileAsync;
  const dep = (config && config.deployment) || {};
  const repo = dep.repo || null;
  const setting = dep.ci_runtime_budget;
  const enabled = !!repo && setting !== false;
  const budget = { ...DEFAULT_BUDGET, ...(setting && typeof setting === 'object' ? setting : {}) };
  const file = deps.storeFile || (repo ? storePath(repo) : null);
  const now = deps.now || (() => Date.now());

  // The hub polls alerts every few seconds; only this process writes the file,
  // so it is read once and again only after a write.
  let loaded = null;
  const load = () => (loaded || (loaded = readStore(file)));
  const save = (store) => { writeStore(file, store); loaded = null; };

  let defaultBranch = null;
  async function branch() {
    if (defaultBranch) return defaultBranch;
    try {
      const { stdout } = await exec('gh', ['repo', 'view', repo, '--json', 'defaultBranchRef'], { encoding: 'utf8' });
      defaultBranch = JSON.parse(String(stdout || '{}'))?.defaultBranchRef?.name || null;
    } catch (_) { return null; }
    return defaultBranch;
  }

  async function ghJson(args) {
    const { stdout } = await exec('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    return JSON.parse(String(stdout || 'null').trim() || 'null');
  }

  /**
   * One list per active workflow, then the job timings of each run not seen
   * before. A completed run's timings never change, so each run costs one
   * `gh run view` in its lifetime.
   */
  async function fetchAll() {
    const store = load();
    const b = await branch();
    const workflows = (await ghJson(['workflow', 'list', '--repo', repo, '--json', 'id,name,state']) || [])
      .filter((w) => w && w.state === 'active');
    let added = 0;
    try {
      for (const w of workflows) {
        const args = ['run', 'list', '--repo', repo, '--workflow', String(w.id), '--event', 'push',
          '--status', 'success', '--limit', String(FETCH_RUNS),
          '--json', 'databaseId,createdAt,headSha,displayTitle,url'];
        if (b) args.push('--branch', b);
        const runs = await ghJson(args) || [];
        for (const r of runs) {
          if (!r || !r.databaseId || store.runs[r.databaseId]) continue;
          let jobs;
          try {
            jobs = ((await ghJson(['run', 'view', String(r.databaseId), '--repo', repo, '--json', 'jobs'])) || {}).jobs || [];
          } catch (_) { continue; /* next refresh tries again */ }
          store.runs[r.databaseId] = {
            id: r.databaseId, workflow: w.name, createdAt: r.createdAt, sha: r.headSha,
            title: r.displayTitle, url: r.url, seconds: runnerSeconds(jobs), steps: stepSeconds(jobs),
          };
          added++;
        }
      }
    } finally {
      // Saved even when a later workflow's call fails, so the runs already
      // measured are not held only in memory.
      if (added) save(store);
    }
    return { workflows: workflows.map((w) => w.name), fetchedRuns: added };
  }

  const cache = createCache({ fetch: fetchAll, ttlFor: () => TTL_REFRESH, now });

  /** Per-workflow judgement for the CI/CD tab. Never blocks. */
  function get() {
    if (!enabled) return { configured: false, workflows: [] };
    const c = cache.get();
    const store = load();
    const names = new Set([...(c.value ? c.value.workflows : []), ...Object.values(store.runs).map((r) => r.workflow)]);
    const workflows = [];
    for (const name of names) {
      const runs = Object.values(store.runs).filter((r) => r.workflow === name);
      if (runs.length === 0) continue;
      const marker = store.markers[name] || null;
      const judged = applyWatch(evaluateBudget(runs, marker, budget), (store.watching || {})[name], budget);
      workflows.push({ name, marker, ...judged });
    }
    workflows.sort((a, b) => (b.medianSeconds || 0) - (a.medianSeconds || 0));
    return {
      configured: true,
      budget,
      workflows,
      fetchedAt: c.fetchedAt || null,
      loading: !!c.loading,
      error: c.error || null,
    };
  }

  /**
   * "Accept the new size": the flagged run becomes the first of a new baseline.
   * Throws when the workflow is not over budget, so a stale button cannot move
   * a marker the owner did not see.
   */
  function accept(workflow) {
    const w = get().workflows.find((x) => x.name === workflow);
    if (!w || !w.flag) throw new Error(`${workflow} is not over its runtime budget`);
    const store = load();
    setMarker(store, workflow, { at: w.flag.since.createdAt, reason: 'accepted', setAt: new Date(now()).toISOString() });
    save(store);
    return get();
  }

  /**
   * "Keep watching": quiet the notice at the size the owner has seen, without
   * moving the baseline. Throws when the workflow is not over budget.
   */
  function watch(workflow) {
    const w = get().workflows.find((x) => x.name === workflow);
    if (!w || !w.flag) throw new Error(`${workflow} is not over its runtime budget`);
    const store = load();
    if (!store.watching) store.watching = {};
    store.watching[workflow] = { sinceId: w.flag.since.id, seconds: w.flag.latestSeconds, at: new Date(now()).toISOString() };
    save(store);
    return get();
  }

  /** A marker from outside (the maintenance pass), applied to every workflow. */
  function markBaseline(at, reason) {
    const store = load();
    const names = setMarker(store, '*', { at, reason, setAt: new Date(now()).toISOString() });
    save(store);
    return names;
  }

  /** Monitor-tab rows: one per workflow over budget, unless it is being watched quietly. */
  function alerts() {
    if (!enabled) return [];
    return get().workflows.filter(needsNotice).map((w) => ({
      source: 'ci-runtime',
      kind: 'ci-runtime-over',
      project: (config && config.name) || 'project',
      id: `ci-runtime:${w.name}`,
      severity: 'low',
      title: `${w.name} CI is ${w.flag.overPct}% over its baseline`,
      detail: `${fmtDuration(w.flag.latestSeconds)} of runner time against ${fmtDuration(w.flag.baselineSeconds)}`
        + (w.flag.watching ? `, up ${fmtDuration(w.flag.watching.grownSeconds)} since you chose to keep watching` : '')
        + '. Open CI/CD to start a maintenance pass, keep watching, or accept the new size.',
      url: w.latest && w.latest.url,
      // The actions live in the CI/CD tab, not on GitHub, so the row links there.
      open: { fn: 'operations', tab: 'cicd', label: 'CI/CD' },
      since: w.flag.since.createdAt,
    }));
  }

  function prime() { if (enabled) cache.refresh(); }

  /** One stored run, with its step timings. */
  function run(id) {
    return load().runs[id] || null;
  }

  return { get, run, accept, watch, markBaseline, alerts, prime, refresh: () => cache.refresh(), enabled, storeFile: file };
}

function fmtDuration(secs) {
  const s = Math.round(secs || 0);
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}` : `${m} min`;
}

module.exports = {
  DEFAULT_BUDGET, KEEP_RUNS,
  runnerSeconds, stepSeconds, median, evaluateBudget, grownSteps, applyWatch, needsNotice,
  storePath, readStore, writeStore, setMarker,
  createCiRuntime, fmtDuration,
};
