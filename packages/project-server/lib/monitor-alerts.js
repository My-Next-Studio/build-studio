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
 * Resolve a configured `ci_workflow` to the display name runs are tagged with.
 *
 * `deployment.ci_workflow` is conventionally a FILENAME — `deploy-pages.yml` —
 * because that is what `gh run list --workflow` accepts. But `gh run list
 * --json workflowName` reports the workflow's *display* name, `Deploy Pages`,
 * so filtering runs by the configured string directly matches nothing and the
 * CI light goes blank. (That is exactly what happened to a project here the
 * moment filtering moved from the gh flag into our own code.)
 *
 * Deriving one from the other is not safe — a workflow named "Deploy to Pages"
 * can live in `deploy-pages.yml` — so this maps them through the real workflow
 * list. Returns null when nothing matches, and callers fall back to treating
 * the configured value as a display name, which is the other legal spelling.
 *
 * @param {string} ciWorkflow  a filename, a path, or a display name
 * @param {{name:string, path:string}[]} workflows  from `gh workflow list`
 */
function resolveWorkflowName(ciWorkflow, workflows) {
  if (!ciWorkflow) return null;
  const list = Array.isArray(workflows) ? workflows : [];
  for (const w of list) {
    if (!w) continue;
    if (w.name === ciWorkflow) return w.name;
    const path = String(w.path || '');
    if (path === ciWorkflow || path.split('/').pop() === ciWorkflow) return w.name;
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
 * Is this a Dependabot pull request, and which package is it bumping?
 *
 * Dependabot names its branches `dependabot/<ecosystem>/<path?>/<pkg>-<version>`
 * and titles them "Bump <pkg> from X to Y" (or "chore(deps): bump …"). Matching
 * on the branch prefix rather than the author login keeps working if the PR is
 * later taken over by a human, which is what happens when a bump needs manual
 * conflict resolution.
 */
function isDependabotPr(pr) {
  if (!pr) return false;
  if (String(pr.headRefName || '').startsWith('dependabot/')) return true;
  return /dependabot/i.test(String(pr.author?.login || ''));
}

/** "Bump vite from 5.4.0 to 6.0.0" → { from: '5.4.0', to: '6.0.0' } */
function parseBumpTitle(title) {
  const m = String(title || '').match(/from\s+v?(\d+[\w.-]*)\s+to\s+v?(\d+[\w.-]*)/i);
  return m ? { from: m[1], to: m[2] } : null;
}

/**
 * How much judgement does this bump need?
 *
 * The distinction that matters is major-vs-not, because a green build is
 * sufficient evidence to merge a patch bump and is NOT sufficient for a major.
 * Under 1.0 the minor carries breaking changes by convention, so 0.34 → 0.35 is
 * treated as a major — that is the sharp case exactly.
 *
 * Returns 'major' | 'minor' | null (null when the versions cannot be read,
 * which stays honest rather than guessing 'minor' and implying it is safe).
 */
function classifyBump(from, to) {
  const parse = (v) => {
    const m = String(v || '').match(/^(\d+)\.(\d+)/);
    return m ? { major: +m[1], minor: +m[2] } : null;
  };
  const a = parse(from);
  const b = parse(to);
  if (!a || !b) return null;
  if (a.major !== b.major) return 'major';
  if (a.major === 0 && a.minor !== b.minor) return 'major';
  return 'minor';
}

/**
 * Attach fix-readiness to each advisory.
 *
 * This is what turns the Monitor list from something you scroll into something
 * you work. Three rows that look identical today need wildly different amounts
 * of you:
 *
 *   'ready'   — Dependabot has a PR open and it is not a major. Merge it.
 *   'major'   — a PR exists, but green CI does not justify merging a major.
 *   'blocked' — a patched version exists upstream and no PR appeared, which
 *               almost always means the dependency is pinned transitively.
 *               (postcss under `next` here.) Needs a decision, not a merge.
 *   'none'    — no patched version exists at all. Nobody can fix it yet.
 *
 * `blocked` and `none` are the rows worth your attention; `ready` is the bulk
 * and is batch-mergeable.
 */
function withFixReadiness(alerts, prs, { autofixEnabled } = {}) {
  const dependabotPrs = (Array.isArray(prs) ? prs : []).filter(isDependabotPr);
  return (alerts || []).map((a) => {
    // With security updates switched off, no PR was ever attempted — so a
    // missing PR says nothing about whether the fix is takeable, and calling it
    // 'blocked' would assert a diagnosis we have not earned. This is not
    // hypothetical: every advisory on a repo with updates off would otherwise
    // read as "pinned, needs a decision" when the real answer is "turn updates
    // on and find out".
    if (autofixEnabled === false) {
      return { ...a, fix: 'inactive', prNumber: null, prUrl: null };
    }
    const pkg = a.pkg;
    const pr = pkg
      ? dependabotPrs.find((p) => String(p.headRefName || '').includes(pkg)
          || new RegExp(`bump\\s+${escapeRe(pkg)}\\b`, 'i').test(String(p.title || '')))
      : null;

    let fix;
    if (pr) {
      const bump = parseBumpTitle(pr.title);
      fix = bump && classifyBump(bump.from, bump.to) === 'major' ? 'major' : 'ready';
    } else {
      fix = a.hasPatch ? 'blocked' : 'none';
    }
    return {
      ...a,
      fix,
      prNumber: pr ? pr.number : null,
      prUrl: pr ? pr.url : null,
    };
  });
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Human wording for each readiness state — used by the tab and kept with it. */
const FIX_LABEL = {
  ready: 'fix ready — merge',
  major: 'major bump — needs review',
  blocked: 'patch exists, no PR — likely pinned',
  none: 'no fix available yet',
  inactive: 'security updates are off — unknown until enabled',
};

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
        // Carried through so fix-readiness can be attached once the open PRs
        // are known — see withFixReadiness.
        pkg,
        hasPatch: !!a.security_vulnerability?.first_patched_version?.identifier,
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
 *
 * The `url` is a manual fallback only — the tab's actual action is a button
 * that enables the feature through the `gh` credential. Linking to GitHub's
 * settings page is a trap on a PRIVATE repo: GitHub answers an unauthenticated
 * request with 404 rather than a sign-in prompt, so a browser session that is
 * not logged in is indistinguishable from a broken link.
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

/**
 * Alerts are visible but nothing can act on them.
 *
 * This is a distinct and worse state than "not enabled": the repository can see
 * advisories and has no mechanism to fix them, so they accumulate silently. It
 * is what let thirteen advisories pile up on one repo here when nine of them
 * needed nothing but a version bump — and it is the state every repo lands in
 * the moment alerts are switched on without security updates.
 */
function autofixDisabledAlert(project, repo, openCount) {
  return {
    source: 'dependabot',
    kind: 'autofix-disabled',
    project,
    id: 'dependabot:autofix-disabled',
    severity: 'info',
    title: 'Security updates are off — advisories will accumulate',
    detail: openCount > 0
      ? `${openCount} open advisor${openCount === 1 ? 'y' : 'ies'} and nothing is opening fix PRs`
      : 'nothing will open a fix PR when an advisory appears',
    url: repo ? `https://github.com/${repo}/security/dependabot` : null,
    since: null,
  };
}

/**
 * Worst first, and within a severity the rows that need YOU before the rows you
 * can merge.
 *
 * The ordering is the feature: a batch of `ready` rows is a few clicks, while a
 * `blocked` or `major` row is a decision. Sorting them together by severity
 * alone buries the handful that need thought under the bulk that does not, and
 * a list you cannot triage at a glance is one you stop opening.
 */
const FIX_PRIORITY = { major: 0, blocked: 1, none: 2, inactive: 2.5, ready: 3 };

function sortAlerts(alerts) {
  return [...(alerts || [])].sort((a, b) => {
    const d = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity);
    if (d !== 0) return d;
    const f = (FIX_PRIORITY[a.fix] ?? 1.5) - (FIX_PRIORITY[b.fix] ?? 1.5);
    if (f !== 0) return f;
    const p = String(a.project || '').localeCompare(String(b.project || ''));
    return p !== 0 ? p : String(a.title || '').localeCompare(String(b.title || ''));
  });
}

/** How many advisories are one merge away, for the summary line. */
function countReadyToMerge(alerts) {
  return (alerts || []).filter((a) => a.fix === 'ready').length;
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
  resolveWorkflowName,
  deriveScheduledAlerts,
  deriveDependabotAlerts,
  classifyAlertsError,
  notEnabledAlert,
  autofixDisabledAlert,
  isDependabotPr,
  parseBumpTitle,
  classifyBump,
  withFixReadiness,
  sortAlerts,
  countBySeverity,
  countReadyToMerge,
  FIX_LABEL,
};
