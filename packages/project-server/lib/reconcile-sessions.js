'use strict';

/**
 * The reconcile track's two interactive steps (docs/plans/reconciliation-workflow.md):
 *
 *   intent_interview  skill reconcile_interview, in the project checkout, where
 *                     the record was filed. Finish commits the record and the
 *                     decisions log there, then hands over to integration.
 *   owner_decision    skill reconcile_decisions, in the track's worktree, where
 *                     the integration branch and the reviews are. Finish commits
 *                     the record, the decisions log and any items filed there,
 *                     then hands over to apply.
 *
 * Both run as interactive sessions (interactive-session.js), stored on the
 * step as `session`, never as workflow agents.
 */

const fs = require('fs');
const path = require('path');
const { sanitize, launchSession, sessionLive, endSession } = require('./interactive-session');
const tracks = require('./reconcile-track');

const KINDS = {
  intent_interview: { window: 'interview', skill: 'reconcile_interview', finish: 'Finish interview', next: 'integration', stepGroup: 'owner_interview' },
  owner_decision: { window: 'decisions', skill: 'reconcile_decisions', finish: 'Finish decisions', next: 'apply', stepGroup: 'owner_interview' },
};

function projectName(config) {
  return config.name || path.basename(config.projectRoot);
}

function sessionName(config) {
  return `reconcile-${sanitize(projectName(config)) || 'project'}`;
}

/** Windows are unique per track, so several tracks can each have a live session. */
function windowName(track, stepKey) {
  return `rc-${track.id}-${KINDS[stepKey].window}`;
}

function marker(config, track, stepKey) {
  return `${stepKey === 'intent_interview' ? 'reconcile interview' : 'reconcile review decisions'} for ${track.id} in the project "${projectName(config)}"`;
}

