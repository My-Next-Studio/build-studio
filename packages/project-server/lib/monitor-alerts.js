'use strict';

/**
 * Turning GitHub's raw answers into the Monitor tab's alert list.
 *
 * Everything here is a pure function over a payload, so the awkward parts —
 * which runs count, what a 403 means, how a streak becomes a severity — are
 * testable without a network. The fetching lives in `monitor.js`.
 *
 * The governing idea, and the reason there is no store anywhere in this module:
 * **these sources are state, not events.** Each one is queryable for its
 * current condition, so the list is derived on every poll and a resolved alert
 * simply stops appearing. That is the same rule `needs-attention.js` follows,
 * for the same reason — a stored flag goes stale the moment the underlying
 * condition changes, and a Monitor tab still showing a vulnerability that was
 * patched last week is a Monitor tab you learn to ignore.
 */

/** Worst first. The Monitor tab groups on this, so the order is the UI's order. */
const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'];

/**
 * Runs that answer "did the thing I just did work?" — the CI/CD tab's question.
 *
 * `workflow_dispatch` belongs here because a manual re-run is still someone
 * pressing a button and watching. Everything else — `schedule`, and the
 * `dynamic` event that Dependabot's own updater runs under — answers the
 * different question Monitor exists for, or no question at all.
 */
const PUSH_EVENTS = new Set(['push', 'workflow_dispatch']);

/**
 * The run the CI/CD light should track.
 *
 * This is the fix for a live mis-attribution: `gh run list --limit 1` with no
 * workflow configured returns the most recent run of ANY workflow, so on a
 * project whose most frequent runs are nightly cron jobs, the CI light tracked
 * the cron. At the time of writing one managed project showed a red CI light
 * that was a scheduled staleness gate while its actual push CI was green.
 *
 * Filtering by event fixes it for every project at once, with no per-project
 * `ci_workflow` configuration to set and keep correct.
 */
function latestPushRun(runs) {
  const list = Array.isArray(runs) ? runs : [];
  for (const r of list) {
    if (r && PUSH_EVENTS.has(r.event)) return r;
  }
  return null;
}

/**
 * Scheduled workflows whose most recent run failed.
 *
 * Grouped by workflow, because a nightly gate that failed three nights running
 * is ONE thing wrong, not three. The list arrives newest-first, so the first
 * entry per workflow is its current state and the rest are history — which is
 * what makes the consecutive-failure streak available for free.
 *
 * On severity: a single failure is reported, not suppressed. The argument for
 * waiting is that one failure may be flaky infrastructure; the argument against
 * is that suppressing it hides a real break for a full day, since the next data
 * point is 24 hours away. So it appears at `moderate` on the first failure and
 * escalates to `high` once it has failed twice in a row — visible immediately,
 * loud once it is definitely not a flake.
 */
function deriveScheduledAlerts(runs, project) {
  const list = Array.isArray(runs) ? runs : [];
  const byWorkflow = new Map();
  for (const r of list) {
    if (!r || r.event !== 'schedule' || !r.workflowName) continue;
    if (!byWorkflow.has(r.workflowName)) byWorkflow.set(r.workflowName, []);
    byWorkflow.get(r.workflowName).push(r);
  }

  const alerts = [];
  for (const [workflowName, wfRuns] of byWorkflow) {
    // Only completed runs describe a condition; one still in progress has not
    // failed yet and must not raise an alert.
    const finished = wfRuns.filter((r) => r.status === 'completed');
    const latest = finished[0];
    if (!latest || latest.conclusion !== 'failure') continue;

    let streak = 0;
    for (const r of finished) {
      if (r.conclusion !== 'failure') break;
      streak++;
    }

    alerts.push({
      source: 'schedule',
      kind: 'scheduled-failure',
      project,
      // Keyed on the workflow, not the run: the condition is "this job is
      // broken", and it survives each new nightly failure.
      id: `schedule:${workflowName}`,
      severity: streak >= 2 ? 'high' : 'moderate',
      title: workflowName,
      detail: streak >= 2
        ? `${streak} consecutive scheduled runs failed`
        : 'last scheduled run failed',
      url: latest.url || null,
      since: latest.createdAt || null,
    });
  }
  return alerts;
}

