'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Inventory the project's existing onboarding-relevant docs so the discovery
 * agent (PRD-001 onboarding workflow) can summarize them. The button writes
 * this list into `docs/onboarding/inventory.json`; the agent reads it.
 *
 * Each entry: { path, kind, bytes }. `kind` is the role the file likely plays:
 *   readme, claude-md, agents-md, prd-monolith, design-doc, action-plan,
 *   spec, strategy, architecture, branding, marketing, contracts, adrs, other.
 *
 * Only inventories shallow paths — README at root, single-PRD-MVP files, the
 * /specs/ and /docs/strategy/ folders. Doesn't walk arbitrary subtrees.
 */
function detectExistingDocs(projectRoot) {
  const out = [];
  const claudeMdPresent = exists(projectRoot, 'CLAUDE.md');
  const agentsMdPresent = exists(projectRoot, 'AGENTS.md');
  const specsDirPresent = isDir(projectRoot, 'specs');

  // Root-level docs.
  for (const candidate of [
    { rel: 'README.md',           kind: 'readme' },
    { rel: 'CLAUDE.md',           kind: 'claude-md' },
    { rel: 'AGENTS.md',           kind: 'agents-md' },
    { rel: 'PRD.md',              kind: 'prd-monolith' },
    { rel: 'DESIGN.md',           kind: 'design-doc' },
    { rel: 'ARCHITECTURE.md',     kind: 'architecture' },
    { rel: 'ROADMAP.md',          kind: 'roadmap' },
    { rel: 'ACTION-PLAN.md',      kind: 'action-plan' },
    { rel: 'IMPLEMENTATION_PLAN.md', kind: 'action-plan' },
    { rel: 'CHANGELOG.md',        kind: 'changelog' },
  ]) {
    pushIfFile(out, projectRoot, candidate.rel, candidate.kind);
  }

  // /specs/ directory — common in skrivhjälp shape.
  if (specsDirPresent) {
    for (const f of safeReaddir(path.join(projectRoot, 'specs'))) {
      if (f.endsWith('.md')) pushIfFile(out, projectRoot, path.join('specs', f), 'spec');
    }
  }

  // /docs/strategy + /docs/branding + /docs/architecture + /docs/marketing + /docs/operations
  // Common in example-studio shape; harmless when absent.
  for (const sub of ['strategy', 'branding', 'architecture', 'marketing', 'operations', 'localization']) {
    const dir = path.join(projectRoot, 'docs', sub);
    if (!isDirAbs(dir)) continue;
    for (const f of safeReaddir(dir)) {
      if (f.endsWith('.md')) pushIfFile(out, projectRoot, path.join('docs', sub, f), sub);
    }
  }

  // Existing PRDs/ADRs/contracts — useful to count but don't expand each one
  // (could be hundreds in a mature project).
  const prdsDir = path.join(projectRoot, 'docs', 'prds');
  const adrsDir = path.join(projectRoot, 'docs', 'adrs');
  const contractsDir = path.join(projectRoot, 'docs', 'contracts');
  const counts = {
    existingPrds: countMdFiles(prdsDir),
    existingAdrs: countMdFiles(adrsDir),
    existingContracts: countMdFiles(contractsDir),
  };

  return {
    docs: out,
    claudeMdPresent,
    agentsMdPresent,
    specsDirPresent,
    counts,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function exists(root, rel) {
  try { return fs.existsSync(path.join(root, rel)); } catch { return false; }
}

function isDir(root, rel) {
  const abs = path.join(root, rel);
  try { return fs.statSync(abs).isDirectory(); } catch { return false; }
}

function isDirAbs(abs) {
  try { return fs.statSync(abs).isDirectory(); } catch { return false; }
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

function countMdFiles(dir) {
  if (!isDirAbs(dir)) return 0;
  return safeReaddir(dir).filter((f) => f.endsWith('.md')).length;
}

function pushIfFile(out, root, rel, kind) {
  const abs = path.join(root, rel);
  let stat;
  try { stat = fs.statSync(abs); } catch { return; }
  if (!stat.isFile()) return;
  out.push({ path: rel, kind, bytes: stat.size });
}

module.exports = { detectExistingDocs };
