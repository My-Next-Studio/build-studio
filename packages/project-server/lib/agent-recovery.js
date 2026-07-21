'use strict';

/**
 * Dead-vs-stalled agent discrimination + auto-resume decisions (Tier 2 of the
 * agent-protection design, 2026-07-17).
 *
 * Two failure modes previously produced the identical "no log activity for 15
 * minutes" stall error, but they need OPPOSITE remedies:
 *
 *  - ALIVE but silent (e.g. waiting at an interactive dialog — the
 *    finance-studio folder-trust kickoff): relaunching destroys context; a
 *    human must answer. Keep the slow stall timeout.
 *  - DEAD (SIGKILL under memory pressure, daemon-crash fallout, CLI update —
 *    the launch-studio PRD-010 qa_validation kill): waiting 15 minutes is
 *    waste; the right move is an immediate `claude --resume <session-id>`,
 *    which restores the agent's full conversation context.
 *
 * The discriminator is tmux's `#{pane_current_command}`: a live agent pane
 * runs `claude`/`codex`/`node`; a dead one has fallen back to the interactive
 * login shell. Because Claude's Bash tool may briefly run `zsh -c` children in
 * the foreground process group, a shell alone is NOT proof of death — death is
 * only confirmed when the pane shows a shell AND the pipe-pane log has been
 * silent for `deadConfirmMs` (a live Claude repaints its UI constantly; even
 * its interactive dialogs were rendered moments before going idle, and its
 * pane command stays `claude` — so the alive-at-a-dialog case never classifies
 * as dead).
 *
 * All functions here are pure — the tmux/fs I/O lives in server.js.
 */

const INTERACTIVE_SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'tcsh', 'csh', 'dash', 'ksh']);

/** Is a tmux pane_current_command an interactive shell (login `-zsh` included)? */
function isShellCommand(cmd) {
  if (!cmd) return false;
  const base = String(cmd).trim().replace(/^-/, '').split('/').pop();
  return INTERACTIVE_SHELLS.has(base);
}

/**
 * Classify a running agent's process state.
 * @param {object} p
 * @param {string|null} p.paneCommand  tmux #{pane_current_command}, or null when
 *                                     the window/pane could not be found
 * @param {number} p.idleMs            ms since the agent's log last changed
 * @param {number} [p.deadConfirmMs]   silence needed to confirm death (default 2 min)
 * @returns {'alive'|'dead'|'gone'}    gone = window itself missing (confirmed)
 */
function classifyAgentProcess({ paneCommand, idleMs, deadConfirmMs = 2 * 60 * 1000 }) {
  // Confirmation threshold applies to both: transient tmux failures and
  // short-lived `zsh -c` tool children must never classify as dead.
  if (idleMs < deadConfirmMs) return 'alive';
  if (paneCommand === null || paneCommand === undefined || paneCommand === '') return 'gone';
  if (isShellCommand(paneCommand)) return 'dead';
  return 'alive';
}

/**
 * Can a dead agent be auto-resumed?
 * Requires a captured CLI session id + resume script (claude-only — codex has
 * no resume) and remaining attempts.
 * @returns {'resume'|'halt'}
 */
function decideRecovery(agent, { maxAutoResumes = 2 } = {}) {
  if (!agent || !agent.cliSessionId || !agent.resumeScript) return 'halt';
  if ((agent.autoResumeCount || 0) >= maxAutoResumes) return 'halt';
  return 'resume';
}

/**
 * Does this agent carry the resume artifacts (pinned session id + pre-written
 * resume script) that give the fast dead-process halt its value?
 *
 * The shell-pane dead heuristic is tuned to the Claude CLI's behaviour:
 * claude repaints its UI constantly (so a live agent's log never goes silent)
 * and its pane_current_command stays `claude` even at interactive dialogs.
 * `opencode run` and codex agents do neither — print-mode output can pause
 * for minutes during long generations, and macOS pane_current_command is
 * flaky — which produced a false "process died" halt on a healthy opencode
 * agent mid-run (launch-studio qa_tests, 2026-07-20). Since only agents with
 * resume artifacts can be auto-resumed anyway, callers should let agents
 * without them fall through to the slow idle-stall timeout, whose verdict is
 * accurate for a genuinely dead process too.
 */
function hasResumeArtifacts(agent) {
  return !!(agent && agent.cliSessionId && agent.resumeScript);
}

/**
 * Post-resume grace: after sending a resume, give the CLI time to boot and
 * start repainting before any further dead/stall judgement — prevents the
 * 30s monitor tick from double-firing resumes.
 */
function inResumeGrace(agent, nowMs, graceMs = 3 * 60 * 1000) {
  if (!agent || !agent.lastAutoResumeAt) return false;
  const t = new Date(agent.lastAutoResumeAt).getTime();
  if (Number.isNaN(t)) return false;
  return nowMs - t < graceMs;
}

module.exports = { isShellCommand, classifyAgentProcess, decideRecovery, hasResumeArtifacts, inResumeGrace };
