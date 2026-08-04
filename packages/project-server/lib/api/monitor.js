'use strict';

const express = require('express');

/**
 * The Monitor tab's read surface.
 *
 * Both routes are memory reads. All the GitHub work happens on a backoff inside
 * `lib/monitor.js`, which is what makes it safe for the hub to poll these
 * across every managed project on the same 6-second tick as everything else.
 *
 * There is no write path here, deliberately. Monitor reads and links out; it
 * does not dismiss anything on GitHub's side, and it stores no acknowledgement
 * state of its own — an alert is visible exactly as long as the condition that
 * produced it is true.
 */
function createMonitorRouter(config, monitor) {
  const router = express.Router();

  // GET /api/monitor/alerts — the full derived list for this project.
  router.get('/monitor/alerts', (req, res) => {
    const a = monitor.getAlerts();
    res.json({
      project: config.name,
      configured: a.configured,
      alerts: a.alerts,
      counts: a.counts,
      stale: !!a.stale,
      ...(a.error ? { warning: a.error } : {}),
    });
  });

  // GET /api/monitor/summary — the compact shape the hub's cross-project poll
  // folds in. Kept separate from /alerts so the common case ships counts and a
  // CI conclusion rather than every advisory body.
  router.get('/monitor/summary', (req, res) => {
    res.json({ project: config.name, ...monitor.getSummary() });
  });

  return router;
}

module.exports = { createMonitorRouter };
