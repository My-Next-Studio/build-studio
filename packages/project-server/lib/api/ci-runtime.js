'use strict';

const express = require('express');

/**
 * CI runtime per workflow, and the two actions on a drift notice.
 * See lib/ci-runtime.js and docs/plans/test-suite-drift.md.
 */
function createCiRuntimeRouter(config, ciRuntime) {
  const router = express.Router();

  // GET /api/ci-runtime — per-workflow runner time and budget state. A memory
  // read; the GitHub calls happen on the module's own 30-minute refresh.
  router.get('/ci-runtime', (req, res) => {
    res.json({ project: config.name, ...ciRuntime.get() });
  });

  // POST /api/ci-runtime/accept { workflow } — "Accept the new size": the
  // flagged run starts a new baseline for that workflow.
  router.post('/ci-runtime/accept', (req, res) => {
    const workflow = req.body && req.body.workflow;
    if (!workflow || typeof workflow !== 'string') return res.status(400).json({ error: 'workflow required' });
    try {
      res.json({ ok: true, ...ciRuntime.accept(workflow) });
    } catch (e) {
      res.status(409).json({ error: e.message });
    }
  });

  // POST /api/ci-runtime/refresh — fetch now rather than at the next refresh.
  router.post('/ci-runtime/refresh', async (req, res) => {
    await ciRuntime.refresh();
    res.json({ project: config.name, ...ciRuntime.get() });
  });

  return router;
}

module.exports = { createCiRuntimeRouter };
