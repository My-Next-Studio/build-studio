const fs = require('fs');
const path = require('path');

/**
 * Ensure the Claude Code settings file at <dir>/.claude/settings.local.json
 * pre-approves project-scoped MCP servers (enableAllProjectMcpServers).
 *
 * Without this, Claude Code shows an interactive "New MCP server found in
 * this project" trust prompt on first launch in a fresh checkout — which
 * stalls headless workflow agents in tmux until a human answers. Agents
 * already run with --dangerously-skip-permissions, so pre-trusting the
 * project's own .mcp.json is consistent with the session's trust model.
 *
 * Merges into an existing settings.local.json rather than overwriting; on a
 * parse error it leaves the file untouched (never clobber a user's config).
 */
function ensureMcpAutoApprove(dir) {
  try {
    const claudeDir = path.join(dir, '.claude');
    const file = path.join(claudeDir, 'settings.local.json');
    let settings = {};
    if (fs.existsSync(file)) {
      try {
        settings = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        return false; // unparseable user config — do not touch it
      }
      if (settings.enableAllProjectMcpServers === true) return true;
    }
    settings.enableAllProjectMcpServers = true;
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    return true;
  } catch {
    return false; // best-effort: a failed write must never block agent launch
  }
}

module.exports = { ensureMcpAutoApprove };
