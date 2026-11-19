'use strict';

/**
 * Operations → Tests: test-suite health. See lib/suite-watch.js for what is
 * measured and judged, and docs/plans/local-suite-watch.md for why.
 *
 *   GET  /ops/suite                 → every series judged, recurring flaky tests, the review
 *   POST /ops/suite/accept          → { key }: a new baseline for that series
 *   POST /ops/suite/watch           → { key, metric }: keep watching from the size seen
 *   POST /ops/suite/review          → { reason, focus? }: start the review agent
 *   POST /ops/suite/review/skip     → count the stories from now without a review
 *
 * Ticks every minute: counts test code when the branch has moved, and moves a
 * review forward (agent → backlog Task → its PRD merged → new baselines).
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const sw = require('../suite-watch');
const nl = require('../nightly');
const { composeReviewPrompt } = require('../suite-review');
const backlog = require('../backlog');
const { scopedCommit: defaultScopedCommit } = require('../scoped-commit');
const { runOneShot: defaultRunOneShot, getOneShotStatus: defaultGetOneShotStatus } = require('../oneshot');

const TICK_MS = 60 * 1000;
const REVIEW_MAX_DURATION_MS = 40 * 60 * 1000;
const MERGED = ['Implemented', 'Done'];

function createSuiteWatch(config, deps = {}) {
  const runOneShot = deps.runOneShot || defaultRunOneShot;
  const getOneShotStatus = deps.getOneShotStatus || defaultGetOneShotStatus;
  const createItem = deps.createItem || backlog.createItem;
  const readItem = deps.readItem || backlog.readItem;
  const scopedCommit = deps.scopedCommit || defaultScopedCommit;
  const now = deps.now || (() => Date.now());
  const git = deps.git || ((args) => execFileSync('git', args, {
    cwd: config.projectRoot, encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const storeFile = deps.storeFile || sw.storePath(config.projectRoot);
  const docsPath = () => config.docs_path || './docs';
  const iso = () => new Date(now()).toISOString();
  const rel = (p) => path.relative(config.projectRoot, p) || '.';

  const settings = () => sw.suiteWatchConfig(config);
  const load = () => sw.readStore(storeFile);
  const save = (s) => sw.writeStore(storeFile, s);

  /** The review count starts when the watch is first seen, not at the project's first story. */
  function loadSeeded() {
    const s = load();
    if (!s.review.since) {
      s.review = { ...s.review, since: iso() };
      save(s);
    }
    return s;
  }

  function nightlyRuns() {
    const n = nl.nightlyConfig(config);
    return n ? { runs: nl.readRuns(n.statusDir), label: n.label, dir: n.statusDir } : { runs: [], label: 'Nightly', dir: null };
  }

  function evaluate(cfg, store) {
    const nightly = nightlyRuns();
    const series = sw.buildSeries({
      gateRuns: sw.readGateHistory(cfg.gateHistory),
      nightlyRuns: nightly.runs,
      nightlyLabel: nightly.label,
      codeSamples: store.code,
    });
    const evaluated = sw.evaluateSeries(series, store, cfg);
    const flaky = sw.recurringFlaky(nightly.runs, nl.testKey);
    const stories = sw.storiesSince(sw.readScorecard(path.join(config.statePath || path.join(config.projectRoot, '.build-studio'), 'scorecard.jsonl')), store.review.since);
    const pass = store.review.pass || null;
    const passOpen = !!pass && ['running', 'filed'].includes(pass.state);
    const review = {
      every: cfg.reviewEvery,
      since: store.review.since,
      stories,
      due: cfg.reviewEvery > 0 && stories.length >= cfg.reviewEvery && !passOpen,
      pass,
    };
    return { evaluated, flaky, review, nightly };
  }

  function snapshot() {
    const cfg = settings();
    if (!cfg) return { configured: false };
    const store = loadSeeded();
    const { evaluated, flaky, review } = evaluate(cfg, store);
    return {
      configured: true,
      branch: cfg.branch,
      testPaths: cfg.testPaths,
      gateHistory: cfg.gateHistory ? rel(cfg.gateHistory) : null,
      gateHistoryFound: !!cfg.gateHistory && fs.existsSync(cfg.gateHistory),
      series: evaluated,
      flaky,
      review,
      budget: cfg.budget,
    };
  }

  // ── test code ────────────────────────────────────────────────────────────

  /** Count test code on the branch when it has moved since the last count. */
  function sampleCode(cfg, store) {
    if (!cfg.testPaths.length) return false;
    let head;
    try { head = git(['rev-parse', '--verify', '--quiet', `refs/heads/${cfg.branch}`]).trim(); } catch (_) { return false; }
    if (!head) return false;
    const last = store.code[store.code.length - 1];
    if (last && last.head === head && last.paths === cfg.testPaths.join('\n')) return false;
    let out = '';
    try {
      out = git(['grep', '-I', '-c', '-e', '', head, '--', ...cfg.testPaths]);
    } catch (e) {
      // Exit 1 is "no match": no test files under those paths.
      if (e.status !== 1) { console.warn(`[suite-watch] counting test code failed: ${e.message}`); return false; }
    }
    const counted = sw.countLines(out, head, cfg.testPaths);
    store.code.push({ head, at: iso(), paths: cfg.testPaths.join('\n'), ...counted });
    return true;
  }

  // ── the review ───────────────────────────────────────────────────────────

  function startReview({ reason = 'due', focus = null } = {}) {
    const cfg = settings();
    if (!cfg) throw Object.assign(new Error('suite_watch is not configured for this project'), { status: 400 });
    const store = loadSeeded();
    const cur = store.review.pass;
    if (cur && cur.state === 'running') throw Object.assign(new Error('A review is already running.'), { status: 409 });
    if (cur && cur.state === 'filed') {
      throw Object.assign(new Error(`The last review is filed as ${cur.itemId}. Draft and build that one first.`), { status: 409 });
    }
    // Analysed but not filed (a backlog error): file what is on disk rather than analyse again.
    if (cur && cur.state === 'error' && cur.resultFile && fs.existsSync(cur.resultFile)) {
      const { error: _e, ...rest } = cur;
      store.review.pass = { ...rest, state: 'running' };
      save(store);
      return store.review.pass;
    }
    const { evaluated, flaky, review, nightly } = evaluate(cfg, store);
    const resultDir = path.join(config.projectRoot, 'tmp', 'suite-review');
    fs.mkdirSync(resultDir, { recursive: true });
    const resultFile = path.join(resultDir, `${crypto.randomBytes(8).toString('hex')}.json`);
    let started;
    try {
      started = runOneShot({
        projectRoot: config.projectRoot,
        prompt: composeReviewPrompt({
          reason, focus, evaluated, flaky, stories: review.stories, resultFile,
          where: { testPaths: cfg.testPaths, gateHistory: cfg.gateHistory ? rel(cfg.gateHistory) : null, nightlyDir: nightly.dir ? rel(nightly.dir) : null },
        }),
        label: 'suite-review',
        maxDurationMs: REVIEW_MAX_DURATION_MS,
        agentDefaults: config.agent_defaults,
      });
    } catch (e) {
      if (e.code === 'CONFLICT') throw Object.assign(new Error('Another one-shot agent is running in this project. Try again when it finishes.'), { status: 409 });
      throw e;
    }
    store.review.pass = { state: 'running', reason, focus, runId: started.runId, sessionName: started.sessionName, resultFile, startedAt: iso(), stories: review.stories.length };
    save(store);
    return store.review.pass;
  }

  async function fileReview(store) {
    const cur = store.review.pass;
    let r;
    try { r = JSON.parse(fs.readFileSync(cur.resultFile, 'utf8')); } catch (e) {
      store.review.pass = { ...cur, state: 'error', error: `the review left no readable result (${e.message})` };
      return save(store);
    }
    const intro = `Filed by a test-suite review on ${cur.startedAt.slice(0, 10)}`
      + (cur.reason === 'growth' ? `, started from a growth notice${cur.focus ? ` on ${cur.focus}` : ''}.` : `, after ${cur.stories} stories since the previous one.`)
      + ' When this item reaches Implemented, Build Studio restarts the baselines of every measured suite and the story count.';
    const title = String(r.title || 'Test suite: overlap review').slice(0, 120);
    let created;
    try {
      created = createItem(config.projectRoot, docsPath(), {
        title, type: 'Task', body: `${intro}\n\n${r.summary ? `${r.summary}\n\n` : ''}${r.body || ''}`,
        config, ...backlog.topOfBacklog(config.projectRoot, docsPath(), 'Maintenance'),
      });
    } catch (e) {
      store.review.pass = { ...cur, state: 'error', error: `could not file the backlog item: ${e.message}` };
      return save(store);
    }
    if (fs.existsSync(path.join(config.projectRoot, '.git'))) {
      const c = await scopedCommit(config.projectRoot, [
        rel(backlog.itemFilePath(config.projectRoot, docsPath(), created.id)),
        rel(backlog.backlogIndexPath(config.projectRoot, docsPath())),
      ], `docs(${created.id}): add test-suite review to the backlog`);
      if (!c.committed) console.warn(`[suite-watch] ${created.id} filed but not committed: ${c.reason}`);
    }
    try { fs.unlinkSync(cur.resultFile); } catch (_) { /* gone */ }
    console.log(`[suite-watch] filed ${created.id}`);
    store.review.pass = { ...cur, state: 'filed', itemId: created.id, title, filedAt: iso() };
    return save(store);
  }

  /** A merged review resets every baseline, and the story count. */
  function markAll(store, reason) {
    const cfg = settings();
    const keys = cfg ? evaluate(cfg, store).evaluated.map((s) => s.key) : [];
    const at = iso();
    for (const k of keys) store.markers[k] = { at, reason };
    store.watching = {};
    store.review.since = at;
  }

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const cfg = settings();
      if (!cfg) return;
      const store = loadSeeded();
      let dirty = sampleCode(cfg, store);
      const cur = store.review.pass;
      if (cur && cur.state === 'running') {
        const entry = getOneShotStatus(cur.runId);
        if (!(entry && entry.state === 'running')) {
          if (entry && (entry.state === 'error' || entry.state === 'timeout')) {
            store.review.pass = { ...cur, state: 'error', error: entry.state === 'timeout' ? 'the review timed out' : String(entry.stderr || 'the review failed').slice(0, 300) };
          } else if (fs.existsSync(cur.resultFile)) {
            await fileReview(store);
            return;
          } else {
            store.review.pass = { ...cur, state: entry ? 'error' : 'lost', error: entry ? 'the review finished without writing a result' : 'the review did not survive a restart' };
          }
          dirty = true;
        }
      } else if (cur && cur.state === 'filed') {
        let item = null;
        try { item = readItem(config.projectRoot, docsPath(), cur.itemId); } catch (_) { item = null; }
        if (!item) {
          store.review.pass = { ...cur, state: 'error', error: `${cur.itemId} is no longer in the backlog` };
          dirty = true;
        } else if (MERGED.includes(item.status)) {
          markAll(store, 'review');
          store.review.pass = { ...cur, state: 'done', doneAt: iso() };
          console.log(`[suite-watch] ${cur.itemId} is ${item.status}: baselines and story count restarted`);
          dirty = true;
        }
      }
      if (dirty) save(store);
    } catch (e) {
      console.warn(`[suite-watch] tick failed: ${e.message}`);
    } finally {
      ticking = false;
    }
  }

  let timer = null;
  function startTicking() {
    if (timer) return;
    timer = setInterval(() => { tick(); }, TICK_MS);
    if (timer.unref) timer.unref();
    tick();
  }
  function stopTicking() { if (timer) clearInterval(timer); timer = null; }

  function alerts() {
    const cfg = settings();
    if (!cfg) return [];
    try {
      const { evaluated, flaky, review } = evaluate(cfg, load());
      return sw.deriveAlerts({ evaluated, flaky, review, project: config.name || 'project' });
    } catch (_) {
      return [];
    }
  }

  // ── routes ───────────────────────────────────────────────────────────────

  const router = express.Router();
  const fail = (res, e) => res.status(e.status || 500).json({ error: e.message });
  const notConfigured = (res) => res.status(400).json({ error: 'suite_watch is not configured for this project' });

  router.get('/ops/suite', (req, res) => {
    try { res.json(snapshot()); } catch (e) { fail(res, e); }
  });

  router.post('/ops/suite/accept', (req, res) => {
    if (!settings()) return notConfigured(res);
    const key = String((req.body && req.body.key) || '');
    const store = load();
    if (!snapshot().series.some((s) => s.key === key)) return res.status(404).json({ error: `no series ${key}` });
    store.markers[key] = { at: iso(), reason: 'accepted' };
    for (const k of Object.keys(store.watching)) if (k.startsWith(`${key}|`)) delete store.watching[k];
    save(store);
    res.json(snapshot());
  });

  router.post('/ops/suite/watch', (req, res) => {
    if (!settings()) return notConfigured(res);
    const key = String((req.body && req.body.key) || '');
    const metric = String((req.body && req.body.metric) || '');
    const series = snapshot().series.find((s) => s.key === key);
    const m = series && series.metrics[metric];
    if (!m || !m.flag) return res.status(409).json({ error: 'That metric is not over budget.' });
    const store = load();
    store.watching[`${key}|${metric}`] = { sinceId: m.flag.since.id, seconds: m.flag.latest, at: iso() };
    save(store);
    res.json(snapshot());
  });

  router.post('/ops/suite/review', (req, res) => {
    const body = req.body || {};
    try {
      startReview({ reason: body.reason === 'growth' ? 'growth' : 'due', focus: typeof body.focus === 'string' ? body.focus.slice(0, 120) : null });
    } catch (e) {
      return fail(res, e);
    }
    res.json(snapshot());
  });

  router.post('/ops/suite/review/skip', (req, res) => {
    if (!settings()) return notConfigured(res);
    const store = loadSeeded();
    if (store.review.pass && ['running', 'filed'].includes(store.review.pass.state)) {
      return res.status(409).json({ error: 'A review is under way; it restarts the count when its item is implemented.' });
    }
    store.review.since = iso();
    save(store);
    res.json(snapshot());
  });

  return { router, tick, startTicking, stopTicking, alerts, snapshot };
}

module.exports = { createSuiteWatch };
