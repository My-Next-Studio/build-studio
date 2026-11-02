'use strict';

/**
 * The reconcile track's agent steps (docs/plans/reconciliation-workflow.md):
 *
 *   align        the builder makes the imported code meet the owner-approved
 *                ACs; the PM copies those ACs verbatim into the PRDs.
 *   team_review  roles by risk tier review the integration branch against the
 *                approved behaviour, each writing a review file.
 *   apply        the builder makes the code fixes the owner decided; the roles
 *                make the document updates.
 *
 * Agents launch through the workflow engine's own launcher (its CLI and memory
 * guards, crash resume, simulator environment), with a pseudo-workflow for the
 * track, and report to the track's feedback endpoint instead of the slot's.
 *
 * Writers never share a worktree. The builder works in the track's worktree, on
 * reconcile/<id>. Document agents work in a second worktree on
 * reconcile/<id>-docs, cut from it at the step's start. When every agent has
 * reported, that branch is merged back, as in the first case's docs pass, where
 * the two sides' files did not overlap.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const tracks = require('./reconcile-track');
const { sanitize } = require('./interactive-session');

const AGENT_STEPS = { align: 'team_review', team_review: 'owner_decision', apply: 'ready' };

/** Review roster by risk tier (plan, "Review, by risk tier"). */
const TIER_ROLES = {
  light: ['UX', 'Brand', 'QA'],
  standard: ['Architect', 'UX', 'Brand', 'Code Reviewer', 'QA'],
  sensitive: ['Architect', 'Security', 'UX', 'Brand', 'Code Reviewer', 'QA'],
};

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 26 });
}

function commandExists(cwd, command) {
  return !!command && fs.existsSync(path.join(cwd, '.claude', 'commands', command));
}

/** The command file for a role: the project's review roster first, then the conventional name. */
function commandFor(config, role, cwd) {
  const all = [
    ...(((config.roles || {}).review) || []),
    ...(((config.roles || {}).execution) || []),
  ];
  const hit = all.find((r) => r && String(r.role).toLowerCase() === role.toLowerCase());
  if (hit && hit.command) return hit.command;
  const conventional = `${role.toLowerCase().replace(/\s+/g, '_')}.md`;
  return commandExists(cwd, conventional) ? conventional : null;
}

function reviewRoster(config, tier, cwd) {
  return (TIER_ROLES[tier] || TIER_ROLES.standard)
    .map((role) => ({ role, command: commandFor(config, role, cwd) }))
    .filter((r) => r.command);
}

function builderRole(config, track) {
  const exec = ((config.roles || {}).execution) || [];
  const named = track.builderRole && exec.find((r) => r.role === track.builderRole);
  const r = named || exec[0];
  return r ? { role: r.role, command: r.command || `${String(r.skill || r.role).toLowerCase().replace(/\s+/g, '_')}.md` } : { role: 'Developer', command: null };
}

function pseudoWorkflow(config, track, stepKey) {
  return {
    id: `reconcile-${track.id}`,
    type: 'reconcile',
    input: track.id,
    prdPath: track.record,
    currentStep: stepKey,
    round: (track.steps[stepKey] && track.steps[stepKey].round) || 1,
    sessionName: `rc-${sanitize(config.name || path.basename(config.projectRoot)) || 'project'}-${track.id}`,
    feedback: [],
    steps: {},
  };
}

function windowFor(track, role) {
  return `${track.id}-${role.toLowerCase().replace(/[^a-z0-9]+/g, '')}`;
}

const SPEC = (track) => `**The spec** is the owner-approved behaviour in the reconcile record ${track.record}, section *Approved behaviour*, and, after the review, its section *Review decisions*. The branch's own validation records, handover notes and PRD prose are the builder's claims, not evidence.`;

function reviewsDir(config, track) {
  return path.join(tracks.trackDir(config.projectRoot, track.id), 'reviews');
}

