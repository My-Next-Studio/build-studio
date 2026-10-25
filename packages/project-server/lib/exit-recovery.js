'use strict';

/**
 * Recovering an agent that finished its work and then exited without reporting.
 *
 * The pattern has now appeared four times across three CLIs: the agent writes
 * the files, makes the commit, and ends without running its feedback POST. The
 * workflow then waits forever on a report that will never come, while the work
 * sits finished on the branch.
 *
 * `transcript-recovery.js` handles the case where the agent's own words survive
 * — but that reads Claude's JSONL session file, and codex and opencode write
 * nothing of the kind. For those, the only surviving evidence is what landed in
 * git. That is weaker evidence, and this module is careful about the
 * difference: it reconstructs a statement of WHAT IS ON DISK, and says so, in
 * place of a verdict the agent never delivered.
 *
 * The distinction matters because the alternative is worse in both directions.
 * Relaunching redoes work that is already committed (and risks conflicting with
 * it), while inventing a plausible-sounding report would put words in an
 * agent's mouth and quietly turn "we don't know" into "approved".
 *
 * That reasoning holds only for agents whose deliverable IS the diff. For a
 * planner it inverts — see PLANNING_ROLES below.
 */

/**
 * Roles whose deliverable is a plan, not a diff.
 *
 * Git reconstruction is structurally incapable of recovering these. A planner
 * writes no code; its entire output is the JSON task list it POSTs. So the
 * commits this module would find on the branch are never the planner's — they
 * belong to the Dev agents of earlier rounds — and a summary of them is
 * evidence about someone else's work filed under the planner's name.
 *
 * Worse, it is a dead end rather than a mistake the operator can undo: the
 * fix_plan approval gate parses planner feedback for a ```json block, prose
 * cannot satisfy it, and the step is left `done` holding content that can never
 * pass. Observed on a fazon PRD-105 round-3 fix_plan (2026-08-09), where codex
 * died before emitting a single token and Recover filed the round-2 iOS Dev's
 * nine commits in its place; the run then had no button out.
 *
 * Transcript recovery is unaffected and remains the right path — a planner's
 * own words DO contain its plan. Only the git fallback is refused here.
 */
const PLANNING_ROLES = new Set(['planner', 'fixplanner']);

/** Same normalization as the workflow API's normalizeRole, so spellings agree. */
function isPlanningRole(role) {
  return PLANNING_ROLES.has(String(role || '').toLowerCase().replace(/[\s_-]+/g, ''));
}

/**
 * Does this agent have work worth recovering rather than redoing?
 * @param {object} facts   from the caller's git inspection
 * @param {string} [role]  the agent's role — a planner is never git-recoverable
 */
function hasRecoverableWork(facts, role) {
  if (isPlanningRole(role)) return false;
  return !!(facts && Array.isArray(facts.commits) && facts.commits.length > 0);
}

/**
 * A factual report of what an exited agent left behind.
 *
 * Deliberately labelled as reconstructed and deliberately narrow. The closing
 * section states what is NOT being claimed, because those are exactly the
 * judgements the agent was launched to make and they died with it — a reader
 * finding this in the record months later must not mistake it for a sign-off.
 *
 * @param {{role:string, cli?:string, step?:string, base?:string,
 *          commits:{sha:string, subject:string}[], filesChanged?:number,
 *          insertions?:number, deletions?:number, dirty?:string[]}} facts
 */
/** In the heading of every reconstruction, and only there; see isReconstructed. */
const RECONSTRUCTED_MARK = 'RECONSTRUCTED, not agent-authored';

/** Is this report Build Studio's reconstruction from git rather than the agent's own? */
function isReconstructed(feedback) {
  return typeof feedback === 'string' && /^## .* — work recovered from git \(RECONSTRUCTED, not agent-authored\)/.test(feedback);
}

function buildWorkSummary(facts) {
  const {
    role = 'Agent', cli, step, base = 'main',
    commits = [], filesChanged, insertions, deletions, dirty = [],
  } = facts || {};

  const lines = [];
  lines.push(`## ${role} — work recovered from git (${RECONSTRUCTED_MARK})`);
  lines.push('');
  lines.push('**How this report came to exist.** The agent committed its work and then its');
  lines.push(`process exited without reporting${cli ? `. ${cli} writes no resumable session or transcript, so` : ', so'}`);
  lines.push('its own account of the work could not be retrieved. What follows was');
  lines.push('reconstructed from the commits by Build Studio: it describes what is on disk,');
  lines.push('and is not a verdict the agent reached.');
  lines.push('');
  lines.push(`**Commits on this branch since \`${base}\`:** ${commits.length}`);
  for (const c of commits) lines.push(`  - \`${c.sha}\` ${c.subject}`);

  if (Number.isFinite(filesChanged)) {
    const churn = [
      `${filesChanged} file${filesChanged === 1 ? '' : 's'} changed`,
      Number.isFinite(insertions) ? `+${insertions}` : null,
      Number.isFinite(deletions) ? `-${deletions}` : null,
    ].filter(Boolean).join(', ');
    lines.push('');
    lines.push(`**Churn:** ${churn}`);
  }

  lines.push('');
  if (dirty.length) {
    // Uncommitted work is a caveat, not a footnote: it means the agent stopped
    // part-way through something, and the commits alone do not describe it.
    lines.push(`**⚠ Uncommitted changes were left behind (${dirty.length}):**`);
    for (const f of dirty.slice(0, 20)) lines.push(`  - ${f}`);
    if (dirty.length > 20) lines.push(`  - …and ${dirty.length - 20} more`);
    lines.push('');
    lines.push('The agent may have stopped mid-task. Review these before treating the step as done.');
  } else {
    lines.push('**Working tree:** clean — everything the agent produced is committed.');
  }

  lines.push('');
  lines.push('### Not asserted here');
  lines.push('No claim is made about correctness, completeness, or whether anything passes.');
  lines.push(`Those were ${role}'s to judge and were lost when the process exited${step ? ` during \`${step}\`` : ''}.`);
  lines.push('Judge them from the diff and from whatever gate this step runs.');
  return lines.join('\n');
}

module.exports = { hasRecoverableWork, buildWorkSummary, isReconstructed, isPlanningRole, PLANNING_ROLES };
