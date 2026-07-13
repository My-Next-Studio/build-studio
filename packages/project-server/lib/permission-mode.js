const VALID_MODES = ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'];

/**
 * Resolve the Claude Code permission mode for agent sessions.
 *
 * Precedence:
 *   1. agent_defaults.permission_mode — any valid CLI mode, explicit wins.
 *   2. Legacy agent_defaults.skip_permissions — true meant
 *      --dangerously-skip-permissions (= bypassPermissions), false meant
 *      no flag (= default). Preserved so existing project configs keep
 *      their exact behavior.
 *   3. Neither set → 'auto': no routine prompts, a background classifier
 *      blocks genuinely risky actions, and the agent can route around a
 *      denial instead of stalling headless in tmux.
 */
function resolvePermissionMode(agentDefaults) {
  const ad = agentDefaults || {};
  if (ad.permission_mode) {
    if (VALID_MODES.includes(ad.permission_mode)) return ad.permission_mode;
    console.warn(`[permission-mode] invalid agent_defaults.permission_mode "${ad.permission_mode}" — using "auto" (valid: ${VALID_MODES.join(', ')})`);
    return 'auto';
  }
  if (ad.skip_permissions === true) return 'bypassPermissions';
  if (ad.skip_permissions === false) return 'default';
  return 'auto';
}

/** CLI flag fragment for the claude binary ('' when the mode is 'default'). */
function claudePermissionFlag(mode) {
  return mode === 'default' ? '' : ` --permission-mode ${mode}`;
}

module.exports = { resolvePermissionMode, claudePermissionFlag, VALID_MODES };
