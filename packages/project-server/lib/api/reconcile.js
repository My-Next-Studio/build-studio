/**
 * Reconcile tracks API (docs/plans/reconciliation-workflow.md, increment 2).
 *
 *   GET  /api/reconcile               → { tracks }
 *   GET  /api/reconcile/:id           → { track, intake }  (intake = the report's markdown)
 *   POST /api/reconcile/start         → 201 { track, recordId, commit }
 *        body: { sourcePath?, branch?, ref?, brief? }    one of sourcePath / ref
 *        409 { refused: true, markdown, status } when the source has uncommitted work
 *   POST /api/reconcile/:id/cancel    → { track }   body: { reason? }
 *   POST /api/reconcile/:id/session/:step → { track }  body: { action: launch | end | finish }
 *        for the interactive steps intent_interview and owner_decision
 *   POST /api/reconcile/:id/items     → 201 { id, release, commit }
 *        a backlog item filed on the track's integration branch (createItem's body)
 *   POST /api/reconcile/:id/integrate → { track }  body: { action: run | continue | abort }
 *        builds reconcile/<id> with one import commit; a conflict leaves the
 *        step at `conflict` with the paths, for `continue` once resolved
 *   POST /api/reconcile/:id/step/:step → { track }  body: { action: launch | complete }
 *        the agent steps align, team_review and apply; `complete` closes a step
 *        by hand (an agent that will not report)
 *   POST /api/reconcile/:id/feedback  → { ok, track }  body: { role, step, feedback }
 *        where the track's agents report, as workflow agents do to /workflow/feedback
 *
 * A track runs beside the workflow slot, so none of these touch the active
 * workflow, and a track can start while a run is in progress.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const tracks = require('../reconcile-track');
const sessions = require('../reconcile-sessions');
const integration = require('../reconcile-integration');
const agentSteps = require('../reconcile-agents');

/**
 * @param {object} [deps]
 * @param {Function} [deps.launchAgents]  the workflow router's agent launcher
 */
