'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Pathspec-scoped git commit that is safe to run in a working tree agents are
 * concurrently using (support auto-commit, 2026-07-17).
 *
 * The concurrency contract:
 *  - `git add -- <paths>` + `git commit -m msg -- <paths>` — a PATHSPEC-limited
 *    commit records ONLY those paths; anything an agent has staged in parallel
 *    stays staged and untouched (a bare `git commit` would sweep the index).
 *  - If a concurrent actor (an agent's sweep-all commit, a merge) already
 *    committed our paths, `status --porcelain -- <paths>` comes back clean and
 *    we report success — the content is in history either way.
 *  - index.lock contention and merge/rebase-in-progress (git refuses partial
 *    commits during a merge) are retried with backoff, then surrendered with a
 *    reason string. The CALLER must treat a failed commit as non-fatal: the
 *    files exist in the working tree; only the commit is pending.
 */

function run(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** A merge/rebase/cherry-pick is in flight — partial commits are refused. */
function repoBusy(projectRoot) {
  const g = path.join(projectRoot, '.git');
  return ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD']
    .some((f) => fs.existsSync(path.join(g, f)));
}

/**
 * Commit exactly `relPaths` (repo-relative) with `message`.
 * @returns {Promise<{committed: boolean, sha: string|null, reason: string}>}
 */
async function scopedCommit(projectRoot, relPaths, message, { attempts = 6, delayMs = 500 } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await delay(delayMs);
    if (repoBusy(projectRoot)) continue;

    const add = await run(projectRoot, ['add', '--', ...relPaths]);
    if (add.err) {
      if (/index\.lock/.test(add.stderr)) continue;
      return { committed: false, sha: null, reason: `git add failed: ${(add.stderr || add.err.message).trim().slice(0, 200)}` };
    }

    const st = await run(projectRoot, ['status', '--porcelain', '--', ...relPaths]);
    if (!st.err && st.stdout.trim() === '') {
      return { committed: true, sha: null, reason: 'already committed by a concurrent actor' };
    }

    const commit = await run(projectRoot, ['commit', '-m', message, '--', ...relPaths]);
    if (commit.err) {
      const out = `${commit.stderr}\n${commit.stdout}`;
      if (/index\.lock/.test(out) || /partial commit during a merge/i.test(out)) continue;
      if (/nothing to commit|no changes added/i.test(out)) {
        return { committed: true, sha: null, reason: 'already committed by a concurrent actor' };
      }
      return { committed: false, sha: null, reason: `git commit failed: ${out.trim().slice(0, 200)}` };
    }

    const sha = await run(projectRoot, ['rev-parse', '--short', 'HEAD']);
    return { committed: true, sha: sha.stdout.trim() || null, reason: 'committed' };
  }
  return { committed: false, sha: null, reason: 'repo busy (merge/rebase in progress or lock contention)' };
}

module.exports = { scopedCommit, repoBusy };
