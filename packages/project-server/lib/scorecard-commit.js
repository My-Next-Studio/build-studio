'use strict';

/**
 * Commit .build-studio/scorecard.jsonl after a completed run appends to it.
 *
 * Every finished workflow writes a row to the scorecard, which is a TRACKED
 * file. So each run ended by dirtying the working tree with output it generated
 * itself, and the next run could not start until someone committed it by hand
 * from the Operations tab — a manual step between every pair of runs, for a
 * file no human writes or reviews.
 *
 * Machine-written telemetry, so the run commits its own output.
 *
 * WHY PATHSPEC-SCOPED
 *
 * This fires while agents may still hold the working tree. scopedCommit records
 * ONLY this one path and leaves anything staged in parallel untouched; a bare
 * `git commit` would sweep an agent's index. See lib/scoped-commit.js, which
 * also owns the lock-contention and merge-in-progress retries.
 *
 * ADVISORY, NEVER FATAL
 *
 * A failed commit is logged and dropped. The row is already on disk, so the
 * worst case is the manual commit that was required before this existed — the
 * pre-existing behaviour, not a regression. Nothing here may throw into a
 * workflow's completion path.
 */

const fs = require('fs');
const path = require('path');
const { scopedCommit } = require('./scoped-commit');
const agentScorecard = require('./agent-scorecard');

/**
 * @returns {Promise<{committed:boolean, sha:string|null, reason:string}>}
 *   `committed:false` with a reason for every skip, so a caller (and a test)
 *   can tell "opted out" from "no repo" from "git refused".
 */
async function commitScorecard(projectRoot, statePath, config, wf, deps = {}) {
  const commit = deps.commit || scopedCommit;
  const exists = deps.exists || fs.existsSync;

  const sc = (config && config.scorecard) || {};
  if (sc.auto_commit === false) {
    return { committed: false, sha: null, reason: 'disabled by scorecard.auto_commit' };
  }
  if (!projectRoot || !statePath) {
    return { committed: false, sha: null, reason: 'no project root or state path' };
  }
  if (!exists(path.join(projectRoot, '.git'))) {
    return { committed: false, sha: null, reason: 'not a git repository' };
  }

  // statePath is configurable. If it ever resolves outside the repo there is no
  // pathspec to commit, and git would reject one that escapes the work tree.
  const rel = path.relative(projectRoot, agentScorecard.logPath(statePath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { committed: false, sha: null, reason: `scorecard path is outside the repo: ${rel}` };
  }

  const label = (wf && wf.type) || 'workflow';
  return commit(projectRoot, [rel], `chore(scorecard): record ${label} run`);
}

module.exports = { commitScorecard };
