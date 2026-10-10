'use strict';

/**
 * GET /api/health. `ok` and `projectRoot` are part of the backlog API contract
 * other Studio apps rely on (docs/backlog-api-contract.md §2): a consumer
 * compares projectRoot with the repo it expects before filing anything. The
 * other fields are internal — the hub's process-manager reads bundleVersion to
 * spot a stale server.
 */
function createHealthHandler(config, { startedAt, bundleVersion }) {
  return (req, res) => res.json({
    ok: true,
    name: config.name,
    projectRoot: config.projectRoot,
    uptime: process.uptime(),
    startedAt,
    bundleVersion,
  });
}

module.exports = { createHealthHandler };
