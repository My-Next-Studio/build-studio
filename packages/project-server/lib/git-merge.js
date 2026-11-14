'use strict';

// `git merge --no-ff` without blocking the event loop.
//
// A managed project can install a `pre-merge-commit` hook as its merge gate,
// and git runs it inside the merge. One such gate runs a full local check
// (audit, build, lint, tests, scans) and takes ~35 s. Run with execFileSync,
// that whole time is spent with the project-server's event loop blocked: every
// API call, poll and WebSocket for the project stalls until the hook finishes.
// The merge therefore runs as a child process the server awaits.
//
// Error messages keep the shape execFileSync gave them ("Command failed: …"
// followed by git's stderr). Git forwards a hook's stdout to stderr, so the
// hook's own summary of what failed stays in `err.message`, which callers
// surface in the step's error.

const { execFile } = require('child_process');

// Generous: the gate is a project's full check, not a quick lint. It only has
// to stop a hook that hangs from holding the merge (and the lock) forever.
const MERGE_TIMEOUT_MS = 30 * 60 * 1000;

// A full build-and-test log can run past execFile's 1 MB default, and
// overflowing it kills git mid-merge with an unrelated-looking error.
const MERGE_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Merge `branch` into the branch checked out at `cwd`, always with a merge
 * commit. Resolves with git's output; rejects with an Error whose message
 * includes git's stderr (and so the hook's output).
 *
 * @param {string} cwd      checkout to merge in
 * @param {string} branch   branch to merge
 * @param {string} message  merge commit message
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  kill git after this long (default 30 min)
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function gitMergeNoFf(cwd, branch, message, { timeoutMs = MERGE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['merge', branch, '--no-ff', '-m', message], {
      cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: MERGE_MAX_BUFFER,
    }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout, stderr });
      // execFile signals its own timeout by killing the child; say so, or the
      // reader sees only a bare "Command failed" and whatever the hook printed.
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        err.message = `git merge output exceeded ${MERGE_MAX_BUFFER / 1024 / 1024} MB and git was killed\n${err.message}`;
      } else if (err.killed && err.signal) {
        const limit = timeoutMs % 60000 === 0 ? `${timeoutMs / 60000} min` : `${timeoutMs / 1000} s`;
        err.message = `git merge timed out after ${limit} (killed with ${err.signal}; a pre-merge-commit hook may be hanging)\n${err.message}`;
      }
      reject(err);
    });
  });
}

/**
 * In-process guard so two merges for the same key never overlap. While one is
 * in flight a second request would race it on the same checkout — and its
 * failure path runs `git merge --abort`, which would abort the FIRST merge.
 */
function createMergeLock() {
  const inFlight = new Map(); // key → startedAt ISO string
  return {
    /** @returns {boolean} true when the caller now holds the lock */
    acquire(key) {
      if (inFlight.has(key)) return false;
      inFlight.set(key, new Date().toISOString());
      return true;
    },
    release(key) { inFlight.delete(key); },
    startedAt(key) { return inFlight.get(key) || null; },
  };
}

module.exports = { gitMergeNoFf, createMergeLock, MERGE_TIMEOUT_MS };
