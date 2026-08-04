'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const { createCache } = require('./github-cache');
const alertsLib = require('./monitor-alerts');

const execFileAsync = promisify(execFile);

/**
 * The project's window onto GitHub: CI state for the CI/CD tab, and derived
 * alerts for the Monitor tab.
 *
 * Two decisions shape this file.
 *
 * **One `gh run list` serves both tabs.** The CI light wants the newest push
 * run; the Monitor tab wants scheduled workflows whose latest run failed. Both
 * are answerable from a single list of recent runs, so asking twice would
 * double the API cost to learn the same thing. The list is fetched once and
 * both views are derived from it in `monitor-alerts.js`.
 *
 * **Every call is async.** The existing `/deployment/ci-status` used
 * `execFileSync`, which was tolerable when it only ran while a human had the
 * CI/CD tab open. These refreshes fire from a cache on a timer, and a
 * synchronous `gh` invocation — routinely 300-1500ms — would block the
 * project-server's event loop for that entire time, stalling websocket traffic
 * and the workflow watchdog along with it.
 */

// A run in flight is the one moment anyone is actually watching, so it earns a
// fast cadence. Everything else backs off hard: a repository whose last run
// finished hours ago is not going to surprise anyone within five minutes.
const TTL_RUN_IN_FLIGHT = 20 * 1000;
const TTL_RUN_JUST_FINISHED = 45 * 1000;
const TTL_RUN_IDLE = 5 * 60 * 1000;
const TTL_ALERTS = 15 * 60 * 1000;      // advisories change rarely
const JUST_FINISHED_MS = 10 * 60 * 1000;

const RUN_FIELDS = 'databaseId,status,conclusion,displayTitle,createdAt,updatedAt,event,workflowName,url';

function ageMs(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Date.now() - t : Infinity;
}

/**
 * @param {object} config  the loaded project config; `deployment.repo` gates
 *        everything — a project without one makes no GitHub calls at all.
 * @param {object} [deps]  injectable exec for tests
 */
