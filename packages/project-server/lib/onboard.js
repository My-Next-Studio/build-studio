'use strict';

/**
 * onboardProject — bootstrap an EXISTING project for Build Studio management.
 *
 * Sibling of `scaffoldProject` (lib/scaffold.js) but with the inverse contract:
 * never overwrite, never touch git history. Workflow synthesis (vision,
 * project-state, ADR-001) happens later via the Onboarding workflow; this
 * function only does deterministic, reversible filesystem prep.
 *
 * See PRD-001 (docs/prds/PRD-001-onboard-existing-projects.md) §2.1 for the
 * full contract.
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { execFileSync } = require('child_process');

const { detectPreset } = require('./detect/preset');
const { detectDeployment } = require('./detect/deployment');
const { detectDevCommands } = require('./detect/dev-commands');
const { detectExistingDocs } = require('./detect/existing-docs');

const PROJECT_FILE_MARKERS = [
  'package.json', 'Podfile', 'Cargo.toml', 'go.mod', 'pyproject.toml', 'Gemfile', 'composer.json',
];

const LEARNING_CATEGORIES = ['architecture', 'backend', 'frontend', 'devops', 'qa', 'security', 'workflow'];

/**
 * Validate inputs and run all four detectors. Used by both the dry-run
 * preview endpoint and the full scaffold. Throws with structured `code`
 * fields the API layer maps to HTTP status codes.
 */
function detectAll(targetPath) {
  if (!targetPath || !fs.existsSync(targetPath)) {
    throw makeErr('Target path does not exist', 'PATH_MISSING');
  }

  // git repo check
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: targetPath, stdio: 'ignore' });
  } catch {
    throw makeErr('Target path is not inside a git repo. Use New Project for empty directories.', 'NOT_GIT_REPO');
  }

  // recognizable code
  const hasCode = PROJECT_FILE_MARKERS.some((f) => fs.existsSync(path.join(targetPath, f)));
  if (!hasCode) {
    throw makeErr(
      'No recognizable project file found (package.json, Podfile, Cargo.toml, go.mod, pyproject.toml, Gemfile, or composer.json). Use New Project for empty directories.',
      'NO_CODE'
    );
  }

  const presetResult = detectPreset(targetPath);
  if (presetResult.preset === 'monorepo') {
    throw makeErr(
      'Monorepo onboarding not yet supported (PRD-001 v1). See build-studio PRD-001 §3.1 for v2/v3 timeline.',
      'MONOREPO_NOT_SUPPORTED'
    );
  }

  const deployment = detectDeployment(targetPath);
  const dev = detectDevCommands(targetPath);
  const existingDocs = detectExistingDocs(targetPath);

  return { presetResult, deployment, dev, existingDocs };
}

/**
 * Dry-run: returns what onboardProject would scaffold without writing anything.
 * Used by POST /api/projects/onboard/preview to populate the dialog's preview pane.
 */
async function previewOnboard(targetPath) {
  const { presetResult, deployment, dev, existingDocs } = detectAll(targetPath);
  return {
    preset: presetResult.preset,
    presetReason: presetResult.reason,
    deployment,
    devCommands: dev.devCommands,
    existingDocs: existingDocs.docs,
    existingDocCounts: existingDocs.counts,
    claudeMdPresent: existingDocs.claudeMdPresent,
    agentsMdPresent: existingDocs.agentsMdPresent,
    specsDirPresent: existingDocs.specsDirPresent,
  };
}

/**
 * Scaffold an existing project for dashboard management.
 *
 * @param {string} targetPath
 * @param {object} options - { name, port }
 * @returns {Promise<object>} - { preset, deployment, devCommands, written: [], skipped: [] }
 */
