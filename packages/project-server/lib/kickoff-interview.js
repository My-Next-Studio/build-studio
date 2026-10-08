'use strict';

/**
 * The kickoff's owner_interview step: an interactive PM session, run with the
 * `owner_interview` skill. See docs/plans/kickoff-owner-interview.md.
 *
 * WHY THIS IS NOT A WORKFLOW AGENT, though it is a workflow step: a workflow
 * agent is watched (dead-process, stuck, finished-but-not-reported) and expected
 * to POST a report. An interview is a person thinking, possibly for days, and
 * ends when the OWNER says so. Put in `step.agents`, it would be flagged as
 * stalled within the hour. So it lives on the step as `step.session`, in its own
 * tmux session (as drafting does), and the step advances only on Finish or Skip.
 *
 * The launcher is drafting's: same command builder, same per-CLI session
 * handling, same read-back of Codex/OpenCode ids.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { buildDraftCommand } = require('./drafting');
const { findDraftSessionId } = require('./draft-session-id');
const {
  resolveStepLaunchSettings, canPinSession, canResumeSession, sessionPinFlag, sessionResumeFlag,
} = require('@build-studio/shared/cli');

const STEP = 'owner_interview';
const WINDOW = 'interview';
/** The file the skill writes and team_review / pm_revision read. */
const SUMMARY_PATH = 'docs/inputs/owner-interview.md';

const sanitize = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

function interviewSessionName(projectName) {
  return `interview-${sanitize(projectName) || 'project'}`;
}

/** The phrase the opening prompt carries; identifies the session on read-back. */
function interviewMarker(projectName) {
  return `owner interview for the project "${projectName}"`;
}

/**
 * The opening message. Says plainly that a human is on the other end, for the
 * same reason drafting does: an agent that assumes it is unattended writes the
 * answers instead of asking for them.
 *
 * Kickoff and onboarding differ in where the drafts came from: written from the
 * owner's inputs, or reconstructed from an existing project's files. That is
 * what the agent has to look for assumptions in.
 */
function interviewPrompt(projectName, mode = 'kickoff') {
  const context = mode === 'onboarding'
    ? `The CEO, Architect and PM have just reconstructed docs/vision.md, the ADRs,
docs/project-state.md and the backlog from this project's existing files
(summarised in docs/onboarding/survey.md). Where the files were silent or
ambiguous they inferred the answer. Find those inferences, and ask the owner
about the ones that shape the whole product.

Start by reading docs/onboarding/survey.md, the vision, the ADRs, the project
state and the backlog,`
    : `The CEO and PM have just written docs/vision.md, docs/project-state.md and the
backlog; they made decisions on the owner's behalf to do it. Find those, and
ask the owner about the ones that shape the whole product.

Start by reading docs/inputs/, the vision, the project state and the backlog,`;
  return `Use the \`owner_interview\` skill to run the ${interviewMarker(projectName)}.

This is an INTERACTIVE session. The owner is at the keyboard and will answer.
${context}
then open with what is already answered and where. Write each answer down as it
is made. Do not commit. When you are done, tell the owner to click
Finish interview.`;
}

/**
 * Start or resume the interview session.
 *
 * @returns {object} the session record to store on the step
 */
