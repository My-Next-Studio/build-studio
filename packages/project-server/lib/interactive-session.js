'use strict';

/**
 * Interactive agent sessions: a CLI the owner talks to in an embedded
 * terminal, for as long as it takes, which ends when the OWNER says so.
 *
 * Not a workflow agent: a workflow agent is watched (dead process, stuck,
 * finished but not reported) and expected to POST a report; a person thinking
 * for an hour would be flagged as stalled. So the caller stores the returned
 * session record on its step, and the session lives in its own tmux session.
 *
 * Generalised from the kickoff interview (kickoff-interview.js) so the
 * reconcile track's interview and decision steps run the same way. The
 * launcher is drafting's: same command builder, same per-CLI session
 * handling, same read-back of Codex/OpenCode ids by a marker phrase.
 *
 * A spec names everything that differs between sessions:
 *   { stepKey,        step-group key for CLI/model resolution
 *     sessionName,    tmux session
 *     window,         tmux window (unique across the project's sessions)
 *     marker,         phrase in the opening prompt, for session-id read-back
 *     prompt,         opening message
 *     resumePrompt,   message when resuming the same conversation
 *     cwd,            where the CLI runs (defaults to the project root)
 *     promptFile,     where the prompt is written (defaults to <cwd>/prompt-<window>.txt)
 *     logName }       pane log file name in config.logsPath (defaults to <window>.log)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildDraftCommand } = require('./drafting');
const { findDraftSessionId } = require('./draft-session-id');
const {
  resolveStepLaunchSettings, canPinSession, canResumeSession, sessionPinFlag, sessionResumeFlag,
} = require('@build-studio/shared/cli');

const sanitize = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

/**
 * Start or resume a session.
 * @returns {object} the session record to store on the step
 */
function launchSession({ config, tmuxOps, spec, prior = null, findSessionId = findDraftSessionId }) {
  const cwd = spec.cwd || config.projectRoot;
  const launch = resolveStepLaunchSettings(spec.stepKey, null, config.cli, config.step_groups);
  const cli = launch.cli;

  // Resume only on the CLI that holds the conversation.
  let priorId = null;
  if (prior && prior.cli === cli && canResumeSession(cli)) {
    priorId = prior.cliSessionId || null;
    if (!priorId && !canPinSession(cli)) {
      try {
        priorId = findSessionId({ cli, projectRoot: cwd, since: prior.startedAt, marker: spec.marker }) || null;
      } catch (_) { priorId = null; }
    }
  }
  const resuming = !!priorId;
  const cliSessionId = resuming ? priorId : (canPinSession(cli) ? crypto.randomUUID() : null);

  const promptFile = spec.promptFile || path.join(cwd, `prompt-${spec.window}.txt`);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, resuming ? spec.resumePrompt : spec.prompt, 'utf8');

  const target = tmuxOps.ensureWindow(spec.sessionName, spec.window, cwd);
  tmuxOps.sendKeys(target, `cd '${cwd}' && ${buildDraftCommand({
    cli,
    modelFlag: launch.modelFlag,
    effortFlag: launch.effortFlag,
    dangerFlag: cli === 'opencode' ? ' --auto' : '',
    sessionFlag: resuming ? sessionResumeFlag(cli, cliSessionId) : sessionPinFlag(cli, cliSessionId),
    promptFile,
  })}`, cwd);
  const logFile = config.logsPath ? path.join(config.logsPath, spec.logName || `${spec.window}.log`) : null;
  if (logFile && typeof tmuxOps.pipePaneToLog === 'function') {
    fs.mkdirSync(config.logsPath, { recursive: true });
    tmuxOps.pipePaneToLog(target, logFile, cwd);
  }

  const now = new Date().toISOString();
  return {
    cli,
    cliSessionId,
    model: launch.model || null,
    sessionName: spec.sessionName,
    window: spec.window,
    cwd,
    logFile,
    startedAt: resuming ? (prior.startedAt || now) : now,
    launchedAt: now,
    resumed: resuming,
  };
}