/** The agents for a step, with their instructions and working directories. */
function agentsFor(config, track, stepKey, { docsWorktree }) {
  const b = builderRole(config, track);
  const readCmd = (c) => (c ? `Read \`.claude/commands/${c}\`, \`AGENTS.md\` and \`ARCHITECTURE.md\` first.` : 'Read `AGENTS.md` and `ARCHITECTURE.md` first.');
  const fence = `Never touch the project's main checkout at ${config.projectRoot}, the source checkout${track.source && track.source.path ? ` (${track.source.path})` : ''}, or another worktree. Never quit, restart or kill the Build Studio app or any project-server.`;
  const stay = `You work in a git worktree on its branch. Commit there, per logical chunk, with Conventional Commits naming ${track.id}. ${fence}`;

  if (stepKey === 'align') {
    return [
      {
        role: b.role, window: windowFor(track, b.role), cwd: track.worktree, reportFeedback: true,
        instruction: `You are the **${b.role}** for a reconcile integration. ${readCmd(b.command)} ${stay}

The branch ${track.branch} holds the work built outside Build Studio as one import commit. ${SPEC(track)}

**Your task:** make the code meet the approved acceptance criteria. Where the record withdraws or changes what the builder built, change the code to match the record, not the other way round. Restore any test the import deleted that pins approved behaviour. Do not edit anything under docs/; a parallel document agent does that. Do revise \`ARCHITECTURE.md\` for the merged code, per AGENTS.md.

Build, then run the unit tests and the UI or E2E tests that cover what you changed, serially, per the project's conventions. Report the commits, what you changed per AC, and the exact test counts.`,
      },
      {
        role: 'PM', window: windowFor(track, 'PM'), cwd: docsWorktree, reportFeedback: true, docs: true,
        instruction: `You are the **PM** for a reconcile integration. Read \`.claude/commands/pm.md\` and \`AGENTS.md\` first. ${stay}

${SPEC(track)}

**Your task:** copy each group's approved acceptance criteria from the record into the PRD it names, **verbatim**. The line "Changes to the branch's PRD" under each group says which section they replace. Above the copied criteria, add one line saying that they were approved by the owner in ${track.id} and replace the builder's own list, which stays in git history. Never paraphrase an approved criterion. Touch only docs/.

Report the commits and, per PRD, which section you replaced.`,
      },
    ];
  }

  if (stepKey === 'team_review') {
    const dir = reviewsDir(config, track);
    return reviewRoster(config, track.tier, track.worktree).map((r) => ({
      role: r.role, window: windowFor(track, r.role), cwd: track.worktree, reportFeedback: true,
      instruction: `You are **${r.role}** reviewing a reconcile integration (risk tier: ${track.tier}). Read \`.claude/commands/${r.command}\` and \`AGENTS.md\` first.

Review the branch ${track.branch} against the target: \`git diff ${track.target.integratedOn || track.target.ref}..${track.branch}\`. ${SPEC(track)}

**Check first:** behaviour the branch **removed or changed** from the target that no approved criterion covers. Compare against the target, not only against what was added. In the first case, both blocking findings were removals that no document mentioned.

${r.role === 'QA' ? `**Run the suites that cover what changed**, serially, per the project's conventions. Before you count a failure as a finding, rerun it on the commit before the integration's latest fix (or on the import commit), and report both results. A test that also fails there is flaky or pre-existing, not a finding about this change.\n\n` : ''}**Read only:** do not edit, stage or commit anything; test runs and build output are fine. ${fence}

Write your review to \`${path.join(dir, `${r.role.toLowerCase().replace(/\s+/g, '-')}.md`)}\` in this format:

\`\`\`
**Verdict:** accept | accept with document changes | pushback
**Blocking:** N  |  **Medium:** N  |  **Low:** N
### Summary
### Findings
(severity, file:line, what is wrong, why it matters, suggested fix)
### Proposed document changes
### Backlog proposals
### Answers to open questions routed to you
\`\`\`

Use **pushback** only for what should not reach the default branch as it is. Then report the verdict line and the counts as your feedback.`,
    }));
  }

  if (stepKey === 'apply') {
    return [
      {
        role: b.role, window: windowFor(track, b.role), cwd: track.worktree, reportFeedback: true,
        instruction: `You are the **${b.role}** for a reconcile integration. ${readCmd(b.command)} ${stay}

${SPEC(track)} The owner has decided every finding from the role reviews, in the record's *Review decisions* section. The reviews themselves, with file:line evidence, are in ${reviewsDir(config, track)}/.

**Your task:** make every code fix the owner approved, and add the tests the decisions ask for. Where a decision amends a criterion, the amended wording in *Approved behaviour* is the spec. Do not edit anything under docs/; a parallel document agent does that. Keep \`ARCHITECTURE.md\` true to the code.

Build, then run the unit tests and the UI or E2E tests that cover what you changed, serially. Report the commits, what changed per decision, and the exact test counts.`,
      },
      {
        role: 'Docs', window: windowFor(track, 'Docs'), cwd: docsWorktree, reportFeedback: true, docs: true,
        instruction: `You apply the **document updates** the owner approved after the role reviews of a reconcile integration, acting in turn as each role whose documents change (/pm, /architect, /ux, /brand, …). Read each role's \`.claude/commands/<role>.md\` before doing its part, and \`AGENTS.md\` first. ${stay} Commit one commit per role.

${SPEC(track)} The approved document updates are listed in the record's *Review decisions* section. The exact proposals are in the reviews in ${reviewsDir(config, track)}/, under *Proposed document changes*.

Rewrite \`docs/project-state.md\` for the state after this merge. Touch only docs/ and design-rule files such as DESIGN.md. Never paraphrase an owner-approved criterion or string. Where a review's proposal conflicts with an owner decision, the decision wins: say so in your report.

Report the commits and one line per document changed.`,
      },
    ];
  }
  throw new Error(`not a reconcile agent step: ${stepKey}`);
}

