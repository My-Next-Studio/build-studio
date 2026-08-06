'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { createCache } = require('./github-cache');
const alertsLib = require('./monitor-alerts');
const reach = require('./fix-reachability');
const { assertInside } = require('./path-guard');

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

/** npm errors are pages long; a row can show one line of it. */
function firstLine(msg) {
  const line = String(msg || '').split('\n').map((l) => l.trim())
    .find((l) => l && !/^Command failed/i.test(l));
  return (line || String(msg || '')).slice(0, 160);
}

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

  // The repo's default branch, resolved once per process. Memoized for the same
  // reason as the workflow name: it changes about as often as the repo is
  // renamed, and a server restart re-resolves it.
  let defaultBranch = null;
  async function resolveDefaultBranch(r) {
    if (defaultBranch) return defaultBranch;
    try {
      const { stdout } = await exec('gh', ['repo', 'view', r, '--json', 'defaultBranchRef'], { encoding: 'utf8' });
      defaultBranch = JSON.parse(String(stdout || '{}'))?.defaultBranchRef?.name || null;
    } catch (_) { return null; }
    return defaultBranch;
  }

  async function fetchRuns() {
    const r = repo();
    if (!r) return { runs: [] };
    const dep = config.deployment || {};
    // Scoped to the default branch, which fixes a real defect and costs
    // nothing: a push to a feature branch would otherwise become "the latest
    // push run" and the CI light would report that branch's result instead of
    // the project's. Latent while feature branches are rare — and permanent the
    // moment Dependabot starts opening PRs, since those push constantly.
    //
    // The same filter is correct for the Monitor tab's scheduled alerts:
    // GitHub only ever runs `schedule` workflows on the default branch, so
    // nothing is lost, and ONE `gh run list` still serves both readers.
    const branch = await resolveDefaultBranch(r);
    const args = ['run', 'list', '--repo', r, '--limit', '30', '--json', RUN_FIELDS];
    if (branch) args.push('--branch', branch);
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

  /**
   * Everything Dependabot-shaped, in one cache entry: the open advisories,
   * whether security updates are switched on, and the open bump PRs.
   *
   * The PRs are what let an advisory say "merge this" rather than "deal with
   * this" — an advisory with a waiting PR is a click, one without is a
   * decision, and they are indistinguishable from the alert payload alone.
   */
  async function fetchDependabot() {
    const r = repo();
    if (!r) return { alerts: [], prs: [], autofix: null, state: 'unconfigured' };
    let alerts;
    try {
      const { stdout } = await exec('gh', [
        'api', `/repos/${r}/dependabot/alerts?state=open&per_page=100`,
      ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      alerts = JSON.parse(String(stdout || '[]').trim() || '[]');
    } catch (e) {
      // A disabled feature is a normal, expected answer here — most
      // repositories give it — so it resolves as data rather than rejecting.
      // Only genuine faults become cache errors worth retrying.
      const kind = alertsLib.classifyAlertsError(e.stderr || e.message);
      if (kind === 'disabled') return { alerts: [], prs: [], autofix: null, state: 'disabled' };
      throw new Error(`dependabot: ${kind}: ${String(e.stderr || e.message).trim().slice(0, 200)}`);
    }

    // Both of these are supporting detail: failing to read either must not cost
    // us the advisories themselves, which are the actual payload.
    let autofix = null;
    try {
      const { stdout } = await exec('gh', ['api', `/repos/${r}/automated-security-fixes`], { encoding: 'utf8' });
      autofix = JSON.parse(String(stdout || '{}').trim() || '{}');
    } catch (_) { /* unknown — the tab simply won't claim either way */ }

    let prs = [];
    try {
      const { stdout } = await exec('gh', [
        'pr', 'list', '--repo', r, '--state', 'open', '--limit', '100',
        '--json', 'number,title,url,headRefName,author',
      ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
      prs = JSON.parse(String(stdout || '[]').trim() || '[]');
    } catch (_) { /* advisories still render, just without merge-readiness */ }

    return { alerts, prs, autofix, state: 'ok' };
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

  /**
   * npm probes, one pair per manifest DIRECTORY.
   *
   * A repository is not necessarily one npm project. One managed project here
   * carries six independent lockfiles — root, frontend, admin, backend, worker,
   * e2e — and GitHub files a separate advisory per manifest. Running npm once at
   * the repository root and applying its answer to all of them meant an advisory
   * against `worker/package-lock.json` was judged against the ROOT's dependency
   * tree: identical advisories came out `refresh` and `blocked` side by side
   * depending on which tree happened to match, and the tab suggested a command
   * that could not work. Every other project here has a single lockfile, which
   * is why it stayed invisible.
   *
   * So each directory gets its own probes, created on demand — a project with no
   * npm advisories still runs nothing.
   */
  const npmProbesByDir = new Map();

  /** `worker/package-lock.json` → `worker`; `package-lock.json` → `''`. */
  function manifestDir(manifestPath) {
    if (!manifestPath || !manifestPath.includes('/')) return '';
    return manifestPath.slice(0, manifestPath.lastIndexOf('/'));
  }

  function npmProbes(dir) {
    if (npmProbesByDir.has(dir)) return npmProbesByDir.get(dir);

    // `manifest_path` comes from GitHub — untrusted input deciding a working
    // directory, so it goes through the same guard as any other path from
    // outside. A directory with no lockfile is skipped rather than probed: npm
    // in the wrong place produces a confident answer about the wrong project.
    let cwd = null;
    try {
      const abs = dir ? assertInside(dir, config.projectRoot) : config.projectRoot;
      if (fs.existsSync(path.join(abs, 'package-lock.json'))) cwd = abs;
    } catch { cwd = null; }

    const probes = cwd ? {
      cwd,
      // `npm audit fix --dry-run` rather than a plain audit: `fixAvailable` is
      // not evidence that running the command changes anything. See
      // classifyNpmFromAuditFix.
      //
      // `--include=dev` is REQUIRED, not a preference. The project-server runs
      // with NODE_ENV=production, and npm reads that as `--omit=dev`: the audit
      // then reports zero vulnerabilities on a project whose every advisory is a
      // devDependency, and every row silently falls back to "could not tell".
      //
      // npm exits NON-ZERO whenever it finds anything — the only case this is
      // ever called in — so the report is read off the rejected exec's stdout.
      audit: createCache({
        fetch: async () => {
          // npm exits NON-ZERO whenever it finds anything, and may print a
          // human-readable plan ahead of the JSON — so the report is dug out of
          // stdout either way. See extractJsonReport.
          let out;
          try {
            const r = await execFileAsync(
              'npm', ['audit', 'fix', '--dry-run', '--json', '--include=dev'],
              { cwd, timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
            out = r.stdout;
          } catch (e) {
            if (!(e && typeof e.stdout === 'string' && e.stdout.trim())) throw e;
            out = e.stdout;
          }
          const report = reach.extractJsonReport(out);
          if (!report) throw new Error('npm audit produced no JSON report');
          return report;
        },
        ttlFor: () => TTL_ALERTS,
      }),
      // What a plain `npm update` would land, consulted only when audit fix has
      // nothing to offer. `--json` is ignored by `npm update` (npm 11), so this
      // is the human-readable plan, parsed as text. Nothing here proposes
      // widening a range: `npm update` moves only within what package.json
      // already declares.
      updatePlan: createCache({
        fetch: async () => {
          const { stdout } = await execFileAsync(
            'npm', ['update', '--dry-run', '--include=dev'],
            { cwd, timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
          return String(stdout || '');
        },
        ttlFor: () => TTL_ALERTS,
      }),
    } : null;

    npmProbesByDir.set(dir, probes);
    return probes;
  }

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

  /**
   * Read a manifest from the managed project, or null.
   *
   * `manifest_path` comes from GitHub, so it is treated as untrusted input even
   * though the API is the one supplying it: assertInside keeps a path that
   * escapes the project — through traversal or a sibling directory whose name
   * merely extends it — from turning a monitoring read into an arbitrary one.
   */
  function readProjectFile(relPath) {
    if (!relPath || !config.projectRoot) return null;
    try {
      const abs = assertInside(relPath, config.projectRoot);
      return fs.readFileSync(abs, 'utf8');
    } catch { return null; }
  }

  // Manifests are read once per derivation pass rather than once per advisory:
  // a repo with thirty npm advisories would otherwise re-read and re-parse the
  // same multi-megabyte package-lock.json thirty times on every poll.
  let manifestCache = new Map();

  /** The project's package-lock.json, read once per derivation pass. */
  function readLock(manifestPath) {
    const lockPath = manifestPath && manifestPath.endsWith('package-lock.json')
      ? manifestPath : 'package-lock.json';
    if (!manifestCache.has(lockPath)) manifestCache.set(lockPath, readProjectFile(lockPath));
    return manifestCache.get(lockPath);
  }

  /**
   * Whether an advisory's patch is installable today. Returns null — meaning
   * "keep the vaguer label" — for any ecosystem or manifest we cannot read.
   */
  function reachabilityOf(alert) {
    const eco = String(alert.ecosystem || '').toLowerCase();
    const { pkg, patchedVersion, manifestPath } = alert;
    if (!pkg || !patchedVersion) return null;

    if (eco === 'npm') {
      // Probes for THIS advisory's manifest directory, not the repository root.
      const probes = npmProbes(manifestDir(manifestPath));
      if (!probes) return null;

      // npm's own verdict first — it knows the registry, so it can see fixes
      // that arrive by bumping an ancestor rather than the package itself.
      const auditState = probes.audit.get();
      const audit = auditState.value;
      if (audit) {
        const r = reach.classifyNpmFromAuditFix(audit, pkg, alert.ghsaId, {
          installedVersionOf: (name) => {
            try {
              const l = JSON.parse(readLock(manifestPath) || 'null');
              return (l && l.packages && l.packages[`node_modules/${name}`] || {}).version || null;
            } catch { return null; }
          },
        });
        if (r) {
          if (r.verdict === 'breaking') return { verdict: 'breaking', fix: r.fix };
          return r.verdict;
        }
      }

      // audit fix gave up (or said nothing). It only bumps packages along the
      // advisory's own chain, so it misses a fix that arrives by updating an
      // unrelated-looking parent already permitted by package.json — which is
      // how `npm update tsx` cleared an esbuild advisory that audit fix could
      // not touch. Ask what a plain `npm update` would land.
      const planState = probes.updatePlan.get();
      const planText = planState.value;
      if (planText) {
        const planned = reach.parseNpmUpdatePlan(planText);
        // The plan names packages without paths, so it can only be attributed
        // when exactly one copy of the package is installed. readLock is needed
        // up front to establish that — see classifyNpmFromUpdatePlan.
        const lockJson = readLock(manifestPath);
        let lock = null;
        try { lock = lockJson ? JSON.parse(lockJson) : null; } catch { lock = null; }
        const copies = lock ? reach.npmInstalledCopies(lock, pkg) : null;
        if (reach.classifyNpmFromUpdatePlan(planned, pkg, patchedVersion, copies) === 'refresh') {
          let targets = [];
          try {
            if (lock) targets = reach.npmUpdateTargets(planned, lock, pkg);
          } catch { /* fall through to the untargeted command */ }
          return {
            verdict: 'refresh',
            // Name the parents rather than suggesting a bare `npm update`, which
            // would also move every other dependency in the project.
            command: targets.length ? `npm update ${targets.join(' ')}` : 'npm update',
          };
        }
      }

      // Both probes failed — npm cannot resolve this tree at all, which is a
      // fact about the project rather than about the advisory. Say so: a broken
      // probe silently degrading to "could not tell" is what made a whole
      // inert feature look like a working one with unlucky data.
      const probeError = auditState.error || planState.error;
      if (!audit && !planText && probeError) {
        return { verdict: null, note: `npm could not resolve this tree: ${firstLine(probeError)}` };
      }

      // Audit unavailable or silent on this advisory. Fall back to the lockfile
      // range math, but honour ONLY its 'refresh' answer: that direction stays
      // sound (if every current parent already permits the patch, regenerating
      // the lockfile really does fix it), while its 'upstream' answer is the one
      // that was wrong — it cannot see a fix reachable by updating an ancestor.
      const lockJson = readLock(manifestPath);
      if (!lockJson) return null;
      return reach.classifyNpm({ lockJson, pkgName: pkg, patchedVersion }) === 'refresh'
        ? 'refresh' : null;
    }

    if (eco === 'pip') {
      // The advisory points at the lock (uv.lock / requirements.txt) but the
      // CONSTRAINT — the thing that decides whether a newer version is allowed —
      // lives in the pyproject.toml beside it.
      const dir = manifestPath && manifestPath.includes('/')
        ? manifestPath.slice(0, manifestPath.lastIndexOf('/')) : '';
      const pyPath = dir ? `${dir}/pyproject.toml` : 'pyproject.toml';
      if (!manifestCache.has(pyPath)) manifestCache.set(pyPath, readProjectFile(pyPath));
      const pyprojectText = manifestCache.get(pyPath);
      return pyprojectText ? reach.classifyPip({ pyprojectText, pkgName: pkg, patchedVersion }) : null;
    }

    return null;
  }

  /** The derived alert list. Sorted worst-first; nothing is stored. */
  function getAlerts() {
    // Fresh per pass, so an edited lockfile is picked up on the next poll rather
    // than being remembered for the lifetime of the server.
    manifestCache = new Map();
    if (!repo()) return { configured: false, alerts: [], counts: alertsLib.countBySeverity([]) };
    const runsC = runsCache.get();
    const alertsC = alertsCache.get();

    const out = [];
    out.push(...alertsLib.deriveScheduledAlerts((runsC.value || {}).runs, projectName));

    const dep = alertsC.value;
    if (dep && dep.state === 'disabled') {
      out.push(alertsLib.notEnabledAlert(projectName, repo()));
    } else if (dep && Array.isArray(dep.alerts)) {
      const advisories = alertsLib.withFixReadiness(
        alertsLib.deriveDependabotAlerts(dep.alerts, projectName),
        dep.prs,
        {
          autofixEnabled: dep.autofix ? dep.autofix.enabled : undefined,
          reachability: reachabilityOf,
        }
      );
      out.push(...advisories);
      // Seeing without acting is its own condition, and the one that lets
      // advisories pile up unattended — so it is reported, not inferred.
      if (dep.autofix && dep.autofix.enabled === false) {
        out.push(alertsLib.autofixDisabledAlert(projectName, repo(), advisories.length));
      }
    }

    const alerts = alertsLib.sortAlerts(out);
    return {
      configured: true,
      alerts,
      counts: alertsLib.countBySeverity(alerts),
      readyToMerge: alertsLib.countReadyToMerge(alerts),
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

  /**
   * Turn on Dependabot alerts for this repository.
   *
   * The Monitor tab used to link to the GitHub settings page for this, which
   * fails badly on a PRIVATE repo: GitHub answers an unauthenticated request
   * with 404 rather than a sign-in prompt (it will not confirm the repo
   * exists), so a browser session without a GitHub login is indistinguishable
   * from a dead link. Doing it here removes the browser — and the question of
   * which browser profile answered — from the loop entirely, using the same
   * credential that already reads alerts.
   *
   * Refreshes the alert cache on success so the "not enabled" row clears on the
   * next poll instead of lingering for the rest of the 15-minute TTL.
   */
  async function enableAlerts() {
    const r = repo();
    if (!r) throw new Error('deployment.repo not set');

    // BOTH toggles, always. Enabling alerts alone is the trap this whole row
    // exists to close: the repo gains the ability to see advisories and no
    // ability to act on them, and they accumulate until someone notices. Both
    // PUTs are idempotent, so this is safe on a repo that already has one on.
    const endpoints = ['vulnerability-alerts', 'automated-security-fixes'];
    for (const endpoint of endpoints) {
      try {
        await exec('gh', ['api', '-X', 'PUT', `/repos/${r}/${endpoint}`], { encoding: 'utf8' });
      } catch (e) {
        const detail = String(e.stderr || e.message || '').trim().slice(0, 300);
        throw new Error(`${endpoint}: ${detail || 'gh call failed'}`);
      }
    }
    await alertsCache.refresh();
    return { repo: r, enabled: endpoints };
  }

  return { getCi, getAlerts, getSummary, prime, enableAlerts };
}

module.exports = { createMonitor, TTL_RUN_IN_FLIGHT, TTL_RUN_IDLE, TTL_ALERTS };
