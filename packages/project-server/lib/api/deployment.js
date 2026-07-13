const express = require('express');
const { execFileSync } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runOneShot: defaultRunOneShot, getOneShotStatus: defaultGetOneShotStatus } = require('../oneshot');

const CI_INVESTIGATE_MAX_DURATION_MS = 15 * 60 * 1000;
// A local-command deploy target runs a configured host command (e.g. a fastlane
// lane). Bounded so a hung lane can't wedge the request forever.
const LOCAL_DEPLOY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * What "Accept" does after the CI-fix agent proposes a change:
 *  - 'push' commits + pushes the fix to the current branch (re-runs CI).
 *  - 'pr'   commits the fix to a branch and opens a PR (CI validates before main).
 * Explicit config wins; otherwise default to the safe option for the deploy shape:
 * auto-deploy projects (push = deploy) default to 'pr' so an unverified fix can't
 * deploy straight to prod; manual-deploy projects default to 'push'.
 */
function resolveCiFixStrategy(config) {
  const dep = (config && config.deployment) || {};
  if (dep.ci_fix_strategy === 'push' || dep.ci_fix_strategy === 'pr') return dep.ci_fix_strategy;
  return dep.deployedOnPush !== false ? 'pr' : 'push';
}

/** Keep the tail of a long string (CI logs put the useful error near the end). */
function truncateTail(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  return '…(truncated)…\n' + s.slice(s.length - max);
}

/** Compose the single-pass prompt for the CI-failure investigation agent. */
function composeCiInvestigatePrompt({ repo, workflow, runId, runTitle, logExcerpt, resultFile }) {
  return [
    '== CI/CD failure investigation ==',
    "You are the DevOps agent. The project's CI/CD pipeline failed. Find the ROOT CAUSE and prepare a",
    'MINIMAL fix in the working tree — but DO NOT commit, push, tag, deploy, or open a PR. The dashboard',
    'handles that after the owner accepts your proposal.',
    '',
    `Repo: ${repo}`,
    `Workflow: ${workflow}`,
    `Failed run: ${runId}${runTitle ? ` — ${runTitle}` : ''}`,
    '',
    `Failing logs (truncated — run \`gh run view ${runId} --repo ${repo} --log-failed\` for the full log):`,
    '```',
    logExcerpt || '(no log captured — fetch it yourself with the gh command above)',
    '```',
    '',
    'Do this:',
    '1. Diagnose the root cause from the logs, the workflow file under .github/workflows/, and the code.',
    '2. Make the SMALLEST change in the working tree that makes the pipeline pass. Do not refactor unrelated'
      + ' code, bump unrelated dependencies, or reformat files.',
    '3. If the cause is environmental/external (a missing secret, flaky infra, a provider outage) and not a'
      + ' code fix you can make, change NOTHING and say so.',
    `4. Write your proposal as JSON to ${resultFile}:`,
    '   { "rootCause": "<1-3 sentences>", "summary": "<what you changed and why, 1-3 sentences>",'
      + ' "fixable": true|false, "filesChanged": ["path", ...] }',
    '',
    'Do NOT commit, push, tag, deploy, or open a PR. Keep the diff small and reviewable; touch only the files'
      + ' the fix needs.',
  ].join('\n');
}

/**
 * Resolve the project's "production SHA" — what's actually running in prod —
 * using the deploy semantics declared by config.deployment.deployedOnPush.
 *
 * - deployedOnPush=true  (example-site shape): production = `origin/main` HEAD
 *   Railway/Cloudflare-Pages-style auto-deploy watches the repo, so push = deploy.
 * - deployedOnPush=false (example-web shape): production = headSha of the most
 *   recent successful `workflow_dispatch` run of `deployment.ci_workflow`.
 *   Push alone only triggers CI; production deploy is a separate manual click.
 *
 * Returns { productionSha, productionAt, deployedOnPush } where productionSha
 * may be null when the data isn't available (no remote, no successful runs, gh
 * unauthenticated, etc.). Pure read; never throws. Top-level so status.js can
 * call it for PRD-phase derivation without going through the HTTP layer.
 */