/**
 * Launch a step's agents. `launchAgents` is the workflow router's launcher.
 * Returns the saved track.
 */
function launchStep({ config, track: given, stepKey, launchAgents }) {
  if (!AGENT_STEPS[stepKey]) throw new Error(`not a reconcile agent step: ${stepKey}`);
  const track = tracks.ensureWorktree(config.projectRoot, given);
  if (stepKey === 'team_review') fs.mkdirSync(reviewsDir(config, track), { recursive: true });

  const prior = track.steps[stepKey] || {};
  const round = prior.status === 'done' || (prior.agents || []).length ? (prior.round || 1) + 1 : 1;

  // Document agents get their own worktree, cut from the integration branch now.
  let docsWorktree = null;
  let docsBranch = null;
  const needsDocs = stepKey === 'align' || stepKey === 'apply';
  if (needsDocs) {
    docsBranch = `${track.branch}-docs`;
    docsWorktree = path.join(config.projectRoot, 'tmp', '.worktrees', `reconcile-${track.id}-docs`);
    try { git(config.projectRoot, ['worktree', 'remove', '--force', docsWorktree]); } catch (_) { /* none */ }
    try { git(config.projectRoot, ['branch', '-D', docsBranch]); } catch (_) { /* none */ }
    git(config.projectRoot, ['worktree', 'add', '-q', '-b', docsBranch, docsWorktree, track.branch]);
  }

  const wf = pseudoWorkflow(config, { ...track, steps: { ...track.steps, [stepKey]: { round } } }, stepKey);
  const defs = agentsFor(config, track, stepKey, { docsWorktree });
  const launched = [];
  for (const d of defs) {
    const [a] = launchAgents(wf, [{ role: d.role, window: d.window, reportFeedback: true, instruction: d.instruction }], {
      cwd: d.cwd, stepKey, feedbackPath: `/api/reconcile/${track.id}/feedback`,
    });
    launched.push({ ...a, docs: !!d.docs, cwd: d.cwd });
  }
  const next = {
    ...track,
    sessionName: wf.sessionName,
    currentStep: stepKey,
    steps: {
      ...track.steps,
      [stepKey]: { status: 'running', round, startedAt: new Date().toISOString(), agents: launched, docsBranch, docsWorktree },
    },
  };
  tracks.saveTrack(config.projectRoot, next);
  return next;
}

