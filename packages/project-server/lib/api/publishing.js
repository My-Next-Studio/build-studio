'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const cp = require('../content-publish');

/**
 * The scheduler, the manual trigger and the read model for the Publishing tab.
 *
 * One publisher per project-server. It ticks on an interval and once shortly
 * after start — the start tick is the catch-up: a post whose date passed while
 * Build Studio was not running is published then, late rather than never.
 */
function createPublisher(config, deps = {}) {
  const projectRoot = config.projectRoot;
  const projectName = config.name || path.basename(projectRoot);
  const publish = deps.publishPost || cp.publishPost;
  const fetchStatus = deps.fetchStatus || headStatus;
  const now = deps.now || (() => new Date());

  let timer = null;
  let busy = false;           // one publish at a time — they all commit to one branch
  let lastTick = null;
  let lastDeferred = null;    // shown in the tab; deliberately not written to history
  const verify = new Map();   // post id -> { state, url, checkedAt, since }

  const cfg = () => cp.resolveConfig(config);

  function defaultBranch() {
    return new Promise((resolve) => {
      execFile('git', ['rev-parse', '--abbrev-ref', 'origin/HEAD'], { cwd: projectRoot }, (err, out) => {
        resolve(err ? 'main' : (String(out).trim().replace(/^origin\//, '') || 'main'));
      });
    });
  }

  async function publishOne(post, trigger) {
    const c = cfg();
    const result = await publish({
      projectRoot, statePath: config.statePath, logsPath: config.logsPath,
      defaultBranch: await defaultBranch(), cfg: c, post, trigger, now: now(),
    });
    if (result.state === 'deferred') lastDeferred = { at: now().toISOString(), id: post.id, reason: result.reason };
    else lastDeferred = null;
    if (result.ok && c.verify_url) startVerify(post.id, result.urls, c);
    return result;
  }

  async function tick(trigger = 'schedule') {
    const c = cfg();
    if (!c.enabled || busy) return { ran: false };
    busy = true;
    try {
      lastTick = now().toISOString();
      const due = cp.scanStaged(projectRoot, c.staged_dir).filter((p) => cp.isDue(p, now(), c.publish_time));
      const results = [];
      for (const post of due) {
        // A post whose last attempt FAILED is not retried by the timer. The
        // command may have half-published, and a loop that re-runs a broken
        // script every fifteen minutes buries the first, useful log under
        // dozens of identical ones. A failure waits for a person (or an agent
        // pointed at the log) and a manual retry.
        const last = cp.lastAttempts(cp.readHistory(config.statePath)).get(post.id);
        if (last && !last.ok) continue;
        const r = await publishOne(post, trigger);
        results.push(r);
        if (r.state === 'deferred') break;   // same branch for every post — no point asking again this tick
      }
      return { ran: true, results };
    } finally {
      busy = false;
    }
  }

  // ── is it actually live? ───────────────────────────────────────────────────
  //
  // `published` means pushed. Whether the site then built and deployed is a
  // different fact with a different owner, so it is checked afterwards and
  // surfaced as an alert rather than folded into the status.

  function startVerify(id, urls, c) {
    const list = Object.values(urls || {}).filter((u) => /^https?:\/\//.test(u));
    if (!list.length) return;
    const since = Date.now();
    verify.set(id, { state: 'pending', urls: list, since: new Date(since).toISOString(), checkedAt: null });
    const again = async () => {
      const codes = await Promise.all(list.map((u) => fetchStatus(u)));
      const ok = codes.every((s) => s >= 200 && s < 400);
      const expired = Date.now() - since > c.verify_timeout_minutes * 60 * 1000;
      verify.set(id, {
        state: ok ? 'live' : expired ? 'not-live' : 'pending',
        urls: list, codes, since: new Date(since).toISOString(), checkedAt: new Date().toISOString(),
      });
      if (!ok && !expired) setTimeout(again, 60 * 1000).unref?.();
    };
    setTimeout(again, 45 * 1000).unref?.();
  }

  // ── read model ─────────────────────────────────────────────────────────────

  function overview() {
    const c = cfg();
    const history = cp.readHistory(config.statePath);
    const last = cp.lastAttempts(history);
    // Scanned whether or not publishing is on: reading the queue is harmless,
    // and seeing it before enabling is the point of showing the tab while off.
    const posts = cp.scanStaged(projectRoot, c.staged_dir).map((p) => {
      const attempt = last.get(p.id) || null;
      const failing = !!(attempt && !attempt.ok && p.status === 'draft');
      return {
        ...p,
        state: p.status === 'published' ? 'published'
          : failing ? 'failed'
          : !p.publish_date ? 'unscheduled'
          : cp.isDue(p, now(), c.publish_time) ? 'due' : 'scheduled',
        lastAttempt: attempt,
        verify: verify.get(p.id) || null,
      };
    });
    return {
      enabled: c.enabled,
      configured: !!c.command,
      config: { staged_dir: c.staged_dir, command: c.command, publish_time: c.publish_time, check_interval_minutes: c.check_interval_minutes },
      busy, lastTick, deferred: lastDeferred,
      posts, history,
    };
  }

  /** Derived, never stored — a fixed post simply stops alerting. */
  function alerts() {
    const o = overview();
    const out = [];
    for (const p of o.posts) {
      if (p.state === 'failed') {
        out.push({
          source: 'publishing', kind: 'publish-failed', project: projectName, id: `publishing:failed:${p.id}`,
          severity: 'high', title: `Publishing failed: ${p.title || p.id}`,
          detail: `${p.lastAttempt.reason}${p.lastAttempt.logFile ? ` — log: ${p.lastAttempt.logFile}` : ''}`
            + ((p.lastAttempt.dirtyPaths || []).length
              ? ` — it left ${p.lastAttempt.dirtyPaths.length} uncommitted path(s) in the working tree, which will block the next execution run until cleaned up`
              : ''),
          url: null, since: p.lastAttempt.at,
        });
      }
      if (p.verify && p.verify.state === 'not-live') {
        out.push({
          source: 'publishing', kind: 'not-live', project: projectName, id: `publishing:not-live:${p.id}`,
          severity: 'high', title: `Published but not live: ${p.title || p.id}`,
          detail: `Pushed, but ${p.verify.urls.join(', ')} did not answer within the verification window — the site build may have failed`,
          url: p.verify.urls[0], since: p.verify.since,
        });
      }
    }
    return out;
  }

  // A one-minute heartbeat that decides for itself, rather than an interval
  // fixed at start: config is hot-reloaded, so a project that turns publishing
  // on — or changes its interval — must not need a restart to be believed.
  function start() {
    stop();
    const startedAt = Date.now();
    timer = setInterval(() => {
      const c = cfg();
      if (!c.enabled) return;
      const since = lastTick ? Date.now() - Date.parse(lastTick) : Infinity;
      // The first tick waits a moment after boot; it is the catch-up for dates
      // that passed while Build Studio was not running.
      if (!lastTick && Date.now() - startedAt < 20 * 1000) return;
      if (since >= Math.max(1, c.check_interval_minutes) * 60 * 1000) tick(lastTick ? 'schedule' : 'startup').catch(() => {});
    }, 60 * 1000);
    timer.unref?.();
    if (cfg().enabled) console.log(`[publishing] enabled for ${projectName} — staged in ${cfg().staged_dir}`);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, publishOne, overview, alerts, isBusy: () => busy };
}

function headStatus(url) {
  return new Promise((resolve) => {
    execFile('curl', ['-s', '-o', '/dev/null', '-L', '-m', '20', '-w', '%{http_code}', url], (err, out) => {
      resolve(err ? 0 : parseInt(String(out).trim(), 10) || 0);
    });
  });
}

function createPublishingRouter(config, publisher) {
  const router = express.Router();

  router.get('/publishing', (req, res) => res.json(publisher.overview()));

  // Manual publish: a post with no date, or one you want out before its date.
  // Also the ONLY way a failed post is retried — see tick().
  router.post('/publishing/publish', async (req, res) => {
    const id = String((req.body && req.body.id) || '').trim();
    const c = cp.resolveConfig(config);
    if (!c.enabled) return res.status(409).json({ error: 'content_publishing is not enabled for this project' });
    if (!id) return res.status(400).json({ error: 'id is required' });
    if (publisher.isBusy()) return res.status(409).json({ error: 'a publish is already in progress' });
    const post = cp.scanStaged(config.projectRoot, c.staged_dir).find((p) => p.id === id);
    if (!post) return res.status(404).json({ error: `no staged post "${id}"` });
    if (post.status === 'published') return res.status(409).json({ error: `"${id}" is already published` });
    const result = await publisher.publishOne(post, 'manual');
    res.status(result.ok ? 200 : 502).json(result);
  });

  router.get('/publishing/log', (req, res) => {
    const file = String(req.query.file || '');
    // Only logs this feature wrote, only from the logs directory.
    if (!config.logsPath || path.dirname(file) !== config.logsPath || !/^publish-.*\.log$/.test(path.basename(file))) {
      return res.status(400).json({ error: 'not a publish log' });
    }
    try { res.type('text/plain').send(fs.readFileSync(file, 'utf8')); }
    catch (_) { res.status(404).json({ error: 'log not found' }); }
  });

  return router;
}

module.exports = { createPublisher, createPublishingRouter };