function launchInterview({ config, tmuxOps, prior = null, mode = 'kickoff', findSessionId = findDraftSessionId }) {
  const projectRoot = config.projectRoot;
  const projectName = config.name || path.basename(projectRoot);
  const launch = resolveStepLaunchSettings(STEP, null, config.cli, config.step_groups);
  const cli = launch.cli;
  const sessionName = interviewSessionName(projectName);

  // Resume only on the CLI that holds the conversation.
  let priorId = null;
  if (prior && prior.cli === cli && canResumeSession(cli)) {
    priorId = prior.cliSessionId || null;
    if (!priorId && !canPinSession(cli)) {
      try {
        priorId = findSessionId({ cli, projectRoot, since: prior.startedAt, marker: interviewMarker(projectName) }) || null;
      } catch (_) { priorId = null; }
    }
  }
  const resuming = !!priorId;
  const cliSessionId = resuming ? priorId : (canPinSession(cli) ? crypto.randomUUID() : null);

  const prompt = resuming
    ? 'Continue the owner interview where we left off. Re-read docs/inputs/owner-interview.md and the Key Decisions Log (docs/decisions.md) first, then pick up from the next open topic.'
    : interviewPrompt(projectName, mode);
  const promptFile = path.join(projectRoot, `prompt-${WINDOW}.txt`);
  fs.writeFileSync(promptFile, prompt, 'utf8');

  const target = tmuxOps.ensureWindow(sessionName, WINDOW, projectRoot);
  tmuxOps.sendKeys(target, `cd '${projectRoot}' && ${buildDraftCommand({
    cli,
    modelFlag: launch.modelFlag,
    effortFlag: launch.effortFlag,
    dangerFlag: cli === 'opencode' ? ' --auto' : '',
    sessionFlag: resuming ? sessionResumeFlag(cli, cliSessionId) : sessionPinFlag(cli, cliSessionId),
    promptFile,
  })}`, projectRoot);
  const logFile = config.logsPath ? path.join(config.logsPath, `${WINDOW}.log`) : null;
  if (logFile && typeof tmuxOps.pipePaneToLog === 'function') {
    fs.mkdirSync(config.logsPath, { recursive: true });
    tmuxOps.pipePaneToLog(target, logFile, projectRoot);
  }

  const now = new Date().toISOString();
  return {
    cli,
    cliSessionId,
    model: launch.model || null,
    sessionName,
    window: WINDOW,
    logFile,
    startedAt: resuming ? (prior.startedAt || now) : now,
    launchedAt: now,
    resumed: resuming,
  };
}

/** Is the interview's agent still running? */
function interviewLive(session, tmuxOps) {
  if (!session) return { live: false, agentRunning: false };
  const pid = tmuxOps.panePid ? tmuxOps.panePid(`${session.sessionName}:${session.window}`) : null;
  return { live: !!pid, agentRunning: !!pid && (tmuxOps.hasLiveDescendant ? tmuxOps.hasLiveDescendant(pid) : false) };
}

/**
 * Stop the agent, keeping the conversation resumable. Reads a Codex/OpenCode
 * id back first, so a later Start resumes without another lookup.
 */
function endInterview({ session, config, tmuxOps, findSessionId = findDraftSessionId }) {
  if (!session) return session;
  const projectName = config.name || path.basename(config.projectRoot);
  let cliSessionId = session.cliSessionId || null;
  if (!cliSessionId && canResumeSession(session.cli) && !canPinSession(session.cli)) {
    try {
      cliSessionId = findSessionId({ cli: session.cli, projectRoot: config.projectRoot, since: session.startedAt, marker: interviewMarker(projectName) }) || null;
    } catch (_) { cliSessionId = null; }
  }
  const { live, agentRunning } = interviewLive(session, tmuxOps);
  const target = `${session.sessionName}:${session.window}`;
  try {
    if (agentRunning) tmuxOps.sendKeys(target, '/exit', config.projectRoot);
    else if (live) tmuxOps.killWindowAndChildren(target);
  } catch (_) { /* best effort: the window may already be gone */ }
  return { ...session, cliSessionId, endedAt: new Date().toISOString() };
}

/** The repo-relative paths the interview writes, for committing on Finish. */
function interviewCommitPaths(projectRoot, docsRel = 'docs', exists = fs.existsSync) {
  return [
    path.join(docsRel, 'inputs', 'owner-interview.md'),
    path.join(docsRel, 'project-state.md'),
    path.join(docsRel, 'decisions.md'),
    path.join(docsRel, 'backlog-index.md'),
    path.join(docsRel, 'vision.md'),
    path.join(docsRel, 'backlog'),
  ].filter((p) => exists(path.join(projectRoot, p)));
}

module.exports = {
  STEP,
  WINDOW,
  SUMMARY_PATH,
  interviewSessionName,
  interviewMarker,
  interviewPrompt,
  launchInterview,
  interviewLive,
  endInterview,
  interviewCommitPaths,
};