function getDeployState(config) {
  const dep = config.deployment || {};
  const deployedOnPush = dep.deployedOnPush !== false;
  const result = { productionSha: null, productionAt: null, deployedOnPush };
  const projectRoot = config.projectRoot;

  const execGit = (args) => execFileSync('git', args, {
    cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  if (deployedOnPush) {
    try { execGit(['remote', 'get-url', 'origin']); } catch { return result; }
    try {
      const sha = execGit(['rev-parse', '--short', 'origin/main']);
      if (sha) {
        result.productionSha = sha;
        try { result.productionAt = execGit(['log', '-1', '--format=%cI', 'origin/main']); } catch {}
      }
    } catch {}
    return result;
  }

  if (!dep.repo || !dep.ci_workflow) return result;
  try {
    const runsJson = execFileSync('gh', [
      'run', 'list', '--repo', dep.repo,
      '--workflow', dep.ci_workflow,
      '--event', 'workflow_dispatch',
      '--status', 'success',
      '--limit', '1',
      '--json', 'headSha,updatedAt',
    ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const runs = JSON.parse(runsJson);
    if (runs.length > 0) {
      const fullSha = runs[0].headSha;
      if (fullSha) result.productionSha = fullSha.slice(0, 7);
      result.productionAt = runs[0].updatedAt || null;
    }
  } catch {}
  return result;
}

/**
 * Normalize one deploy target. Two kinds:
 *  - 'github-workflow' — dispatched via `gh workflow run` (web/Cloudflare etc.).
 *    `canDeploy` mirrors the legacy rule: a manual button only when production
 *    requires a dispatch click (repo + ci_workflow + deployedOnPush === false);
 *    an auto-on-push target shows as a status card with no redundant button.
 *  - 'local-command' — runs a configured host command (e.g. a fastlane lane) on
 *    the Mac; always manually deployable when a command is set.
 */
function normalizeDeployTarget(t, i) {
  const id = String((t && t.id) || `target-${i}`);
  const kind = t && t.kind === 'local-command' ? 'local-command' : 'github-workflow';
  if (kind === 'local-command') {
    const command = (t && t.command) || '';
    return {
      id, kind,
      label: (t && t.label) || id,
      command,
      cwd: (t && t.cwd) || '.',
      canDeploy: Boolean(command),
      description: (t && t.description) || (command ? `Runs \`${command}\`` : ''),
    };
  }
  const deployedOnPush = !t || t.deployedOnPush !== false;
  const repo = (t && t.repo) || null;
  const ci_workflow = (t && t.ci_workflow) || null;
  return {
    id, kind,
    label: (t && t.label) || id,
    repo, ci_workflow,
    ref: (t && t.ref) || 'main',
    deployedOnPush,
    canDeploy: Boolean(repo && ci_workflow && deployedOnPush === false),
    description: (t && t.description) || (deployedOnPush
      ? 'Deploys automatically on push to main.'
      : 'Manual workflow dispatch.'),
  };
}

/**
 * The project's deploy targets. Backward-compatible: a project without
 * `deployment.targets` gets a single synthesized 'github-workflow' target from the
 * legacy top-level fields (repo / ci_workflow / deployedOnPush) — so existing
 * projects (example-site, example-web, example-studio) behave exactly as before. A
 * project that declares `deployment.targets[]` (e.g. example-app: web GHA + iOS
 * local fastlane) gets one card per target. Pure; never throws.
 */
function resolveDeployTargets(config) {
  const dep = (config && config.deployment) || {};
  const list = Array.isArray(dep.targets) && dep.targets.length
    ? dep.targets
    : [{ id: 'default', label: 'Production', kind: 'github-workflow',
         repo: dep.repo, ci_workflow: dep.ci_workflow, deployedOnPush: dep.deployedOnPush }];
  return list.map((t, i) => normalizeDeployTarget(t, i));
}

function createDeploymentRouter(config, gitOps, {
  runOneShotFn = defaultRunOneShot,
  getOneShotStatusFn = defaultGetOneShotStatus,
} = {}) {
  const router = express.Router();
  const { projectRoot } = config;

  // runId → { resultFile } for in-flight CI-fix investigations (proposal lookup).
  const investigations = new Map();
  const AUTOFIX_FILE = path.join(projectRoot, '.build-studio', 'ci-autofix.json');
  function readAutofixEnabled() {
    try { return JSON.parse(fs.readFileSync(AUTOFIX_FILE, 'utf8')).enabled === true; } catch { return false; }
  }

  function execGit(args) {
    return execFileSync('git', args, {
      cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  }

  // GET /api/deployment — version info, changelog delta, push status
  router.get('/deployment', (req, res) => {
    const dep = config.deployment || {};
    const prefix = dep.tag_prefix || 'v';

    let latestTag = null;
    let nextVersion = null;
    let ahead = 0;
    let behind = 0;

    // Latest tag + its annotation message
    let tagMessage = null;
    try {
      latestTag = execGit(['describe', '--tags', '--abbrev=0', '--match', `${prefix}*`]);
      tagMessage = execGit(['tag', '-l', '--format=%(contents:subject)', latestTag]);
    } catch {} // no tags yet

    // Changelog: commits a push/deploy would publish. Resolve the compare ref in
    // priority order so this works on ANY branch — not just one whose name happens
    // to match a remote-tracking ref:
    //   1. the branch's own upstream (@{upstream}) — what `git push` updates
    //   2. the remote's default branch (origin/HEAD, e.g. origin/main) — correct
    //      for a feature branch never pushed: its push delta IS origin/main..HEAD
    //      (exactly the commits the remote doesn't yet have)
    //   3. no usable remote ref — fall back to recent local commits
    // This previously hard-coded `origin/<branch>`, which threw (and was silently
    // swallowed) on any unpushed branch, leaving an empty changelog + ahead=0 —
    // making the tab read "up to date" and disabling the Push button.
    const parseLog = (log) => (log
      ? log.split('\n').map(line => {
          const [hash, subject, author, date] = line.split('|');
          return { hash, subject, author, date };
        })
      : []);

    let deployCommits = [];
    let hasRemote = false;
    let compareRef = null;
    try {
      execGit(['remote', 'get-url', 'origin']);
      hasRemote = true;
    } catch {}

    if (hasRemote) {
      // 1. branch upstream, if the branch tracks one
      try { compareRef = execGit(['rev-parse', '--abbrev-ref', '@{upstream}']); } catch {}
      // 2. else the remote's default branch (origin/HEAD → e.g. origin/main)
      if (!compareRef) {
        try { compareRef = execGit(['rev-parse', '--abbrev-ref', 'origin/HEAD']); } catch {}
      }
    }

    if (compareRef) {
      try { deployCommits = parseLog(execGit(['log', `${compareRef}..HEAD`, '--format=%h|%s|%an|%ai'])); } catch {}
    } else {
      // No remote (or no resolvable remote-tracking ref) — show recent local commits.
      try { deployCommits = parseLog(execGit(['log', '-20', '--format=%h|%s|%an|%ai'])); } catch {}
    }

    // Compute next version (same logic as tagAndPush)
    if (dep.versioning === 'calver') {
      const now = new Date();
      const datePart = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
      let build = 0;
      try {
        const tags = execGit(['tag', '-l', `${prefix}${datePart}*`]);
        if (tags) build = tags.split('\n').length;
      } catch {}
      nextVersion = `${prefix}${build > 0 ? `${datePart}.${build}` : datePart}`;
    } else if (dep.versioning !== 'none') {
      let latest = dep.initial_version || '0.1.0';
      if (latestTag) {
        latest = latestTag.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '');
      }
      const parts = latest.split('.').map(Number);
      parts[2] = (parts[2] || 0) + 1;
      nextVersion = `${prefix}${parts.join('.')}`;
    }

    // Ahead/behind counts against the same compare ref used for the changelog.
    if (compareRef) {
      try { ahead = parseInt(execGit(['rev-list', '--count', `${compareRef}..HEAD`])) || 0; } catch {}
      try { behind = parseInt(execGit(['rev-list', '--count', `HEAD..${compareRef}`])) || 0; } catch {}
    }

    // Working-tree file lists (staged / modified / untracked) so the CI/CD tab
    // can show what's pending without forcing the user to ask an agent or run
    // git status manually. Same source as the Status tab's git counts.
    let workingTree = { stagedFiles: [], unstagedFiles: [], untrackedFiles: [] };
    if (gitOps && typeof gitOps.getStatus === 'function') {
      const s = gitOps.getStatus();
      workingTree = {
        stagedFiles: s.stagedFiles || [],
        unstagedFiles: s.unstagedFiles || [],
        untrackedFiles: s.untrackedFiles || [],
      };
    }

    res.json({
      latestTag,
      tagMessage,
      nextVersion,
      deployCommits,
      ahead,
      behind,
      hasRemote,
      autoTag: dep.auto_tag !== false,
      versioning: dep.versioning || 'semver',
      // Deploy button is meaningful only when production updates REQUIRE a manual
      // workflow_dispatch click (example-web shape: ci_workflow set + deployedOnPush=false).
      // Hide it for:
      //   - Projects with no ci_workflow (example-site / Railway-watching: push = deploy)
      //   - Hybrid projects where push ALSO deploys (example-app: deployedOnPush=true).
      //     Even though the workflow is workflow_dispatch-triggerable, the button is
      //     redundant for the normal flow and misleads operators into thinking it's required.
      canDeploy: Boolean(dep.repo && dep.ci_workflow && dep.deployedOnPush === false),
      // Multi-target deploy model (PRD-033 / ADR-024 D-5): one card per target —
      // a project can deploy web (github-workflow) AND iOS (local fastlane lane)
      // as distinct, clearly-labelled targets. Backward-compatible (synthesized
      // single target when `deployment.targets` is absent).
      targets: resolveDeployTargets(config),
      // CI Status panel only needs `repo` (it lists recent runs regardless of trigger).
      canShowCiStatus: Boolean(dep.repo),
      // CI-fix investigation is available when we can read GitHub runs (repo set).
      canInvestigateCi: Boolean(dep.repo),
      ciFixStrategy: resolveCiFixStrategy(config),
      ...workingTree,
    });
  });

  // POST /api/deployment/commit-all — stage every working-tree change
  // (staged + modified + untracked) and commit with the supplied message.
  router.post('/deployment/commit-all', (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'Commit message required' });

    let porcelain = '';
    try {
      porcelain = execGit(['status', '--porcelain']);
    } catch (e) {
      return res.status(500).json({ error: `git status failed: ${e.message}` });
    }
    if (!porcelain) return res.status(400).json({ error: 'Nothing to commit — working tree is clean' });

    try {
      execGit(['add', '-A']);
    } catch (e) {
      return res.status(500).json({ error: `git add failed: ${e.message}` });
    }

    try {
      // Disable signing/hooks-noise toggles? No — respect the project's git config
      // exactly the way a manual `git commit` would. The button is convenience,
      // not a way to bypass anything the user has configured locally.
      execGit(['commit', '-m', message]);
    } catch (e) {
      return res.status(500).json({ error: `git commit failed: ${e.message}` });
    }

    let hash = '';
    try { hash = execGit(['rev-parse', '--short', 'HEAD']); } catch {}

    res.json({ ok: true, hash, message });
  });

  // POST /api/deployment/push — push main + tags to origin
  router.post('/deployment/push', (req, res) => {
    try {
      execGit(['remote', 'get-url', 'origin']);
    } catch {
      return res.status(400).json({ error: 'No remote "origin" configured' });
    }

    const results = [];
    try {
      const branch = execGit(['branch', '--show-current']);
      execGit(['push', 'origin', branch]);
      results.push(`Pushed ${branch} to origin`);
    } catch (e) {
      return res.status(500).json({ error: `Push failed: ${e.message}` });
    }

    // Push tags
    try {
      execGit(['push', 'origin', '--tags']);
      results.push('Pushed tags');
    } catch (e) {
      results.push(`Tag push failed: ${e.message}`);
    }

    res.json({ ok: true, results });
  });

  // GET /api/services — dev_commands with live port status
  router.get('/services', async (req, res) => {
    const devCommands = config.dev_commands || [];
    const services = await Promise.all(devCommands.map(async (svc) => {
      let up = false;
      if (svc.port) {
        up = await checkPort(svc.port);
      }
      return {
        name: svc.name,
        cmd: svc.cmd,
        cwd: svc.cwd || null,
        port: svc.port || null,
        type: svc.type || null,
        up,
      };
    }));

    // Also check portals
    const portals = (config.portals || []).map(p => {
      const match = p.url.match(/localhost:(\d+)/);
      return { name: p.name, url: p.url, port: match ? parseInt(match[1]) : null };
    });
    const portalStatuses = await Promise.all(portals.map(async (p) => ({
      name: p.name,
      url: p.url,
      port: p.port,
      up: p.port ? await checkPort(p.port) : false,
    })));

    res.json({ services, portals: portalStatuses });
  });

  // POST /api/deployment/deploy — trigger a deploy target.
  // Body { targetId } selects the target (defaults to the first). Dispatch by kind:
  //   github-workflow → `gh workflow run` (web/Cloudflare etc.)
  //   local-command   → run the configured host command (e.g. a fastlane lane)
  // No body / no targets[] → the synthesized default target (legacy behaviour).
  router.post('/deployment/deploy', (req, res) => {
    const targets = resolveDeployTargets(config);
    const targetId = req.body && req.body.targetId;
    const target = targetId ? targets.find(t => t.id === targetId) : targets[0];
    if (!target) {
      return res.status(400).json({ error: `Unknown deploy target "${targetId}"` });
    }
    if (!target.canDeploy) {
      return res.status(400).json({ error: `Target "${target.id}" is not manually deployable` });
    }

    if (target.kind === 'local-command') {
      // The command is owner-config (same trust as dev_commands); run it in its cwd.
      const cwd = path.resolve(projectRoot, target.cwd || '.');
      try {
        const out = execFileSync('/bin/sh', ['-c', target.command], {
          cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
          timeout: LOCAL_DEPLOY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024,
        });
        return res.json({ ok: true, kind: target.kind, message: `Ran ${target.label}`, output: truncateTail(out, 4000) });
      } catch (e) {
        return res.status(500).json({
          error: `${target.label} failed: ${e.stderr || e.message}`,
          output: truncateTail(e.stdout || '', 4000),
        });
      }
    }

    // github-workflow
    if (!target.repo || !target.ci_workflow) {
      return res.status(400).json({ error: `Target "${target.id}": repo and ci_workflow must be set` });
    }
    try {
      execFileSync('gh', ['workflow', 'run', target.ci_workflow, '--repo', target.repo, '--ref', target.ref || 'main'], {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      res.json({ ok: true, kind: target.kind, message: `Triggered ${target.ci_workflow} on ${target.repo}` });
    } catch (e) {
      res.status(500).json({ error: `Deploy trigger failed: ${e.stderr || e.message}` });
    }
  });

  // GET /api/deployment/ci-status — poll latest CI run status
  router.get('/deployment/ci-status', (req, res) => {
    const dep = config.deployment || {};
    const repo = dep.repo;
    if (!repo) {
      return res.status(400).json({ error: 'deployment.repo not set' });
    }
    try {
      // Scope to the configured deploy workflow so unrelated runs (Dependabot
      // PRs, other workflows) don't surface here. When deployedOnPush=false
      // the deploy job only fires on workflow_dispatch — narrowing the event
      // avoids showing push runs whose deploy step is correctly skipped.
      const runListArgs = ['run', 'list', '--repo', repo, '--limit', '1'];
      if (dep.ci_workflow) {
        runListArgs.push('--workflow', dep.ci_workflow);
        if (dep.deployedOnPush === false) {
          runListArgs.push('--event', 'workflow_dispatch');
        } else {
          runListArgs.push('--branch', 'main');
        }
      }
      runListArgs.push('--json', 'databaseId,status,conclusion,displayTitle,createdAt,updatedAt,event');
      const runsJson = execFileSync('gh', runListArgs, {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
      const runs = JSON.parse(runsJson);
      if (!runs.length) {
        return res.json({ run: null });
      }
      const run = runs[0];

      // Fetch per-job detail
      let jobs = [];
      try {
        const jobsJson = execFileSync('gh', [
          'run', 'view', String(run.databaseId), '--repo', repo,
          '--json', 'jobs',
        ], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        const parsed = JSON.parse(jobsJson);
        jobs = (parsed.jobs || []).map(j => ({
          name: j.name,
          status: j.status,
          conclusion: j.conclusion,
          startedAt: j.startedAt,
          completedAt: j.completedAt,
        }));
      } catch {}

      res.json({
        run: {
          id: run.databaseId,
          status: run.status,
          conclusion: run.conclusion,
          title: run.displayTitle,
          event: run.event,
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
        },
        jobs,
      });
    } catch (e) {
      res.status(500).json({ error: `CI status check failed: ${e.stderr || e.message}` });
    }
  });

  // ─── CI-fix investigation ────────────────────────────────────────────────

  // GET/POST /api/deployment/ci-autofix — persist the "auto-investigate on failure" toggle.
  router.get('/deployment/ci-autofix', (req, res) => {
    res.json({ enabled: readAutofixEnabled() });
  });
  router.post('/deployment/ci-autofix', (req, res) => {
    const enabled = req.body && req.body.enabled === true;
    try {
      fs.mkdirSync(path.dirname(AUTOFIX_FILE), { recursive: true });
      fs.writeFileSync(AUTOFIX_FILE, JSON.stringify({ enabled }, null, 2) + '\n', 'utf8');
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    res.json({ enabled });
  });

  // POST /api/deployment/ci-investigate — fire the DevOps agent to diagnose the latest
  // (or a given) failing run and prepare a minimal fix in the working tree (uncommitted).
  router.post('/deployment/ci-investigate', (req, res) => {
    const dep = config.deployment || {};
    const repo = dep.repo;
    if (!repo) return res.status(400).json({ error: 'deployment.repo not set' });

    // Require a clean tree so the agent's fix is isolated and Dismiss can revert
    // exactly its changes (stash-drop) without touching pre-existing work.
    let porcelain;
    try { porcelain = execGit(['status', '--porcelain']); }
    catch (e) { return res.status(500).json({ error: `git status failed: ${e.message}` }); }
    if (porcelain) {
      return res.status(409).json({ error: 'Working tree has uncommitted changes — commit or stash them before investigating.' });
    }

    // Resolve the run: explicit runId, else the latest run for the deploy workflow.
    // runId flows into `gh run view <id>` argv — validate it as a positive integer
    // (GitHub run IDs always are) so a value like "--flag" can't be smuggled as a
    // gh flag (argument injection).
    let runId = null;
    let runTitle = String((req.body && req.body.runTitle) || '').slice(0, 200);
    if (req.body && req.body.runId !== undefined && req.body.runId !== null && req.body.runId !== '') {
      const id = Number.parseInt(String(req.body.runId), 10);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'runId must be a positive integer' });
      }
      runId = id;
    }
    if (!runId) {
      try {
        const args = ['run', 'list', '--repo', repo, '--limit', '1', '--json', 'databaseId,displayTitle'];
        if (dep.ci_workflow) {
          args.push('--workflow', dep.ci_workflow);
          if (dep.deployedOnPush === false) args.push('--event', 'workflow_dispatch');
          else args.push('--branch', 'main');
        }
        const runs = JSON.parse(execFileSync('gh', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim());
        if (!runs.length) return res.status(404).json({ error: 'No CI runs found to investigate' });
        runId = runs[0].databaseId;
        runTitle = runs[0].displayTitle || runTitle;
      } catch (e) {
        return res.status(500).json({ error: `Could not list CI runs: ${e.stderr || e.message}` });
      }
    }

    // Capture a failing-log excerpt for the prompt (best-effort; the agent can re-fetch).
    // runId is a validated positive integer; `--` ends flag parsing as belt-and-suspenders.
    let logExcerpt = '';
    try {
      const full = execFileSync('gh', ['run', 'view', '--repo', repo, '--log-failed', '--', String(runId)],
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
      logExcerpt = truncateTail(full, 16000);
    } catch {
      try {
        const summary = execFileSync('gh', ['run', 'view', '--repo', repo, '--', String(runId)],
          { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
        logExcerpt = truncateTail(summary, 8000);
      } catch {}
    }

    const resultDir = path.join(projectRoot, 'tmp', 'ci-investigate');
    try { fs.mkdirSync(resultDir, { recursive: true }); } catch {}
    const resultFile = path.join(resultDir, `${crypto.randomBytes(8).toString('hex')}.json`);

    const prompt = composeCiInvestigatePrompt({
      repo, workflow: dep.ci_workflow || '(default branch CI)', runId, runTitle, logExcerpt, resultFile,
    });

    let result;
    try {
      result = runOneShotFn({
        projectRoot,
        prompt,
        label: 'ci-investigate',
        maxDurationMs: CI_INVESTIGATE_MAX_DURATION_MS,
        agentDefaults: config.agent_defaults,
      });
    } catch (e) {
      if (e.code === 'CONFLICT') return res.status(409).json({ error: e.message });
      return res.status(500).json({ error: e.message });
    }
    investigations.set(result.runId, { resultFile });
    res.json({ runId: result.runId, sessionName: result.sessionName });
  });

  // GET /api/deployment/ci-investigate/:runId/status — poll; on completion returns the proposal.
  router.get('/deployment/ci-investigate/:runId/status', (req, res) => {
    const { runId } = req.params;
    const entry = getOneShotStatusFn(runId);
    if (!entry) return res.status(404).json({ error: 'investigation not found' });

    const out = { state: entry.state };
    if (entry.state === 'complete') {
      const info = investigations.get(runId) || {};
      let proposal = { rootCause: '', summary: '', fixable: null, filesChanged: [] };
      if (info.resultFile) {
        try { proposal = { ...proposal, ...JSON.parse(fs.readFileSync(info.resultFile, 'utf8')) }; } catch {}
      }
      let diff = '';
      try { diff = execGit(['diff']); } catch {}
      let untracked = [];
      try { untracked = execGit(['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean); } catch {}
      out.proposal = { ...proposal, diff, untracked, hasChanges: Boolean(diff) || untracked.length > 0 };
    } else if (entry.state === 'error' || entry.state === 'timeout') {
      out.error = entry.stderr || entry.state;
    }
    res.json(out);
  });

  // POST /api/deployment/ci-fix-accept — commit + push the fix (or open a PR per strategy).
  router.post('/deployment/ci-fix-accept', (req, res) => {
    let porcelain;
    try { porcelain = execGit(['status', '--porcelain']); }
    catch (e) { return res.status(500).json({ error: `git status failed: ${e.message}` }); }
    if (!porcelain) return res.status(400).json({ error: 'No fix to accept — working tree is clean.' });

    const strategy = resolveCiFixStrategy(config);
    const summary = String(req.body?.summary || '').trim();
    const commitMsg = `fix(ci): ${summary || 'repair failing pipeline'}`;

    try {
      if (strategy === 'pr') {
        const orig = execGit(['branch', '--show-current']) || 'main';
        const branch = `ci-fix-${Date.now()}`;
        execGit(['checkout', '-b', branch]);
        execGit(['add', '-A']);
        execGit(['commit', '-m', commitMsg]);
        execGit(['push', '-u', 'origin', branch]);
        let prUrl = '';
        try {
          prUrl = execFileSync('gh', ['pr', 'create', '--repo', config.deployment.repo,
            '--head', branch, '--title', commitMsg, '--body', summary || 'Automated CI fix.'],
            { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        } catch {}
        try { execGit(['checkout', orig]); } catch {}
        return res.json({ ok: true, mode: 'pr', branch, prUrl });
      }
      // push
      execGit(['add', '-A']);
      execGit(['commit', '-m', commitMsg]);
      const branch = execGit(['branch', '--show-current']);
      execGit(['push', 'origin', branch]);
      const hash = execGit(['rev-parse', '--short', 'HEAD']);
      return res.json({ ok: true, mode: 'push', hash, branch });
    } catch (e) {
      return res.status(500).json({ error: `Accept failed: ${e.stderr || e.message}` });
    }
  });

  // POST /api/deployment/ci-fix-dismiss — revert the agent's working-tree changes.
  router.post('/deployment/ci-fix-dismiss', (req, res) => {
    try {
      const porcelain = execGit(['status', '--porcelain']);
      if (porcelain) {
        // Clean-tree-at-investigate precondition means everything here is the agent's;
        // stash (incl. untracked) then drop reverts tracked edits AND removes new files.
        execGit(['stash', 'push', '--include-untracked', '-m', 'ci-fix-dismiss']);
        try { execGit(['stash', 'drop']); } catch {}
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: `Dismiss failed: ${e.stderr || e.message}` });
    }
  });

  return router;
}

function checkPort(port) {
  return new Promise((resolve) => {
    // Try IPv4 first, fall back to IPv6 (Vite/Node often bind to ::1 on macOS)
    const tryConnect = (host) => new Promise((res) => {
      const sock = new net.Socket();
      sock.setTimeout(1000);
      sock.once('connect', () => { sock.destroy(); res(true); });
      sock.once('error', () => { sock.destroy(); res(false); });
      sock.once('timeout', () => { sock.destroy(); res(false); });
      sock.connect(port, host);
    });
    tryConnect('127.0.0.1').then(up => up ? resolve(true) : tryConnect('::1').then(resolve));
  });
}

module.exports = { createDeploymentRouter, getDeployState, resolveDeployTargets, normalizeDeployTarget, resolveCiFixStrategy, composeCiInvestigatePrompt, truncateTail };