/** Is the agent in a tmux target still running? */
function targetLive(tmuxOps, target) {
  const pid = tmuxOps.panePid ? tmuxOps.panePid(target) : null;
  return { live: !!pid, agentRunning: !!pid && (tmuxOps.hasLiveDescendant ? tmuxOps.hasLiveDescendant(pid) : false) };
}

/** Is the session's agent still running? */
function sessionLive(session, tmuxOps) {
  if (!session) return { live: false, agentRunning: false };
  return targetLive(tmuxOps, `${session.sessionName}:${session.window}`);
}

const EXIT_GRACE_MS = 8000;
const INTERRUPT_GRACE_MS = 4000;

/**
 * Stop the agent in a pane, escalating until it is gone.
 *
 *   1. The CLI's own `/exit`, so it closes its session cleanly instead of being
 *      cut off part-way through writing a file.
 *   2. If it is still running after EXIT_GRACE_MS: Escape and two ctrl+c. A CLI
 *      can sit on a screen where /exit is just text. In the case that prompted
 *      this, Codex sat on "This conversation is open in another app — press R",
 *      which answers only esc, ctrl+c or q. The agent stayed alive, so the
 *      project's Draft button stayed blocked by a session nobody could end.
 *      Escape and a double ctrl+c exit Codex, Claude Code and OpenCode alike.
 *   3. If it is still running after INTERRUPT_GRACE_MS more: close the window.
 *
 * A pane with no agent left (a bare shell) is closed at once. Steps 2 and 3 run
 * on timers, so the caller returns immediately; the poll that drives the UI sees
 * the agent go.
 *
 * @returns {'killed'|'exiting'|'gone'}
 */
function stopAgent({ tmuxOps, target, cwd, schedule = setTimeout }) {
  const { live, agentRunning } = targetLive(tmuxOps, target);
  if (!live) return 'gone';
  if (!agentRunning) {
    tmuxOps.killWindowAndChildren(target);
    return 'killed';
  }
  tmuxOps.sendKeys(target, '/exit', cwd);
  const later = (ms, fn) => {
    const t = schedule(() => { try { fn(); } catch (_) { /* window gone meanwhile */ } }, ms);
    if (t && typeof t.unref === 'function') t.unref();
  };
  later(EXIT_GRACE_MS, () => {
    if (!targetLive(tmuxOps, target).agentRunning) return;
    if (typeof tmuxOps.sendKeysRaw === 'function') tmuxOps.sendKeysRaw(target, 'Escape', 'C-c', 'C-c');
    later(INTERRUPT_GRACE_MS, () => {
      if (targetLive(tmuxOps, target).agentRunning) tmuxOps.killWindowAndChildren(target);
    });
  });
  return 'exiting';
}

/**
 * Stop the agent, keeping the conversation resumable. Reads a Codex/OpenCode
 * id back first, so a later Start resumes without another lookup.
 */
function endSession({ session, config, tmuxOps, marker, findSessionId = findDraftSessionId, schedule = setTimeout }) {
  if (!session) return session;
  const cwd = session.cwd || config.projectRoot;
  let cliSessionId = session.cliSessionId || null;
  if (!cliSessionId && canResumeSession(session.cli) && !canPinSession(session.cli)) {
    try {
      cliSessionId = findSessionId({ cli: session.cli, projectRoot: cwd, since: session.startedAt, marker }) || null;
    } catch (_) { cliSessionId = null; }
  }
  try {
    stopAgent({ tmuxOps, target: `${session.sessionName}:${session.window}`, cwd, schedule });
  } catch (_) { /* best effort: the window may already be gone */ }
  return { ...session, cliSessionId, endedAt: new Date().toISOString() };
}

module.exports = { sanitize, launchSession, sessionLive, targetLive, stopAgent, endSession, EXIT_GRACE_MS, INTERRUPT_GRACE_MS };
