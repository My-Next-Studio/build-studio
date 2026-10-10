'use strict';

/**
 * The version of each contract this server speaks to other Studio apps, as
 * advertised in GET /api/health. Bump a number only for a breaking change to
 * that contract (docs/backlog-api-contract.md, *Versioning*), together with the
 * doc and its contract tests; an added field is not breaking and keeps it.
 */
const CONTRACTS = Object.freeze({ backlog: 1 });

/**
 * GET /api/health. `ok`, `projectRoot` and `contracts` are part of the backlog
 * API contract other Studio apps rely on (docs/backlog-api-contract.md §2): a
 * consumer compares projectRoot with the repo it expects before filing
 * anything, and checks it understands the advertised contract version. The
 * other fields are internal — the hub's process-manager reads bundleVersion to
 * spot a stale server.
 */
function createHealthHandler(config, { startedAt, bundleVersion }) {
  return (req, res) => res.json({
    ok: true,
    name: config.name,
    projectRoot: config.projectRoot,
    contracts: CONTRACTS,
    uptime: process.uptime(),
    startedAt,
    bundleVersion,
  });
}

module.exports = { createHealthHandler, CONTRACTS };
