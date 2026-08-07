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
 * @param {boolean} [p.hasLiveChild]   does the pane's process still have a live
 *                                     direct child (e.g. a compiling xcodebuild)?
 *                                     A dead pane that fell back to a login shell
 *                                     has none — nothing left to run. Overrides
 *                                     the shell-pane "dead" verdict below: fazon
 *                                     FAZ-186 QA validation (2026-07-21) had an
 *                                     idle, shell-attributed pane for 2+ minutes
 *                                     purely from a long `xcodebuild | tee`
 *                                     foreground pipe, while the agent was alive.
 * @returns {'alive'|'dead'|'gone'}    gone = window itself missing (confirmed)
 */
function classifyAgentProcess({ paneCommand, idleMs, deadConfirmMs = 2 * 60 * 1000, hasLiveChild = false }) {
  // Confirmation threshold applies to both: transient tmux failures and
  // short-lived `zsh -c` tool children must never classify as dead.
  if (idleMs < deadConfirmMs) return 'alive';
  if (paneCommand === null || paneCommand === undefined || paneCommand === '') return 'gone';
  if (hasLiveChild) return 'alive';
  if (isShellCommand(paneCommand)) return 'dead';
  return 'alive';
}

/**
 * Has an agent previously judged dead come back to life?
 *
 * The dead/stall verdict is normally final — re-running it would only rewrite
 * the same error. But it is a verdict about a process, and a human can change
 * that fact from outside: answering a prompt in the live terminal, or restarting
 * the CLI by hand, revives an agent the watchdog has already written off.
 *
 * Observed on a fazon fix_execution run: the pane fell back to a shell, the
 * agent was marked `error` ("process exited... after 20m of work"), the owner
 * answered the blocking question in the terminal, and the agent carried on
 * working — while the card still showed an error and offered Recover and
 * Approve, both of which would have moved the step and caused the agent's
 * eventual report to be REJECTED as belonging to a closed step.
 *
 * Revival needs BOTH signals, because either alone is weak: a non-shell pane
 * command could be a transient tool child, and recent log output could be a
 * dying process's last gasp. Together they mean a real agent process is running
 * AND producing output right now.
 *
 * Being wrong here is cheap and self-correcting in a way the old behaviour was
 * not: a falsely revived agent is re-judged dead on the next tick, whereas a
 * falsely dead one stays wrong until a human notices.
 *
 * @param {string|null} p.paneCommand  tmux #{pane_current_command}
 * @param {number} p.idleMs            ms since the agent's log last changed
 * @param {number} [p.deadConfirmMs]
 */
function isRevived({ paneCommand, idleMs, deadConfirmMs = 2 * 60 * 1000 }) {
  if (!paneCommand) return false;            // window gone — nothing to revive
  if (isShellCommand(paneCommand)) return false;  // still sitting at a prompt
  return idleMs < deadConfirmMs;             // ...and actively producing output
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

/**
 * Every agent record in a workflow, from BOTH of the places they live.
 *
 * Step agents sit on `wf.steps[key].agents`. Task-execution agents sit on
 * `wf.taskExecution.taskStates[i].agents`, and are only *mirrored* onto
 * `steps.task_execution.agents` by `updateStepAgents` — which the normal launch
 * path never calls. So the mirror is routinely empty while a task is running,
 * and any sweep reading only `steps[*].agents` skips every agent of a
 * task_execution run. That is how a killed tmux session left deskrhythm DR-092
 * 'running' with no process behind it (2026-07-29).
 *
 * Yields the live objects, so mutating one mutates the workflow. The mirror is
 * a shallow copy rather than the same object, so both views are yielded on
 * purpose — marking both keeps them consistent.
 */
function allAgentsOf(wf) {
  const out = [];
  if (!wf) return out;
  for (const step of Object.values(wf.steps || {})) {
    for (const a of step.agents || []) out.push(a);
  }
  const states = (wf.taskExecution && wf.taskExecution.taskStates) || {};
  for (const ts of Object.values(states)) {
    for (const a of (ts && ts.agents) || []) out.push(a);
  }
  return out;
}

module.exports = {
  isRevived,
  isShellCommand, classifyAgentProcess, decideRecovery, hasResumeArtifacts,
  inResumeGrace, allAgentsOf,
};
