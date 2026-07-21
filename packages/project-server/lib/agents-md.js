// AGENTS.md canonical-instruction-file migration.
//
// Convention: AGENTS.md holds the project's agent instructions (read natively
// by OpenCode and Codex); CLAUDE.md is a thin stub that @-imports it for
// Claude Code. This module plans and applies that layout for three entry
// points: init scaffolding, onboarding an existing repo, and the
// `build-studio migrate-agents-md` batch command.
//
// HARD RULE: never overwrite an existing AGENTS.md, and never silently touch a
// populated CLAUDE.md. Every destructive-looking step (content move) is an
// explicit, previewable action the operator opted into.
const fs = require('fs');
const path = require('path');

// The stub left in CLAUDE.md. Claude Code's memory-import syntax pulls the
// AGENTS.md content in; other readers see a pointer. Keep the import line
// LAST and on its own line — `@path` imports are line-based.
const CLAUDE_STUB = `# Project Configuration

Agent instructions for this project live in [\`AGENTS.md\`](AGENTS.md) — the
canonical file shared by all agent CLIs (Claude Code, Codex, OpenCode). It is
imported below; edit AGENTS.md, not this file.

@AGENTS.md
`;

function looksLikeStub(claudeContent) {
  return typeof claudeContent === 'string' && claudeContent.includes('@AGENTS.md');
}

// What layout does this project currently have, and what (if anything) should
// the migration do? Pure — no writes.
//   action 'scaffold'  — no AGENTS.md, no (real) CLAUDE.md → write both from template
//   action 'migrate'   — populated CLAUDE.md, no AGENTS.md → move content, leave stub
//   action 'stub-only' — AGENTS.md present, CLAUDE.md missing → write just the stub
//   action 'none'      — already migrated (both present, CLAUDE.md is a stub),
//                        or BOTH files populated (needs human reconciliation)
function planAgentsMdMigration(projectRoot) {
  const claudePath = path.join(projectRoot, 'CLAUDE.md');
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const claudeMdPresent = fs.existsSync(claudePath);
  const agentsMdPresent = fs.existsSync(agentsPath);
  const claudeContent = claudeMdPresent ? fs.readFileSync(claudePath, 'utf8') : null;
  const claudeIsStub = looksLikeStub(claudeContent);

  let action, summary;
  if (agentsMdPresent && claudeMdPresent && claudeIsStub) {
    action = 'none';
    summary = 'Already migrated (AGENTS.md + CLAUDE.md stub).';
  } else if (agentsMdPresent && claudeMdPresent) {
    action = 'none';
    summary = 'BOTH AGENTS.md and a populated CLAUDE.md exist — reconcile manually (left untouched).';
  } else if (agentsMdPresent) {
    action = 'stub-only';
    summary = 'AGENTS.md exists, no CLAUDE.md — add the Claude Code stub that @-imports it.';
  } else if (claudeMdPresent && claudeIsStub) {
    action = 'scaffold';
    summary = 'CLAUDE.md is already a stub but AGENTS.md is missing — scaffold AGENTS.md from the template.';
  } else if (claudeMdPresent) {
    action = 'migrate';
    summary = 'Move CLAUDE.md content into AGENTS.md and leave a stub behind (content preserved verbatim).';
  } else {
    action = 'scaffold';
    summary = 'Neither file exists — scaffold AGENTS.md from the template + the CLAUDE.md stub.';
  }
  return { claudeMdPresent, agentsMdPresent, claudeIsStub, action, summary };
}

// Multi-candidate template resolution — same search order as scaffold.js so it
// works from the source tree and the Electron bundle.
function resolveTemplateDir() {
  const templateSuffix = path.join('templates', 'default');
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', templateSuffix),
    path.resolve(__dirname, '..', '..', '..', '..', '..', templateSuffix),
    path.resolve(__dirname, '..', '..', templateSuffix),
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

// Apply a planned action. Returns { written: [], skipped: [] }. Never
// overwrites an existing AGENTS.md.
function applyAgentsMdMigration(projectRoot, plan) {
  const claudePath = path.join(projectRoot, 'CLAUDE.md');
  const agentsPath = path.join(projectRoot, 'AGENTS.md');
  const written = [];
  const skipped = [];

  const writeAgentsFromTemplate = () => {
    if (fs.existsSync(agentsPath)) { skipped.push('AGENTS.md (exists)'); return; }
    const templateDir = resolveTemplateDir();
    const src = templateDir && path.join(templateDir, 'AGENTS.md');
    if (src && fs.existsSync(src)) {
      fs.copyFileSync(src, agentsPath);
    } else {
      // No template reachable (odd install) — minimal viable canonical file.
      fs.writeFileSync(agentsPath, '# Project Agent Instructions\n\nSee `CLAUDE.md` stub and `docs/project-state.md`.\n', 'utf8');
    }
    written.push('AGENTS.md');
  };
  const writeClaudeStub = () => {
    fs.writeFileSync(claudePath, CLAUDE_STUB, 'utf8');
    written.push('CLAUDE.md (stub)');
  };

  switch (plan.action) {
    case 'scaffold':
      writeAgentsFromTemplate();
      if (!plan.claudeMdPresent) writeClaudeStub();
      break;
    case 'migrate': {
      if (fs.existsSync(agentsPath)) { skipped.push('AGENTS.md (exists — aborting migrate)'); break; }
      // Preserve the existing content byte-for-byte: rename, then stub.
      fs.renameSync(claudePath, agentsPath);
      written.push('AGENTS.md (moved from CLAUDE.md)');
      writeClaudeStub();
      break;
    }
    case 'stub-only':
      if (!plan.claudeMdPresent) writeClaudeStub();
      break;
    default:
      skipped.push('nothing to do');
  }
  return { written, skipped };
}

module.exports = { CLAUDE_STUB, planAgentsMdMigration, applyAgentsMdMigration, resolveTemplateDir };
