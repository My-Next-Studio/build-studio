'use strict';

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { readItem, isValidId } = require('../backlog');
const { deriveNeedsAttention } = require('../needs-attention');
const { ensureIgnoreRule } = require('../ignore-rule');
const { scopedCommit } = require('../scoped-commit');
const wq = require('../work-queue');
const { projectOverview } = require('../project-overview');
const { execFileSync } = require('child_process');

/**
 * The work queue's routes (lib/work-queue.js holds the model; the plan is
 * docs/plans/work-queue-and-remote-overview.md).
 *
 * Reading changes no project file: items are read as stored, never through
 * the backlog GET route's write path. Starting goes through the existing start
 * functions (the workflow router's startWorkflow, the Draft route), which
 * re-check everything and link the started run back to its entry.
 */
function createWorkQueueRouter(config, { state, workflowRouter, draftingRouter, broadcast = () => {} }) {
  const router = express.Router();
  const { projectRoot, statePath } = config;
  const docsRel = config.docs_path || './docs';

  const item = (id) => { try { return readItem(projectRoot, docsRel, id); } catch (_) { return null; } };
  const brief = (it) => it && { id: it.id, title: it.title || '', type: it.type || null, status: it.status || null, prd: it.prd || null };

  /** Would this entry start now, and as what? The start's own checks, nothing started. */
  function readiness(entry, explicitAction) {
    const it = item(entry.item);
    const next = wq.nextAction(it, explicitAction || entry.action);
    if (!next.action) return { ready: false, action: null, reason: next.reason };
    const r = next.action === 'draft'
      ? draftingRouter.draftReadiness(entry.item)
      : workflowRouter.workflowReadiness({ type: wq.WORKFLOW_TYPE[next.action], input: entry.item });
    return r.status === 200
      ? { ready: true, action: next.action, ...r.json }
      : { ready: false, action: next.action, reason: r.json.error, status: r.status,
        ...(r.json.canOverride ? { canOverride: true } : {}) };
  }

  function view() {
    const queue = wq.loadQueue(statePath);
    const wf = state.loadWorkflow();
    let current = null;
    if (queue.current) {
      const it = item(queue.current.item);
      current = {
        ...queue.current,
        itemInfo: brief(it),
        status: wq.currentState(queue.current, {
          wf, item: it, needsAttention: wf ? deriveNeedsAttention(wf) : null,
          draft: draftingRouter.draftSession(),
        }),
      };
    }
    const pending = queue.pending.map((e) => ({ ...e, itemInfo: brief(item(e.item)) }));
    // Work running that the queue did not start, and no entry took.
    const linked = current && current.run && current.run.kind === 'workflow' && wf && current.run.id === wf.id;
    const outside = wf && !linked
      ? { kind: 'workflow', id: wf.id, type: wf.type, item: wf.itemId || null, step: wf.currentStep }
      : null;
    return {
      observedAt: new Date().toISOString(),
      current,
      outsideQueue: outside,
      pending,
      next: pending[0] ? { entryId: pending[0].id, item: pending[0].item, title: pending[0].itemInfo ? pending[0].itemInfo.title : null, ...readiness(pending[0]) } : null,
    };
  }

  // The queue file is local state. Ignore it before it is first written, and
  // commit the rule (scoped to .gitignore), as drafting does for its state file.
  async function ensureIgnored() {
    try {
      if (ensureIgnoreRule(projectRoot, wq.IGNORE_RULE) && fs.existsSync(path.join(projectRoot, '.git'))) {
        const r = await scopedCommit(projectRoot, ['.gitignore'], 'chore: gitignore the work queue');
        if (!r.committed) console.warn(`[work-queue] .gitignore not committed: ${r.reason}`);
      }
    } catch (e) {
      console.warn(`[work-queue] could not update .gitignore: ${e.message}`);
    }
  }

  const changed = (res, extra = {}) => {
    broadcast('work-queue-updated', {});
    res.json({ ...view(), ...extra });
  };

  router.get('/work-queue', (req, res) => res.json(view()));

  // This project's block of the cross-project overview (the hub's
  // GET /api/overview gathers them). Read-only: state files and git log.
  function lastCommit() {
    try {
      const [sha, at, ...subject] = execFileSync('git', ['log', '-1', '--format=%h%x09%cI%x09%s'], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\t');
      return sha ? { sha, at, subject: subject.join('\t') } : null;
    } catch (_) { return null; }
  }
  router.get('/overview', (req, res) => {
    res.json(projectOverview({
      name: config.name, wf: state.loadWorkflow(), queue: view(), draft: draftingRouter.draftSession(), lastCommit: lastCommit(),
    }));
  });

  router.post('/work-queue', async (req, res) => {
    const id = String((req.body && req.body.item) || '').trim().toUpperCase();
    const action = req.body && req.body.action;
    if (!isValidId(id)) return res.status(400).json({ error: 'item must be a backlog id, e.g. EX-012' });
    if (action !== undefined && action !== null && !wq.ACTIONS.includes(action)) {
      return res.status(400).json({ error: `action must be one of ${wq.ACTIONS.join(', ')}, or omitted to follow the item's status` });
    }
    if (!item(id)) return res.status(404).json({ error: `no backlog item ${id}` });
    await ensureIgnored();
    const queue = wq.loadQueue(statePath);
    const entry = wq.newEntry({ item: id, action: action || null, note: (req.body && req.body.note) || null });
    queue.pending = wq.insertAt(queue.pending, entry, req.body && req.body.position);
    wq.saveQueue(statePath, queue);
    res.status(201);
    changed(res, { added: entry });
  });

  router.patch('/work-queue/:id', (req, res) => {
    const queue = wq.loadQueue(statePath);
    const index = queue.pending.findIndex((e) => e.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: 'no pending entry with that id' });
    const body = req.body || {};
    if (body.action !== undefined && body.action !== null && !wq.ACTIONS.includes(body.action)) {
      return res.status(400).json({ error: `action must be one of ${wq.ACTIONS.join(', ')}, or null to follow the item's status` });
    }
    const entry = { ...queue.pending[index] };
    if (body.action !== undefined) { if (body.action) entry.action = body.action; else delete entry.action; }
    if (body.note !== undefined) { if (body.note) entry.note = String(body.note); else delete entry.note; }
    queue.pending[index] = entry;
    if (body.position !== undefined) queue.pending = wq.moveTo(queue.pending, entry.id, body.position);
    wq.saveQueue(statePath, queue);
    changed(res);
  });

  // Removing an entry never cancels work and never touches its backlog item.
  // The current entry can be cleared too: its run carries on unaffected.
  router.delete('/work-queue/:id', (req, res) => {
    const queue = wq.loadQueue(statePath);
    if (queue.current && queue.current.id === req.params.id) {
      queue.current = null;
    } else {
      const before = queue.pending.length;
      queue.pending = queue.pending.filter((e) => e.id !== req.params.id);
      if (queue.pending.length === before) return res.status(404).json({ error: 'no entry with that id' });
    }
    wq.saveQueue(statePath, queue);
    changed(res);
  });

  router.get('/work-queue/:id/readiness', (req, res) => {
    const entry = wq.loadQueue(statePath).pending.find((e) => e.id === req.params.id);
    if (!entry) return res.status(404).json({ error: 'no pending entry with that id' });
    res.json({ entryId: entry.id, item: entry.item, ...readiness(entry, req.query.action) });
  });

  // Starting re-runs every check through the real start. Repeating a start
  // that already happened returns that run instead of making a second one.
  const starting = new Set();
  router.post('/work-queue/:id/start', async (req, res) => {
    const id = req.params.id;
    const queue = wq.loadQueue(statePath);
    if (queue.current && queue.current.id === id) return res.json({ alreadyStarted: true, ...view() });
    if (starting.has(id)) return res.status(409).json({ error: 'that entry is starting already' });
    const entry = queue.pending.find((e) => e.id === id);
    if (!entry) return res.status(404).json({ error: 'no pending entry with that id' });
    const body = req.body || {};
    if (body.action && !wq.ACTIONS.includes(body.action)) {
      return res.status(400).json({ error: `action must be one of ${wq.ACTIONS.join(', ')}` });
    }
    const next = wq.nextAction(item(entry.item), body.action || entry.action);
    if (!next.action) return res.status(409).json({ error: `Cannot start ${entry.item}: ${next.reason}.` });

    starting.add(id);
    try {
      let r;
      if (next.action === 'draft') {
        r = await postSelf('/api/draft/start', { itemId: entry.item, queueEntryId: id });
      } else {
        r = workflowRouter.startWorkflow({
          type: wq.WORKFLOW_TYPE[next.action], input: entry.item, queueEntryId: id,
          ...(body.override === true ? { override: true } : {}),
        });
      }
      if (r.status >= 400) return res.status(r.status).json({ ...r.json, action: next.action });
      broadcast('work-queue-updated', {});
      res.json({ started: { action: next.action, ...r.json }, ...view() });
    } finally {
      starting.delete(id);
    }
  });

  // Draft's start answers through its own response (it launches in tmux), so
  // the queue calls it over this server's own port, as auto-advance does.
  function postSelf(urlPath, payload) {
    return new Promise((resolve) => {
      const data = Buffer.from(JSON.stringify(payload));
      const req = http.request({ hostname: '127.0.0.1', port: config.port, path: urlPath, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          let json = {};
          try { json = raw ? JSON.parse(raw) : {}; } catch (_) { json = { error: raw }; }
          resolve({ status: res.statusCode, json });
        });
      });
      req.on('error', (e) => resolve({ status: 502, json: { error: `could not reach the draft start: ${e.message}` } }));
      req.end(data);
    });
  }

  return router;
}

module.exports = { createWorkQueueRouter };