async function onboardProject(targetPath, options = {}) {
  if (!options.name) throw makeErr('options.name is required', 'NAME_REQUIRED');
  if (!options.port) throw makeErr('options.port is required', 'PORT_REQUIRED');

  // Refuse if already initialized — same shape as POST /api/projects/init returns.
  const existingConfig = path.join(targetPath, '.build-studio', 'config.yaml');
  if (fs.existsSync(existingConfig)) {
    throw makeErr(
      `Project already initialized at this path: ${existingConfig}`,
      'CONFIG_EXISTS'
    );
  }

  const { presetResult, deployment, dev, existingDocs } = detectAll(targetPath);

  const written = [];
  const skipped = [];

  // ─── 1. .build-studio/config.yaml (deterministic — never exists per check above) ──
  const configDir = path.join(targetPath, '.build-studio');
  fs.mkdirSync(configDir, { recursive: true });
  const cfgYaml = renderConfigYaml({
    name: options.name,
    port: options.port,
    preset: presetResult.preset,
    deployment,
    devCommands: dev.devCommands,
  });
  writeIfAbsent(path.join(configDir, 'config.yaml'), cfgYaml, written, skipped, '.build-studio/config.yaml');

  // ─── 2. .claude/commands/ (per-file skip if present) ──────────────────────
  const templateDir = templateRoot();
  const cmdSrc = path.join(templateDir, '.claude', 'commands');
  const cmdDst = path.join(targetPath, '.claude', 'commands');
  fs.mkdirSync(cmdDst, { recursive: true });
  if (fs.existsSync(cmdSrc)) {
    for (const f of fs.readdirSync(cmdSrc)) {
      copyIfAbsent(path.join(cmdSrc, f), path.join(cmdDst, f), `.claude/commands/${f}`, written, skipped);
    }
  }

  // ─── 3. .claude/settings.json (only if absent) ────────────────────────────
  const settingsSrc = path.join(templateDir, '.claude', 'settings.json');
  if (fs.existsSync(settingsSrc)) {
    copyIfAbsent(settingsSrc, path.join(targetPath, '.claude', 'settings.json'), '.claude/settings.json', written, skipped);
  }

  // ─── 4. .claude/skills/ (only if absent — copy whole tree only when none exist) ─
  const skillsSrc = path.join(templateDir, '.claude', 'skills');
  const skillsDst = path.join(targetPath, '.claude', 'skills');
  if (fs.existsSync(skillsSrc) && !fs.existsSync(skillsDst)) {
    copyDir(skillsSrc, skillsDst);
    written.push('.claude/skills/');
  } else if (fs.existsSync(skillsDst)) {
    skipped.push('.claude/skills/');
  }

  // ─── 5a. .gitignore — append runtime patterns (idempotent) ────────────────
  // Without this, the owner_signoff commit captures every prompt-*.txt,
  // start-*.sh, snapshot, and workflow-state.json the dashboard wrote.
  // Pilot (example-app, 2026-04-27) had to be cleaned up with `git rm --cached`
  // because this step was missing on first onboards.
  ensureGitignorePatterns(targetPath, written, skipped);

  // ─── 5. Empty workflow scaffolding (.gitkeep'd dirs) ──────────────────────
  ensureDirWithGitkeep(path.join(targetPath, 'docs', 'prds'), 'docs/prds/.gitkeep', written);
  copyIfAbsent(path.join(templateDir, 'docs', 'prds', 'TEMPLATE.md'),
    path.join(targetPath, 'docs', 'prds', 'TEMPLATE.md'), 'docs/prds/TEMPLATE.md', written, skipped);
  copyIfAbsent(path.join(templateDir, 'docs', 'asset-register.md'),
    path.join(targetPath, 'docs', 'asset-register.md'), 'docs/asset-register.md', written, skipped);
  {
    const { ensureManifest } = require('./knowledge-manifest');
    const manifestPath = path.join(targetPath, 'docs', 'knowledge.yaml');
    const existed = fs.existsSync(manifestPath);
    if (ensureManifest(targetPath, { name: options.name }) && !existed) written.push('docs/knowledge.yaml');
    else if (existed) skipped.push('docs/knowledge.yaml');
  }
  for (const cat of LEARNING_CATEGORIES) {
    ensureDirWithGitkeep(
      path.join(targetPath, 'docs', 'learnings', cat),
      `docs/learnings/${cat}/.gitkeep`,
      written
    );
  }
  fs.mkdirSync(path.join(targetPath, 'tmp'), { recursive: true });

  // ─── 6. docs/onboarding/inventory.json (consumed by the discovery agent) ──
  const inventory = {
    detectedAt: new Date().toISOString(),
    preset: presetResult.preset,
    presetReason: presetResult.reason,
    stack: stackHints(targetPath),
    deployment,
    devCommands: dev.devCommands,
    existingDocs: existingDocs.docs,
    claudeMdPresent: existingDocs.claudeMdPresent,
    agentsMdPresent: existingDocs.agentsMdPresent,
    specsDirPresent: existingDocs.specsDirPresent,
    counts: existingDocs.counts,
    git: gitInventory(targetPath),
    shape: shapeFromExistingDocs(existingDocs, presetResult.preset),
  };
  fs.mkdirSync(path.join(targetPath, 'docs', 'onboarding'), { recursive: true });
  fs.writeFileSync(
    path.join(targetPath, 'docs', 'onboarding', 'inventory.json'),
    JSON.stringify(inventory, null, 2) + '\n'
  );
  written.push('docs/onboarding/inventory.json');

  return {
    preset: presetResult.preset,
    deployment,
    devCommands: dev.devCommands,
    inventory,
    written,
    skipped,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function makeErr(message, code) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function templateRoot() {
  // Templates may live at one of several places depending on how project-server
  // was loaded (source tree vs. Electron bundle). Same multi-candidate strategy
  // status.js uses for `.claude/commands/` resolution.
  const suffix = path.join('templates', 'default');
  const candidates = [
    // Source tree: lib/ → project-server/ → packages/ → repo root
    path.resolve(__dirname, '..', '..', '..', suffix),
    // Electron bundle, hub-loaded copy: lib/ → project-server/ → @build-studio/ → node_modules/ → standalone/ → Resources/
    path.resolve(__dirname, '..', '..', '..', '..', '..', suffix),
    // Electron bundle, extraResources copy: lib/ → project-server/ → Resources/
    path.resolve(__dirname, '..', '..', suffix),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fall back to the original (will fail loudly if templates are truly missing).
  return candidates[0];
}

function writeIfAbsent(absPath, content, written, skipped, label) {
  if (fs.existsSync(absPath)) { skipped.push(label); return false; }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
  written.push(label);
  return true;
}

function copyIfAbsent(src, dst, label, written, skipped) {
  if (fs.existsSync(dst)) { skipped.push(label); return false; }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  written.push(label);
  return true;
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function ensureDirWithGitkeep(absDir, gitkeepLabel, written) {
  fs.mkdirSync(absDir, { recursive: true });
  const keep = path.join(absDir, '.gitkeep');
  if (!fs.existsSync(keep)) {
    fs.writeFileSync(keep, '');
    written.push(gitkeepLabel);
  }
}

// Patterns the build-studio runtime writes into a managed project — must
// stay out of git regardless of preset. Mirrors what example-site and
// example-web have in their .gitignore today (cross-project convention).
const BUILD_STUDIO_GITIGNORE_PATTERNS = [
  '',
  '# Build Studio runtime state — ephemeral, machine-local, regenerated as workflows run',
  '.build-studio/workflow-state.json',
  '.build-studio/run-state.json',
  '.build-studio/snapshots/',
  '.build-studio/*.bak*',
  'docs/agent-status.json',
  'tmp/',
  '',
  '# Per-workflow agent launch artifacts (transient — written by the run/workflow engine)',
  'start.sh',
  'start-*.sh',
  'TASK.md',
  'prompt-*.txt',
  '',
  '# Claude Code runtime — per-machine, regenerated, do not commit',
  '.claude/scheduled_tasks.lock',
  '.claude/settings.local.json',
];

/**
 * Append build-studio runtime patterns to the project's .gitignore. Idempotent:
 * skips any pattern already present (line-equal match). If .gitignore is missing,
 * creates a minimal one with just these patterns. Never overwrites existing rules.
 */
function ensureGitignorePatterns(targetPath, written, skipped) {
  const gi = path.join(targetPath, '.gitignore');
  let existing = '';
  let existingLines = new Set();
  if (fs.existsSync(gi)) {
    existing = fs.readFileSync(gi, 'utf8');
    existingLines = new Set(existing.split('\n').map((l) => l.trim()).filter(Boolean));
  }

  const patternsToAdd = BUILD_STUDIO_GITIGNORE_PATTERNS.filter((p) => {
    if (!p.trim()) return true; // keep blank-line / comment spacing
    return !existingLines.has(p.trim());
  });

  // If every non-blank/non-comment pattern is already present, nothing to do.
  const realPatterns = patternsToAdd.filter((p) => p.trim() && !p.trim().startsWith('#'));
  if (realPatterns.length === 0) {
    skipped.push('.gitignore (all build-studio patterns already present)');
    return;
  }

  const newContent = existing.endsWith('\n') || existing === ''
    ? existing + patternsToAdd.join('\n') + '\n'
    : existing + '\n' + patternsToAdd.join('\n') + '\n';
  fs.writeFileSync(gi, newContent);
  written.push(`.gitignore (+${realPatterns.length} runtime patterns)`);
}

/**
 * Compose the YAML written to .build-studio/config.yaml.
 * Conventional sections in human-friendly order; comments explaining the inferred
 * `deployedOnPush` choice. Avoid relying on js-yaml comment support (it has none) —
 * concatenate template strings instead.
 */
function renderConfigYaml({ name, port, preset, deployment, devCommands }) {
  const lines = [];
  lines.push(`name: ${name}`);
  lines.push(`port: ${port}`);
  lines.push('docs_path: ./docs');
  lines.push('');
  lines.push(`preset: ${preset}`);
  lines.push('');

  // Deployment block — always written, even when partial.
  lines.push('deployment:');
  if (deployment.repo) lines.push(`  repo: ${deployment.repo}`);
  if (deployment.ciWorkflow) lines.push(`  ci_workflow: ${deployment.ciWorkflow}`);
  // deployedOnPush: explicit even though config.js can infer it — makes the
  // assumption visible in the file the operator reads.
  lines.push(`  # When true (no manual deploy workflow), pushing to main IS the deploy`);
  lines.push(`  # (Railway / Cloudflare Pages style). When false, the Deploy button must`);
  lines.push(`  # fire a workflow_dispatch run for production to update.`);
  lines.push(`  deployedOnPush: ${deployment.deployedOnPush}`);
  if (deployment.autoDeployHint) {
    lines.push(`  # auto-deploy hint detected: ${deployment.autoDeployHint}`);
  }
  lines.push('');

  // Dev commands — written verbatim from detection.
  if (devCommands && devCommands.length > 0) {
    lines.push('dev_commands:');
    for (const c of devCommands) {
      lines.push(`  - name: ${c.name}`);
      lines.push(`    cmd: ${quoteIfNeeded(c.cmd)}`);
      if (c.cwd) lines.push(`    cwd: ${c.cwd}`);
      if (c.port) lines.push(`    port: ${c.port}`);
      if (c.type) lines.push(`    type: ${c.type}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function quoteIfNeeded(s) {
  if (!s) return '""';
  if (/^[\w./@:=-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

/**
 * Best-effort stack hints from the project. Surfaces framework/language/uiLib
 * keys for the discovery agent without doing deep static analysis.
 */
function stackHints(targetPath) {
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(targetPath, 'package.json'), 'utf8')); } catch {}
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const out = {};
  if (deps.next) out.framework = 'next';
  else if (deps['@sveltejs/kit']) out.framework = 'sveltekit';
  else if (deps.astro) out.framework = 'astro';
  else if (deps.vite) out.framework = 'vite';
  else if (deps.fastify) out.framework = 'fastify';
  else if (deps.express) out.framework = 'express';
  if (deps.typescript) out.language = 'typescript';
  if (deps.react) out.uiLib = 'react';
  else if (deps.svelte) out.uiLib = 'svelte';
  return out;
}

function gitInventory(targetPath) {
  const out = { remote: null, branch: null, recentCommits: [] };
  try {
    out.remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: targetPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {}
  try {
    out.branch = execFileSync('git', ['branch', '--show-current'], {
      cwd: targetPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {}
  try {
    const log = execFileSync('git', ['log', '-30', '--format=%h|%s|%cI'], {
      cwd: targetPath, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (log) {
      out.recentCommits = log.split('\n').map((l) => {
        const [hash, subject, date] = l.split('|');
        return { hash, subject, date };
      });
    }
  } catch {}
  return out;
}

/**
 * Classify the project shape so the discovery agent knows what kind of
 * synthesis to do. v1 only supports single-prd-mvp; the others are tagged
 * for the agent's own halt-with-blocking-finding logic per PRD §2.2.2.
 */
function shapeFromExistingDocs(existingDocs, preset) {
  if (preset === 'mobile-app') return 'mobile-app';
  if (existingDocs.specsDirPresent) return 'spec-folder';
  const hasMonolithPrd = existingDocs.docs.some((d) => d.kind === 'prd-monolith');
  if (hasMonolithPrd) return 'single-prd-mvp';
  return 'unstructured';
}

module.exports = { onboardProject, previewOnboard, detectAll };
