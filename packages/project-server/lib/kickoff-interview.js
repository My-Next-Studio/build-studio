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
const { findDraftSessionId } = require('./draft-session-id');
const { sanitize, launchSession, sessionLive, endSession } = require('./interactive-session');
const { inputsGuide } = require('./kickoff-inputs');

const STEP = 'owner_interview';
const WINDOW = 'interview';
/** The file the skill writes and team_review / pm_revision read. */
const SUMMARY_PATH = 'docs/inputs/owner-interview.md';

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
function interviewPrompt(projectName, mode = 'kickoff', inputsGuideText = '') {
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
Finish interview.${mode === 'onboarding' ? '' : `

Decisions the inputs time for later (when a feature is drafted, a later phase,
after an investigation) are not interview questions: the skill says where they go.`}${inputsGuideText ? `\n\n${inputsGuideText}` : ''}`;
}

/**
 * Start or resume the interview session.
 *
 * @returns {object} the session record to store on the step
 */
function launchInterview({ config, tmuxOps, prior = null, mode = 'kickoff', findSessionId = findDraftSessionId }) {
  const projectName = config.name || path.basename(config.projectRoot);
  const docsPath = config.docsPath || path.join(config.projectRoot, 'docs');
  const guide = mode === 'onboarding' ? '' : inputsGuide(path.join(docsPath, 'inputs'));
  return launchSession({
    config,
    tmuxOps,
    prior,
    findSessionId,
    spec: {
      stepKey: STEP,
      sessionName: interviewSessionName(projectName),
      window: WINDOW,
      marker: interviewMarker(projectName),
      prompt: interviewPrompt(projectName, mode, guide),
      resumePrompt: 'Continue the owner interview where we left off. Re-read docs/inputs/owner-interview.md and the Key Decisions Log (docs/decisions.md) first, then pick up from the next open topic.',
    },
  });
}

/** Is the interview's agent still running? */
function interviewLive(session, tmuxOps) {
  return sessionLive(session, tmuxOps);
}

/**
 * Stop the agent, keeping the conversation resumable. Reads a Codex/OpenCode
 * id back first, so a later Start resumes without another lookup.
 */
function endInterview({ session, config, tmuxOps, findSessionId = findDraftSessionId }) {
  const projectName = config.name || path.basename(config.projectRoot);
  return endSession({ session, config, tmuxOps, marker: interviewMarker(projectName), findSessionId });
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