/** Merge the step's docs branch back into the integration branch, then drop it. */
function mergeDocsBranch(config, track, step) {
  if (!step.docsBranch) return null;
  const msg = `Merge ${step.docsBranch}: document updates for ${track.id}`;
  git(track.worktree, ['merge', '--no-ff', '-q', '-m', msg, step.docsBranch]);
  try { git(config.projectRoot, ['worktree', 'remove', '--force', step.docsWorktree]); } catch (_) { /* gone */ }
  try { git(config.projectRoot, ['branch', '-d', step.docsBranch]); } catch (_) { /* kept if unmerged */ }
  return git(track.worktree, ['rev-parse', 'HEAD']).trim();
}

/**
 * Close a step whose agents have all reported (or that the owner closes by
 * hand): merge the docs branch, mark it done and move on. A merge conflict
 * leaves the step at `error` with the reason.
 */
function completeStep({ config, track, stepKey }) {
  const step = track.steps[stepKey] || {};
  let docsMerge = null;
  try {
    docsMerge = mergeDocsBranch(config, track, step);
  } catch (err) {
    try { git(track.worktree, ['merge', '--abort']); } catch (_) { /* nothing to abort */ }
    const failed = { ...track, steps: { ...track.steps, [stepKey]: { ...step, status: 'error', error: `merging ${step.docsBranch}: ${String(err.stderr || err.message).trim()}` } } };
    tracks.saveTrack(config.projectRoot, failed);
    return failed;
  }
  const nextStep = AGENT_STEPS[stepKey];
  const next = {
    ...track,
    currentStep: nextStep,
    steps: {
      ...track.steps,
      [stepKey]: { ...step, status: 'done', completedAt: new Date().toISOString(), docsMerge, docsWorktree: null },
      [nextStep]: { ...(track.steps[nextStep] || {}), status: (track.steps[nextStep] || {}).status === 'done' ? 'done' : 'pending' },
    },
  };
  tracks.saveTrack(config.projectRoot, next);
  return next;
}

/**
 * An agent's report. Marks it done; when the whole step has reported, the step
 * completes (team_review also needs every review file on disk).
 */
function recordFeedback({ config, id, role, step: stepKey, feedback }) {
  const track = tracks.loadTrack(config.projectRoot, id);
  if (!track) throw new Error(`no reconcile track ${id}`);
  const step = track.steps[stepKey];
  if (!step || step.status !== 'running') throw new Error(`${stepKey} of ${id} is not running`);
  const agents = (step.agents || []).map((a) => (String(a.role).toLowerCase() === String(role).toLowerCase()
    ? { ...a, status: 'done', feedback: String(feedback || ''), reportedAt: new Date().toISOString() }
    : a));
  if (!agents.some((a) => String(a.role).toLowerCase() === String(role).toLowerCase())) throw new Error(`no agent ${role} in ${stepKey}`);
  let next = { ...track, steps: { ...track.steps, [stepKey]: { ...step, agents } } };
  tracks.saveTrack(config.projectRoot, next);
  const allDone = agents.every((a) => a.status === 'done');
  const reviewsPresent = stepKey !== 'team_review' || agents.every((a) => fs.existsSync(path.join(reviewsDir(config, next), `${a.role.toLowerCase().replace(/\s+/g, '-')}.md`)));
  if (allDone && reviewsPresent) next = completeStep({ config, track: next, stepKey });
  return next;
}

module.exports = {
  AGENT_STEPS, TIER_ROLES, reviewRoster, builderRole, agentsFor, pseudoWorkflow,
  launchStep, completeStep, recordFeedback, reviewsDir,
};
