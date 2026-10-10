'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

/**
 * Backlog items that exist on a run's branch but not on the default branch.
 *
 * Filing an item (POST /api/backlog/items: Create story, drafting, Launch
 * Studio's launch plan) commits it on whatever branch the checkout is on. During
 * a run that is the run's branch, and the item reaches the default branch when
 * the run merges (owner decision 2026-10-10, docs/backlog-api-contract.md §4).
 * Cancelling a run returns the checkout to the default branch, where those items
 * don't exist yet, so the cancel dialog lists them first.
 *
 * Returns [{ id, title }] in id order; [] when the run has no own branch, or
 * on any git error (the list is a warning, never a reason a cancel fails).
 */
function itemsFiledOnBranch(projectRoot, docsPath, branch, defaultBranch) {
  if (!branch || !defaultBranch || branch === defaultBranch) return [];
  const git = (args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const backlogRel = path.relative(projectRoot, path.resolve(projectRoot, docsPath || 'docs', 'backlog')).split(path.sep).join('/');
  try {
    const added = git(['diff', '--name-only', '--diff-filter=A', `${defaultBranch}...${branch}`, '--', backlogRel])
      .split('\n').filter((f) => /\/[A-Z]{2,5}-\d{1,5}\.md$/.test(f));
    return added.sort().map((file) => {
      const id = path.basename(file, '.md');
      let title = '';
      try {
        const m = git(['show', `${branch}:${file}`]).match(/^title:\s*(?:>-?\s*\n((?:[ \t]+.*\n?)+)|(.+))$/m);
        title = (m && (m[2] || m[1] || '')).replace(/\s+/g, ' ').replace(/^['"]|['"]$/g, '').trim();
      } catch (_) { /* the title is a nicety */ }
      return { id, title };
    });
  } catch (_) {
    return [];
  }
}

module.exports = { itemsFiledOnBranch };
