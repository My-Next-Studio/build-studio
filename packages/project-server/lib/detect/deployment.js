'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Inspect the project's git remote and CI/CD configuration to pre-fill
 * .build-studio/config.yaml `deployment:` block.
 *
 * Returns:
 *   {
 *     repo:           '<owner>/<repo>' parsed from `git remote get-url origin`, or null
 *     ciWorkflow:     filename of the first .github/workflows/*.yml that has
 *                     `workflow_dispatch:` in it, or null. Used by the Deploy button.
 *     autoDeployHint: 'cloudflare-pages' | 'vercel' | 'railway' | 'netlify' | null
 *                     when an external auto-deploy provider is configured in the repo.
 *     deployedOnPush: inferred default for config.yaml — true when no manual
 *                     workflow_dispatch is configured (push = deploy), false otherwise.
 *   }
 *
 * Pure read; never throws. Missing tools (git, fs failures) all degrade to nulls.
 */
function detectDeployment(projectRoot) {
  const ciWorkflow = detectCiWorkflow(projectRoot);
  return {
    repo: detectRepo(projectRoot),
    ciWorkflow,
    autoDeployHint: detectAutoDeployHint(projectRoot),
    // Hybrid case: a workflow can trigger on BOTH `push: branches: [main]` AND
    // `workflow_dispatch:`. In that case push IS the deploy (the manual button
    // is just a re-trigger). Only set deployedOnPush=false when there's a
    // workflow_dispatch-shaped workflow whose push trigger does NOT include main.
    deployedOnPush: !ciWorkflow || ciWorkflowDeploysOnPush(projectRoot, ciWorkflow),
  };
}

/**
 * Inspect the chosen ci_workflow's `on:` block. Returns true when the workflow
 * also triggers on a push to main/master (the production branch), meaning a
 * push to main = production deploy regardless of workflow_dispatch's existence.
 */
function ciWorkflowDeploysOnPush(projectRoot, ciWorkflow) {
  if (!ciWorkflow) return false;
  let content;
  try { content = fs.readFileSync(path.join(projectRoot, '.github', 'workflows', ciWorkflow), 'utf8'); }
  catch { return false; }
  // Find the `on:` block start, then check up to the next top-level key (or
  // end of file) for a `push:` trigger that includes main/master. This is
  // intentionally a string scan — we don't want a YAML dependency just for
  // this heuristic. Note: JS RegExp has no `\Z`, so end-of-string is matched
  // by an alternative branch in the lookahead via the lack of any trailing
  // top-level key.
  const onMatch = content.match(/^on\s*:/m);
  if (!onMatch) return false;
  const after = content.slice(onMatch.index + onMatch[0].length);
  // Slice up to the next line that starts with a non-whitespace character.
  const nextTopLevel = after.search(/\n\S/);
  const onBlock = nextTopLevel === -1 ? after : after.slice(0, nextTopLevel);
  // Reject when push: is absent.
  if (!/^\s+push\s*:/m.test(onBlock)) return false;
  // Look for branches list. Common shapes:
  //   push:\n    branches: [main]
  //   push:\n    branches:\n      - main
  //   push:                 (no branches → triggers on every push, treat as main-included)
  const branchesMatch = onBlock.match(/push\s*:[\s\S]*?branches\s*:\s*(\[[^\]]*\]|(?:\n\s+-\s*[\w/-]+)+)/);
  if (!branchesMatch) {
    // `push:` with no branches filter → triggers on every push, including main.
    return true;
  }
  const branchesText = branchesMatch[1];
  return /\bmain\b|\bmaster\b/.test(branchesText);
}

function detectRepo(projectRoot) {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    return parseGithubOwnerRepo(url);
  } catch { return null; }
}

/**
 * Parse `<owner>/<repo>` from any of the canonical GitHub remote URL forms:
 *   git@github.com:owner/repo.git
 *   https://github.com/owner/repo.git
 *   https://github.com/owner/repo
 *   ssh://git@github.com/owner/repo.git
 * Returns null for unrecognized hosts (we only know how to drive GitHub today).
 */
function parseGithubOwnerRepo(url) {
  if (!url) return null;
  const m = url.match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  return `${m[1]}/${m[2]}`;
}

/**
 * Identify a manually-triggerable deploy workflow.
 *
 * `workflow_dispatch` alone is necessary but not sufficient — many repos have
 * scheduled health checks, manual backup runs, or test triggers that also use
 * workflow_dispatch but are NOT what the Deploy button should fire. So we also
 * require the workflow name OR filename OR a job name to look deploy-shaped
 * ("deploy", "release", "publish", "promote").
 *
 * If multiple candidates qualify, prefer the most explicitly deploy-named one
 * (filename signal beats job-name signal beats name-field signal).
 */
function detectCiWorkflow(projectRoot) {
  const dir = path.join(projectRoot, '.github', 'workflows');
  if (!fs.existsSync(dir)) return null;
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml')); }
  catch { return null; }

  // Keywords are intentionally narrow — broader terms ("prod", "production") trip
  // false positives like prod-monitor.yml or production-snapshot workflows.
  const DEPLOY_KEYWORD_RE = /\b(deploy|release|publish|promote)\b/i;
  const candidates = []; // { f, score, hasDispatch }
  for (const f of files) {
    let content;
    try { content = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    if (!/^\s*workflow_dispatch\s*:/m.test(content)) continue;

    let score = 0;
    if (DEPLOY_KEYWORD_RE.test(f)) score += 4;            // strongest signal: filename
    const nameMatch = content.match(/^\s*name\s*:\s*(.+)$/m);
    if (nameMatch && DEPLOY_KEYWORD_RE.test(nameMatch[1])) score += 2;
    // Look for a top-level job named deploy/release/publish.
    if (/^\s+(deploy|release|publish|promote)\s*:/im.test(content)) score += 3;

    if (score > 0) candidates.push({ f, score });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || a.f.localeCompare(b.f));
  return candidates[0].f;
}

function detectAutoDeployHint(projectRoot) {
  if (fs.existsSync(path.join(projectRoot, 'wrangler.jsonc')) ||
      fs.existsSync(path.join(projectRoot, 'wrangler.toml'))) {
    return 'cloudflare-pages';
  }
  if (fs.existsSync(path.join(projectRoot, 'vercel.json'))) return 'vercel';
  if (fs.existsSync(path.join(projectRoot, 'railway.json')) ||
      fs.existsSync(path.join(projectRoot, 'railway.toml'))) {
    return 'railway';
  }
  if (fs.existsSync(path.join(projectRoot, 'netlify.toml'))) return 'netlify';
  // Cloudflare Pages can also be detected by .github/workflows containing the
  // pages-action, but we don't need to be heroic — the wrangler config is the
  // canonical signal for Pages and Workers.
  return null;
}

module.exports = { detectDeployment, parseGithubOwnerRepo };
