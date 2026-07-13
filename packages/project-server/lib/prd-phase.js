'use strict';

/**
 * PRD lifecycle phase derivation — pure function.
 *
 * Linear progression: drafted → reviewed → implemented → done.
 * Plus `deferred` as a side-state set by the owner.
 *
 *   drafted     — PRD file exists; no review has finished
 *   reviewed    — most recent review workflow ran to completion
 *   implemented — execution workflow merged to main
 *   done        — manually marked as finished by the owner
 *   deferred    — manually paused by the owner
 */

const PHASES = ['drafted', 'reviewed', 'implemented', 'done', 'deferred'];

/**
 * @param {object|null} input.prdFile   - { id, title, path, createdAt? } or null
 * @param {object|null} input.workflow  - workflow-state.json filtered to this PRD
 * @param {Array}       input.snapshots - completed-workflow snapshots filtered to this PRD
 *                                        [{ type: 'review'|'execution', completedAt, approved? }]
 * @param {object}      input.gitState  - { mergedSha?, mergedAt? } if execution merge is on main
 * @param {object|null} input.backlog   - { status, deferredAt?, doneAt?, reason?, previousPhase? }
 * @returns {object|null}
 */
function derivePrdPhase({ prdFile, workflow, snapshots, gitState, backlog }) {
  if (!prdFile) return null;

  const base = {
    id: prdFile.id,
    title: prdFile.title,
    path: prdFile.path,
    phase: null,
    phaseSince: null,
    currentWorkflow: null,
    mergedSha: gitState && gitState.mergedSha ? gitState.mergedSha : null,
    mergedAt: gitState && gitState.mergedAt ? gitState.mergedAt : null,
    deferred: null,
  };

  if (workflow) {
    base.currentWorkflow = {
      type: workflow.type,
      currentStep: workflow.currentStep,
      round: workflow.round,
    };
  }

  // 1. done — manual final marker beats all other signals
  if (backlog && backlog.status === 'done') {
    base.phase = 'done';
    base.phaseSince = backlog.doneAt || null;
    return base;
  }

  // 2. deferred — owner paused
  if (backlog && backlog.status === 'deferred') {
    base.phase = 'deferred';
    base.phaseSince = backlog.deferredAt || null;
    base.deferred = {
      reason: backlog.reason || null,
      previousPhase: backlog.previousPhase || null,
      previousPhaseAt: backlog.previousPhaseAt || null,
    };
    return base;
  }

  // 3. implemented — execution workflow has produced a merge commit on main
  if (gitState && gitState.mergedSha) {
    base.phase = 'implemented';
    base.phaseSince = gitState.mergedAt || null;
    return base;
  }

  // 4. reviewed — at least one review workflow ran to completion
  const completedReview = pickLatest((snapshots || []).filter((s) => s && s.approved), 'review');
  if (completedReview) {
    base.phase = 'reviewed';
    base.phaseSince = completedReview.completedAt || null;
    return base;
  }

  // 5. drafted — fallback
  base.phase = 'drafted';
  base.phaseSince = prdFile.createdAt || null;
  return base;
}

function pickLatest(snapshots, type) {
  if (!Array.isArray(snapshots) || snapshots.length === 0) return null;
  const filtered = snapshots.filter((s) => s && s.type === type && s.completedAt);
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => (a.completedAt < b.completedAt ? 1 : -1));
  return filtered[0];
}

module.exports = { derivePrdPhase, PHASES };
