/**
 * Reconcile tracks API (docs/plans/reconciliation-workflow.md, increment 2).
 *
 *   GET  /api/reconcile               → { tracks }
 *   GET  /api/reconcile/:id           → { track, intake }  (intake = the report's markdown)
 *   POST /api/reconcile/start         → 201 { track, recordId, commit }
 *        body: { sourcePath?, branch?, ref?, brief? }    one of sourcePath / ref
 *        409 { refused: true, markdown, status } when the source has uncommitted work
 *   POST /api/reconcile/:id/cancel    → { track }   body: { reason? }
 *
 * A track runs beside the workflow slot, so none of these touch the active
 * workflow, and a track can start while a run is in progress.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const tracks = require('../reconcile-track');

function createReconcileRouter(config) {
  const router = express.Router();
  const docsRel = String(config.docs_path || './docs').replace(/^\.\//, '').replace(/\/$/, '');

  router.get('/reconcile', (req, res) => {
    res.json({ tracks: tracks.listTracks(config.projectRoot) });
  });

  router.get('/reconcile/:id', (req, res) => {
    let track;
    try { track = tracks.loadTrack(config.projectRoot, req.params.id); } catch (err) { return res.status(400).json({ error: err.message }); }
    if (!track) return res.status(404).json({ error: `no reconcile track ${req.params.id}` });
    let intake = null;
    try { intake = fs.readFileSync(path.join(tracks.trackDir(config.projectRoot, track.id), 'intake.md'), 'utf8'); } catch (_) { /* not written yet */ }
    res.json({ track, intake });
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
