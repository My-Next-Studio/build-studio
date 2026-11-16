'use strict';

/**
 * Commit the backlog status files a workflow writes (backlog items, the
 * backlog index, project-state.md) on the current branch.
 *
 * Synchronous, because its callers go on to merge or finish the run and need
 * the commit made first. Another git process holding the index lock makes it
 * wait and try again, up to `attempts` times: the scorecard commit starts in
 * the background just before a review's status commit, and with no retry the
 * status commit lost that race and the item's new status stayed uncommitted
 * (phoclub, ten times by 2026-11-16, PHO-050 among them).
 *
 * @param {string} projectRoot
 * @param {string[]} relPaths  paths under the repo; missing ones are skipped
 * @param {string} message
 * @param {{attempts?: number, delayMs?: number, log?: object}} [opts]
 * @returns {{committed: boolean, reason: string}}
 */
function commitDocsSync(projectRoot, relPaths, message, opts = {}) {
  const { execFileSync } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const attempts = opts.attempts || 8;
  const delayMs = opts.delayMs || 250;
  const log = opts.log || console;

  const paths = relPaths.filter((p) => fs.existsSync(path.join(projectRoot, p)));
  if (paths.length === 0) return { committed: false, reason: 'no such paths' };
  const git = (args, encoding) => execFileSync('git', args, { cwd: projectRoot, encoding, stdio: ['pipe', 'pipe', 'pipe'] });

  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    if (i > 0) sleepSync(delayMs);
    try {
      git(['add', '--', ...paths]);
      const staged = String(git(['diff', '--cached', '--name-only', '--', ...paths], 'utf8')).trim();
      if (!staged) return { committed: false, reason: 'nothing to commit' };
      // `-- paths` keeps the commit to these files even if anything else is staged.
      git(['commit', '-m', message, '--', ...paths]);
      log.log(`[workflow] committed backlog status (${staged.split('\n').length} file(s)): ${message}`);
      return { committed: true, reason: 'committed' };
    } catch (e) {
      lastError = e;
      const out = `${e.stderr || ''}\n${e.stdout || ''}\n${e.message || ''}`;
      if (!/index\.lock/.test(out)) break;
    }
  }
  const detail = lastError ? `${lastError.message}${lastError.stderr ? `\n${String(lastError.stderr).trim()}` : ''}` : 'unknown error';
  log.warn(`[workflow] commitWorkflowDocs failed: ${detail}`);
  return { committed: false, reason: detail };
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

module.exports = { commitDocsSync };
