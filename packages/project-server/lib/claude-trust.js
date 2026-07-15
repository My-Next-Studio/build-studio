'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/**
 * Seed Claude Code's per-folder trust for a project path.
 *
 * Workflow agents run the Claude CLI headless inside tmux. A folder Claude
 * Code has never seen triggers its interactive "do you trust this folder?"
 * dialog, which no agent can answer — every agent stalls silently at the
 * prompt until the idle timeout errors it (finance-studio kickoff,
 * 2026-07-15: two full runs walked to 'completed' with zero output).
 * Seeding `projects[<path>].hasTrustDialogAccepted` in ~/.claude.json is
 * exactly what accepting the dialog records, so agents start clean on the
 * project's very first workflow.
 *
 * Merge-only and fail-soft: never clobbers unrelated config, never throws.
 * An unreadable or corrupt config file means we skip (returns false) rather
 * than risk destroying Claude Code's state — the owner can still accept the
 * dialog manually by running `claude` in the folder once.
 *
 * @param {string} projectPath absolute path of the project folder
 * @param {{configPath?: string}} [opts] test seam — alternate config location
 * @returns {boolean} true when the trust entry is present after the call
 */
function seedClaudeFolderTrust(projectPath, opts = {}) {
  const configPath = opts.configPath || path.join(os.homedir(), '.claude.json');
  let config = {};
  try {
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch {
    return false; // corrupt or unreadable — leave it alone
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;

  if (!config.projects || typeof config.projects !== 'object' || Array.isArray(config.projects)) {
    config.projects = {};
  }
  const existing = config.projects[projectPath];
  if (existing && typeof existing === 'object' && existing.hasTrustDialogAccepted === true) {
    return true; // already trusted — don't touch the file
  }
  config.projects[projectPath] = {
    ...(existing && typeof existing === 'object' ? existing : {}),
    hasTrustDialogAccepted: true,
  };

  // Atomic replace so a crash mid-write can't leave a truncated config.
  const tmp = `${configPath}.trust-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, configPath);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    return false;
  }
}

module.exports = { seedClaudeFolderTrust };
