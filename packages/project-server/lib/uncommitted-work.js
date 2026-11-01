'use strict';

/**
 * Source changes a build task left uncommitted.
 *
 * Everything after task execution judges the run branch by its commits: QA's
 * suite scoping diffs the branch against the default branch, and the review
 * reads that diff. A builder that finishes with its fix still in the working
 * tree makes the branch look empty. FAZ-470 lost two hours that way: QA was
 * told to skip the iOS suite, ran it anyway on the uncommitted files, and the
 * review then failed the run for an uncommitted fix with no tests.
 *
 * docs/ is left out: workflow docs and QA evidence change under docs/ in every
 * run, and merge_to_main commits them itself.
 */

/** `git status --porcelain` (v1, read untrimmed) → [{status, path}]. */
function parsePorcelain(raw) {
  return String(raw || '').split('\n').filter(Boolean).map((line) => {
    let p = line.slice(3).replace(/^"|"$/g, '');
    if (p.includes(' -> ')) p = p.split(' -> ').pop();
    return { status: line.slice(0, 2), path: p };
  });
}

/** Paths outside docs/ that are modified, added or untracked. */
function sourceLeftovers(raw) {
  return parsePorcelain(raw).map((e) => e.path).filter((p) => p && !p.startsWith('docs/'));
}

/**
 * The note a relaunched builder reads first. It names the files and asks for a
 * commit, not a redo: the work is already there.
 */
function commitNote(paths, branch) {
  const shown = paths.slice(0, 20).map((p) => `- ${p}`).join('\n');
  const more = paths.length > 20 ? `\n- … and ${paths.length - 20} more` : '';
  return [
    '## YOUR PREVIOUS RUN OF THIS TASK LEFT WORK UNCOMMITTED — FIX THAT FIRST',
    '',
    `The task finished, but these files outside docs/ were still uncommitted${branch ? ` on \`${branch}\`` : ''}:`,
    '',
    shown + more,
    '',
    'QA and the review judge this run by its commits, so to them this work does not exist yet.',
    'Do not redo the task. Check that the work in the tree is what the task needs, finish it only if it is',
    'incomplete, then commit the files that belong to it. Delete scratch files you created. If a file is not',
    'yours, leave it and name it in your feedback. Then POST your feedback as below.',
    '',
    '---',
    '',
  ].join('\n');
}

module.exports = { parsePorcelain, sourceLeftovers, commitNote };