function promptFor(config, track, stepKey) {
  const dir = tracks.trackDir(config.projectRoot, track.id);
  const src = track.source || {};
  const sourceLine = src.path
    ? `The source checkout is ${src.path} (branch ${src.branch || 'HEAD'}). Never write there.`
    : `The source is the ref ${src.ref} in this repository.`;
  if (stepKey === 'intent_interview') {
    return `Use the \`reconcile_interview\` skill to run the ${marker(config, track, stepKey)}.

This is an INTERACTIVE session. The owner is at the keyboard and will answer.

The intake has run. Its report is ${path.join(dir, 'intake.md')} (the same as JSON beside it). The reconcile record is ${track.record}: fill its sections as you go. The source is pinned on ${src.pin} at ${src.sha}; read it through the pin (git show / git diff). ${sourceLine}${track.brief ? ` The owner's brief is ${track.brief} in the source: context, not truth.` : ''}

Put every path that stays out of what comes home in the record's \`reconcile-keep-out\` block, one per line: the integration reads that block, not the prose.

Write each answer down as it is made. Do not commit. When you are done, tell the owner to click ${KINDS[stepKey].finish}.`;
  }
  return `Use the \`reconcile_decisions\` skill to run the ${marker(config, track, stepKey)}.

This is an INTERACTIVE session. The owner is at the keyboard and will answer.

You are in the track's worktree, on the integration branch ${track.branch}. The role reviews are in ${path.join(dir, 'reviews')}/. The reconcile record is ${track.record} here: record each decision in its "Review decisions" section as it is made, and one row per decision in docs/decisions.md.

File any follow-up backlog item through Build Studio, never by writing backlog files:
curl -s -X POST -H 'Content-Type: application/json' --data @<file> http://localhost:${config.port}/api/reconcile/${track.id}/items
with a JSON body { "title", "type", "body", and "after" or "before" or "release" }. The item is filed on this branch, with an id that cannot collide with the project's.

Do not commit. When you are done, tell the owner to click ${KINDS[stepKey].finish}.`;
}

function resumePrompt(config, track, stepKey) {
  return stepKey === 'intent_interview'
    ? `Continue the ${marker(config, track, stepKey)} where we left off. Re-read ${track.record} and docs/decisions.md first, then pick up from the next open change group.`
    : `Continue the ${marker(config, track, stepKey)} where we left off. Re-read the "Review decisions" section of ${track.record} first, then pick up from the next open finding.`;
}

function specFor(config, track, stepKey) {
  if (!KINDS[stepKey]) throw new Error(`not an interactive reconcile step: ${stepKey}`);
  const cwd = stepKey === 'intent_interview' ? config.projectRoot : track.worktree;
  if (!cwd) throw new Error(`${stepKey} needs the track's worktree; run integration first`);
  return {
    stepKey: KINDS[stepKey].stepGroup,
    sessionName: sessionName(config),
    window: windowName(track, stepKey),
    marker: marker(config, track, stepKey),
    prompt: promptFor(config, track, stepKey),
    resumePrompt: resumePrompt(config, track, stepKey),
    cwd,
    promptFile: path.join(tracks.trackDir(config.projectRoot, track.id), `prompt-${KINDS[stepKey].window}.txt`),
    logName: `reconcile-${track.id}-${KINDS[stepKey].window}.log`,
  };
}

/** Start or resume a step's session; returns the updated track (saved). */
function launch({ config, tmuxOps, track: given, stepKey, findSessionId }) {
  const track = stepKey === 'owner_decision' ? tracks.ensureWorktree(config.projectRoot, given) : given;
  const step = track.steps[stepKey] || {};
  const session = launchSession({ config, tmuxOps, spec: specFor(config, track, stepKey), prior: step.session || null, findSessionId });
  const next = {
    ...track,
    currentStep: stepKey,
    steps: { ...track.steps, [stepKey]: { ...step, status: 'running', session, startedAt: step.startedAt || session.launchedAt } },
  };
  tracks.saveTrack(config.projectRoot, next);
  return next;
}

/** Stop a step's session, keeping it resumable; returns the updated track (saved). */
function end({ config, tmuxOps, track, stepKey, findSessionId }) {
  const step = track.steps[stepKey] || {};
  if (!step.session) return track;
  const session = endSession({ session: step.session, config, tmuxOps, marker: marker(config, track, stepKey), findSessionId });
  const next = { ...track, steps: { ...track.steps, [stepKey]: { ...step, session } } };
  tracks.saveTrack(config.projectRoot, next);
  return next;
}

/** Repo-relative paths a step's Finish commits, in the checkout it ran in. */
function commitPaths(cwd, track, stepKey, docsRel = 'docs', exists = fs.existsSync) {
  const paths = [track.record, path.join(docsRel, 'decisions.md'), path.join(docsRel, 'backlog-index.md')];
  if (stepKey === 'owner_decision') paths.push(path.join(docsRel, 'backlog'));
  return [...new Set(paths)].filter((p) => p && exists(path.join(cwd, p)));
}

/**
 * Finish a step: end the session if live, commit what it wrote, and hand over.
 * deps: { commit(cwd, paths, message) → Promise<{committed, reason?}> }
 */
async function finish({ config, tmuxOps, track, stepKey, docsRel = 'docs', findSessionId }, deps = {}) {
  let t = track;
  if (t.steps[stepKey] && t.steps[stepKey].session && !t.steps[stepKey].session.endedAt) {
    t = end({ config, tmuxOps, track: t, stepKey, findSessionId });
  }
  const cwd = stepKey === 'intent_interview' ? config.projectRoot : t.worktree;
  const doCommit = deps.commit || require('./scoped-commit').scopedCommit;
  const paths = commitPaths(cwd, t, stepKey, docsRel);
  const message = stepKey === 'intent_interview'
    ? `docs(${t.id}): record the reconcile interview`
    : `docs(${t.id}): record the owner's review decisions`;
  const commit = paths.length ? await doCommit(cwd, paths, message) : { committed: false, reason: 'nothing to commit' };
  const now = new Date().toISOString();
  const next = {
    ...t,
    currentStep: KINDS[stepKey].next,
    steps: {
      ...t.steps,
      [stepKey]: { ...t.steps[stepKey], status: 'done', completedAt: now, commit },
      [KINDS[stepKey].next]: { ...(t.steps[KINDS[stepKey].next] || {}), status: 'pending' },
    },
  };
  tracks.saveTrack(config.projectRoot, next);
  return next;
}

function live(track, stepKey, tmuxOps) {
  return sessionLive(track.steps[stepKey] && track.steps[stepKey].session, tmuxOps);
}

/**
 * The paths in the record's `reconcile-keep-out` block. Lines may be blank or
 * start with `#` (a comment). No block means nothing stays out.
 */
function parseKeepOut(recordText) {
  const m = String(recordText || '').match(/```reconcile-keep-out[ \t]*\n([\s\S]*?)```/);
  if (!m) return [];
  return m[1].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

module.exports = {
  KINDS, sessionName, windowName, marker, promptFor, specFor,
  launch, end, finish, live, commitPaths, parseKeepOut,
};
