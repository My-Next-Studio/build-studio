'use strict';

const express = require('express');

/**
 * CI runtime per workflow, and the two actions on a drift notice.
 * See lib/ci-runtime.js and docs/plans/test-suite-drift.md.
 */
function createCiRuntimeRouter(config, ciRuntime, ciMaintenance) {
  const router = express.Router();
  const view = () => ({ project: config.name, ...ciRuntime.get(), maintenance: ciMaintenance.status() });

  // GET /api/ci-runtime — per-workflow runner time and budget state, and the
  // maintenance pass on record. A memory read; the GitHub calls happen on the
  // module's own 30-minute refresh.
  router.get('/ci-runtime', (req, res) => {
    res.json(view());
  });

  // POST /api/ci-runtime/maintenance { workflow } — "Start a maintenance pass":
  // one analysis agent, whose result is filed as a backlog Task to Draft.
  router.post('/ci-runtime/maintenance', (req, res) => {
    const workflow = req.body && req.body.workflow;
    if (!workflow || typeof workflow !== 'string') return res.status(400).json({ error: 'workflow required' });
    try {
      ciMaintenance.start(workflow);
      res.json({ ok: true, ...view() });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // POST /api/ci-runtime/accept { workflow } — "Accept the new size": the
  // flagged run starts a new baseline for that workflow.
  router.post('/ci-runtime/accept', (req, res) => {
    const workflow = req.body && req.body.workflow;
    if (!workflow || typeof workflow !== 'string') return res.status(400).json({ error: 'workflow required' });
    try {
      ciRuntime.accept(workflow);
      res.json({ ok: true, ...view() });
    } catch (e) {
      res.status(409).json({ error: e.message });
    }
  });

  // POST /api/ci-runtime/refresh — fetch now rather than at the next refresh.
  router.post('/ci-runtime/refresh', async (req, res) => {
    await ciRuntime.refresh();
    res.json(view());
  });

  return router;
}

module.exports = { createCiRuntimeRouter };