/**
 * Open Dependabot advisories.
 *
 * `id` keys on GitHub's per-repo alert `number`, deliberately not on the
 * package name. Keying on the package would mean two advisories for the same
 * dependency collapse into one row — and the one that got swallowed is exactly
 * the newer one you most want to see.
 */
function deriveDependabotAlerts(alerts, project) {
  const list = Array.isArray(alerts) ? alerts : [];
  return list
    .filter((a) => a && a.state === 'open')
    .map((a) => {
      const pkg = a.dependency?.package?.name || 'unknown package';
      const scope = a.dependency?.scope;
      const sev = String(a.security_advisory?.severity || 'moderate').toLowerCase();
      return {
        source: 'dependabot',
        kind: 'advisory',
        project,
        id: `dependabot:${a.number}`,
        severity: SEVERITY_ORDER.includes(sev) ? sev : 'moderate',
        title: `${pkg} — ${a.security_advisory?.summary || 'security advisory'}`,
        // Runtime vs development is the first thing you want when triaging, and
        // it is the difference between "ships to users" and "build-time only".
        detail: [scope ? `${scope} dependency` : null, a.security_advisory?.ghsa_id]
          .filter(Boolean).join(' · '),
        url: a.html_url || null,
        since: a.created_at || null,
      };
    });
}

/**
 * What a failed Dependabot query actually means.
 *
 * Measured across this installation: one of nine repositories has alerts
 * enabled. The other eight return a 403 whose body says the feature is
 * disabled — which is information worth showing, not an error to swallow.
 *
 * The trap: `gh` appends *"This API operation needs the `admin:repo_hook`
 * scope"* to that 403. It is misleading. The very same token reads alerts
 * successfully on the repository where the feature IS enabled, so the scope was
 * never the problem and anyone debugging from that hint burns an afternoon
 * refreshing credentials. Classify on the message body, not on gh's advice.
 */
function classifyAlertsError(stderr) {
  const s = String(stderr || '');
  if (/alerts are disabled|Dependabot alerts are disabled/i.test(s)) return 'disabled';
  if (/404|Not Found/i.test(s)) return 'no-repo';
  if (/401|Bad credentials|gh auth login/i.test(s)) return 'no-auth';
  return 'error';
}

/**
 * The "you have not turned this on" row.
 *
 * Rendered as information rather than as a failure, because it is actionable in
 * a way an outage is not: it tells you the tab's most valuable source is silent
 * for this project, and exactly what to do about it.
 */
function notEnabledAlert(project, repo) {
  return {
    source: 'dependabot',
    kind: 'not-enabled',
    project,
    id: 'dependabot:not-enabled',
    severity: 'info',
    title: 'Dependency alerts are not enabled',
    detail: 'Monitor cannot see advisories for this project until the feature is on',
    url: repo ? `https://github.com/${repo}/settings/security_analysis` : null,
    since: null,
  };
}

/** Worst first; ties broken by project then title so the order is stable. */
function sortAlerts(alerts) {
  return [...(alerts || [])].sort((a, b) => {
    const d = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (d !== 0) return d;
    const p = String(a.project || '').localeCompare(String(b.project || ''));
    return p !== 0 ? p : String(a.title || '').localeCompare(String(b.title || ''));
  });
}

/**
 * Per-severity totals for the tab badge.
 *
 * `actionable` deliberately excludes `info`: the badge is a count of things
 * wrong, and a project that has simply not enabled a feature should not make
 * the Monitor tab look like it is on fire.
 */
function countBySeverity(alerts) {
  const counts = { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
  for (const a of alerts || []) {
    if (counts[a.severity] === undefined) continue;
    counts[a.severity]++;
  }
  counts.total = (alerts || []).length;
  counts.actionable = counts.total - counts.info;
  return counts;
}

module.exports = {
  SEVERITY_ORDER,
  PUSH_EVENTS,
  latestPushRun,
  deriveScheduledAlerts,
  deriveDependabotAlerts,
  classifyAlertsError,
  notEnabledAlert,
  sortAlerts,
  countBySeverity,
};