function createMonitor(config, deps = {}) {
  const exec = deps.execFileAsync || execFileAsync;
  const projectName = (config && config.name) || 'project';

  function repo() {
    return (config && config.deployment && config.deployment.repo) || null;
  }

  // repo|ci_workflow → resolved display name. Memoized for the process
  // lifetime: a workflow's display name changes about as often as its file is
  // renamed, and a project-server restart re-resolves it anyway.
  const workflowNameCache = new Map();

  async function resolveConfiguredWorkflow(r, ciWorkflow) {
    const key = `${r}|${ciWorkflow}`;
    if (workflowNameCache.has(key)) return workflowNameCache.get(key);
    let resolved = null;
    try {
      const { stdout } = await exec('gh', [
        'workflow', 'list', '--repo', r, '--limit', '100', '--json', 'name,path,id',
      ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      resolved = alertsLib.resolveWorkflowName(ciWorkflow, JSON.parse(String(stdout || '[]').trim() || '[]'));
    } catch (_) {
      // Leave it unresolved rather than caching a failure as "no such
      // workflow" — the next refresh gets to try again.
      return null;
    }
    workflowNameCache.set(key, resolved);
    return resolved;
  }

  async function fetchRuns() {
    const r = repo();
    if (!r) return { runs: [] };
    const dep = config.deployment || {};
    const args = ['run', 'list', '--repo', r, '--limit', '30', '--json', RUN_FIELDS];
    // A configured ci_workflow still narrows the CI light, but the run list has
    // to stay wide enough to see scheduled workflows for the Monitor tab — so
    // the filter is applied when picking the CI run, not when fetching.
    const { stdout } = await exec('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    const runs = JSON.parse(String(stdout || '[]').trim() || '[]');

    let ciRuns = runs;
    if (dep.ci_workflow) {
      ciRuns = runs.filter((x) => x && x.workflowName === dep.ci_workflow);
      // No match usually means ci_workflow is a filename rather than a display
      // name. Resolving costs one extra call, once per server lifetime — and
      // only for projects spelled that way.
      if (ciRuns.length === 0) {
        const resolved = await resolveConfiguredWorkflow(r, dep.ci_workflow);
        if (resolved) ciRuns = runs.filter((x) => x && x.workflowName === resolved);
      }
    }
    const run = alertsLib.latestPushRun(ciRuns);

    // Per-job detail, only for the run the CI/CD tab is about to render. Failing
    // to get it must not lose the run itself — the light matters more than the
    // job breakdown under it.
    let jobs = [];
    if (run && run.databaseId) {
      try {
        const { stdout: jobsOut } = await exec('gh', [
          'run', 'view', String(run.databaseId), '--repo', r, '--json', 'jobs',
        ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        jobs = (JSON.parse(String(jobsOut || '{}')).jobs || []).map((j) => ({
          name: j.name, status: j.status, conclusion: j.conclusion,
          startedAt: j.startedAt, completedAt: j.completedAt,
        }));
      } catch (_) { /* keep the run, drop the detail */ }
    }
    return { runs, run, jobs };
  }

  async function fetchDependabot() {
    const r = repo();
    if (!r) return { alerts: [], state: 'unconfigured' };
    try {
      const { stdout } = await exec('gh', [
        'api', `/repos/${r}/dependabot/alerts?state=open&per_page=100`,
      ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      return { alerts: JSON.parse(String(stdout || '[]').trim() || '[]'), state: 'ok' };
    } catch (e) {
      // A disabled feature is a normal, expected answer here — eight of nine
      // repositories give it — so it resolves as data rather than rejecting.
      // Only genuine faults become cache errors worth retrying.
      const kind = alertsLib.classifyAlertsError(e.stderr || e.message);
      if (kind === 'disabled') return { alerts: [], state: 'disabled' };
      throw new Error(`dependabot: ${kind}: ${String(e.stderr || e.message).trim().slice(0, 200)}`);
    }
  }

  const runsCache = createCache({
    fetch: fetchRuns,
    ttlFor: (v) => {
      const run = v && v.run;
      if (!run) return TTL_RUN_IDLE;
      if (run.status !== 'completed') return TTL_RUN_IN_FLIGHT;
      return ageMs(run.updatedAt || run.createdAt) < JUST_FINISHED_MS
        ? TTL_RUN_JUST_FINISHED
        : TTL_RUN_IDLE;
    },
  });

  const alertsCache = createCache({ fetch: fetchDependabot, ttlFor: () => TTL_ALERTS });

  /** CI state for the CI/CD tab — push runs only. Never blocks. */
  function getCi() {
    if (!repo()) return { configured: false, run: null, jobs: [], stale: false };
    const c = runsCache.get();
    const v = c.value || {};
    return {
      configured: true,
      run: v.run
        ? {
            id: v.run.databaseId, status: v.run.status, conclusion: v.run.conclusion,
            title: v.run.displayTitle, event: v.run.event, workflowName: v.run.workflowName,
            url: v.run.url, createdAt: v.run.createdAt, updatedAt: v.run.updatedAt,
          }
        : null,
      jobs: v.jobs || [],
      fetchedAt: c.fetchedAt,
      stale: c.stale,
      loading: c.loading,
      error: c.error || null,
    };
  }

  /** The derived alert list. Sorted worst-first; nothing is stored. */
  function getAlerts() {
    if (!repo()) return { configured: false, alerts: [], counts: alertsLib.countBySeverity([]) };
    const runsC = runsCache.get();
    const alertsC = alertsCache.get();

    const out = [];
    out.push(...alertsLib.deriveScheduledAlerts((runsC.value || {}).runs, projectName));

    const dep = alertsC.value;
    if (dep && dep.state === 'disabled') {
      out.push(alertsLib.notEnabledAlert(projectName, repo()));
    } else if (dep && Array.isArray(dep.alerts)) {
      out.push(...alertsLib.deriveDependabotAlerts(dep.alerts, projectName));
    }

    const alerts = alertsLib.sortAlerts(out);
    return {
      configured: true,
      alerts,
      counts: alertsLib.countBySeverity(alerts),
      stale: runsC.stale || alertsC.stale,
      error: runsC.error || alertsC.error || null,
    };
  }

  /** The cheap shape the hub's cross-project poll folds in per project. */
  function getSummary() {
    const ci = getCi();
    const al = getAlerts();
    return {
      configured: ci.configured,
      ci: ci.run
        ? { status: ci.run.status, conclusion: ci.run.conclusion, url: ci.run.url, title: ci.run.title, id: ci.run.id }
        : null,
      counts: al.counts,
      stale: !!(ci.stale || al.stale),
    };
  }

  /** Warm both caches without waiting — called once at server start. */
  function prime() {
    if (!repo()) return;
    runsCache.refresh();
    alertsCache.refresh();
  }

  return { getCi, getAlerts, getSummary, prime };
}

module.exports = { createMonitor, TTL_RUN_IN_FLIGHT, TTL_RUN_IDLE, TTL_ALERTS };