function createReconcileRouter(config, tmuxOps = null, deps = {}) {
  const router = express.Router();
  const docsRel = String(config.docs_path || './docs').replace(/^\.\//, '').replace(/\/$/, '');

  function load(req, res) {
    let track;
    try { track = tracks.loadTrack(config.projectRoot, req.params.id); } catch (err) { res.status(400).json({ error: err.message }); return null; }
    if (!track) { res.status(404).json({ error: `no reconcile track ${req.params.id}` }); return null; }
    return track;
  }

  router.get('/reconcile', (req, res) => {
    res.json({ tracks: tracks.listTracks(config.projectRoot) });
  });

  router.get('/reconcile/:id', (req, res) => {
    const track = load(req, res);
    if (!track) return;
    let intake = null;
    try { intake = fs.readFileSync(path.join(tracks.trackDir(config.projectRoot, track.id), 'intake.md'), 'utf8'); } catch (_) { /* not written yet */ }
    // Whether each interactive step's agent is still running, for the hub's
    // Start / Resume / Finish buttons.
    const live = {};
    if (tmuxOps) for (const k of Object.keys(sessions.KINDS)) live[k] = sessions.live(track, k, tmuxOps);
    res.json({ track, intake, live });
  });

  router.post('/reconcile/:id/session/:step', async (req, res) => {
    const track = load(req, res);
    if (!track) return;
    const stepKey = req.params.step;
    const action = (req.body && req.body.action) || '';
    if (!sessions.KINDS[stepKey]) return res.status(400).json({ error: `${stepKey} is not an interactive step` });
    if (track.status !== tracks.OPEN) return res.status(409).json({ error: `track ${track.id} is ${track.status}` });
    if (!tmuxOps) return res.status(503).json({ error: 'no tmux available' });
    try {
      if (action === 'launch') return res.json({ track: sessions.launch({ config, tmuxOps, track, stepKey }) });
      if (action === 'end') return res.json({ track: sessions.end({ config, tmuxOps, track, stepKey }) });
      if (action === 'finish') return res.json({ track: await sessions.finish({ config, tmuxOps, track, stepKey, docsRel }) });
      return res.status(400).json({ error: 'action must be launch, end or finish' });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  });

  router.post('/reconcile/:id/integrate', (req, res) => {
    const track = load(req, res);
    if (!track) return;
    const action = (req.body && req.body.action) || 'run';
    try {
      const args = { projectRoot: config.projectRoot, docsRel, id: track.id };
      if (action === 'run') return res.json({ track: integration.integrate(args) });
      if (action === 'continue') return res.json({ track: integration.continueIntegration(args) });
      if (action === 'abort') return res.json({ track: integration.abortIntegration(args) });
      return res.status(400).json({ error: 'action must be run, continue or abort' });
    } catch (err) {
      return res.status(409).json({ error: (err.stderr && String(err.stderr).trim()) || err.message });
    }
  });

  router.post('/reconcile/:id/step/:step', (req, res) => {
    const track = load(req, res);
    if (!track) return;
    const stepKey = req.params.step;
    const action = (req.body && req.body.action) || 'launch';
    if (!agentSteps.AGENT_STEPS[stepKey]) return res.status(400).json({ error: `${stepKey} is not an agent step` });
    if (track.status !== tracks.OPEN) return res.status(409).json({ error: `track ${track.id} is ${track.status}` });
    try {
      if (action === 'launch') {
        if (!deps.launchAgents) return res.status(503).json({ error: 'the agent launcher is not available' });
        return res.json({ track: agentSteps.launchStep({ config, track, stepKey, launchAgents: deps.launchAgents }) });
      }
      if (action === 'complete') return res.json({ track: agentSteps.completeStep({ config, track, stepKey }) });
      return res.status(400).json({ error: 'action must be launch or complete' });
    } catch (err) {
      return res.status(409).json({ error: (err.stderr && String(err.stderr).trim()) || err.message });
    }
  });

  router.post('/reconcile/:id/feedback', (req, res) => {
    const b = req.body || {};
    if (!b.role || !b.step) return res.status(400).json({ error: 'role and step are required' });
    try {
      const track = agentSteps.recordFeedback({ config, id: req.params.id, role: b.role, step: b.step, feedback: b.feedback });
      return res.json({ ok: true, track });
    } catch (err) {
      return res.status(409).json({ error: err.message });
    }
  });

  router.post('/reconcile/:id/items', async (req, res) => {
    const b = req.body || {};
    try {
      const created = await tracks.fileItemOnBranch({
        projectRoot: config.projectRoot,
        docsRel,
        config,
        id: req.params.id,
        item: {
          title: b.title,
          type: b.type || 'Task',
          body: String(b.body || ''),
          depends_on: b.depends_on || [],
          release: b.release || null,
          after: b.after || null,
          before: b.before || null,
        },
      });
      res.status(201).json({ id: created.id, release: created.release, commit: created.commit });
    } catch (err) {
      res.status(/no reconcile track/.test(err.message) ? 404 : 400).json({ error: err.message });
    }
  });

  router.post('/reconcile/start', async (req, res) => {
    const b = req.body || {};
    const sourcePath = typeof b.sourcePath === 'string' && b.sourcePath.trim() ? b.sourcePath.trim() : null;
    const ref = typeof b.ref === 'string' && b.ref.trim() ? b.ref.trim() : null;
    if (!sourcePath && !ref) return res.status(400).json({ error: 'sourcePath (a clone or worktree) or ref (a branch or commit in this repository) is required' });
    if (sourcePath && ref) return res.status(400).json({ error: 'give either sourcePath or ref, not both' });
    if (sourcePath && !fs.existsSync(sourcePath)) return res.status(400).json({ error: `no such folder: ${sourcePath}` });
    try {
      const r = await tracks.startTrack({
        projectRoot: config.projectRoot,
        docsRel,
        config,
        sourcePath,
        ref,
        branch: typeof b.branch === 'string' && b.branch.trim() ? b.branch.trim() : null,
        brief: typeof b.brief === 'string' && b.brief.trim() ? b.brief.trim() : null,
      });
      if (r.refused) return res.status(409).json({ refused: true, markdown: r.markdown, status: r.inventory.status });
      return res.status(201).json({ track: r.track, recordId: r.recordId, commit: r.commit });
    } catch (err) {
      const msg = (err.stderr && String(err.stderr).trim()) || err.message;
      return res.status(400).json({ error: msg });
    }
  });

  router.post('/reconcile/:id/cancel', (req, res) => {
    try {
      const track = tracks.cancelTrack(config.projectRoot, req.params.id, (req.body && req.body.reason) || null);
      res.json({ track });
    } catch (err) {
      res.status(/no reconcile track/.test(err.message) ? 404 : 400).json({ error: err.message });
    }
  });

  return router;
}

module.exports = { createReconcileRouter };
