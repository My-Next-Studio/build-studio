'use strict';

const { execFileSync } = require('child_process');

/**
 * A QA re-validation round after a fix round that changed nothing.
 *
 * Each re-validation round re-runs the full suite, the build, the gates and
 * the visual smoke, on the reasoning that the fix may have broken something.
 * When the fix round made no change at all — the builder decided the open
 * finding can't be fixed in code, e.g. it waits on an owner approval — every
 * one of those checks gives the same answer again. fazon's go-live run
 * started a fifth round's 40-minute suite on exactly that (2026-10-10): round
 * 4's fix had made no commit.
 *
 * So the server records which commit each QA round tested and the report it
 * produced (`wf.lastQaReport`), and the next round's prompt checks whether
 * anything has changed since. If nothing has, QA carries the counts forward
 * and re-runs only the checks behind the open findings.
 */

const REPORT_MAX_CHARS = 12000;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function headOf(cwd) {
  try { return git(cwd, ['rev-parse', 'HEAD']); } catch (_) { return null; }
}

/**
 * The last QA round's record when the code it tested is still what's checked
 * out: no commit since, and no uncommitted change to a tracked file (QA's own
 * evidence files are untracked). Null when anything changed, when there is no
 * record, or on any git error — a full re-validation is always the fallback.
 */
function unchangedSinceLastQa(cwd, lastQaReport) {
  if (!lastQaReport || !lastQaReport.head || !String(lastQaReport.feedback || '').trim()) return null;
  try {
    if (git(cwd, ['diff', '--name-only', lastQaReport.head, 'HEAD'])) return null;
    if (git(cwd, ['status', '--porcelain', '--untracked-files=no'])) return null;
  } catch (_) {
    return null;
  }
  return lastQaReport;
}

/** The prompt section for a round whose code is unchanged since `last`. */
function unchangedRoundSection({ round, last, fixFeedback }) {
  const prev = last.round || round - 1;
  const short = String(last.head).slice(0, 8);
  const report = last.feedback.length > REPORT_MAX_CHARS
    ? `${last.feedback.slice(0, REPORT_MAX_CHARS)}\n\n[… report truncated]`
    : last.feedback;
  return `\n\n## THIS IS RE-VALIDATION (Round ${round}) — NOTHING HAS CHANGED SINCE ROUND ${prev}

Round ${prev}'s fix made no change to the code: \`git diff ${short} HEAD\` is empty and no tracked file has an uncommitted change. Every check round ${prev} ran would give the same result again, so **this round does NOT re-run the full suite, the build, the gates or the visual smoke.** This section replaces the instructions below to run the test suite first and to re-do the visual smoke.

1. **Confirm it yourself:** \`git diff --stat ${last.head} HEAD\` and \`git status --short --untracked-files=no\` both print nothing. If either prints anything, ignore this section and re-validate in full, as the steps below describe.
2. **Carry round ${prev}'s test counts forward.** Copy its \`**Tests passed:**\` line (or the runner's \`N passed\` / \`N failed\` lines) into your report, marked \`(carried from round ${prev} at ${short}; no code change since)\`. The approval gate reads them.
3. **Re-run only the checks behind round ${prev}'s open findings** — the command each finding cites — and report their fresh output. Nothing else.
4. **Re-state each finding that is still open.** If one cannot be closed by a code change (it waits on an owner approval, a sign-off, a deploy, or anything else outside the repository), put it on an \`**Awaiting owner:**\` line naming what it waits on, and do not count it in \`**Blocking:**\`: the run then waits for the owner instead of starting another fix round.

### Round ${prev}'s QA report (tested at ${short}):
${report}${fixFeedback ? `\n\n### Round ${prev} fix report (context only):\n${fixFeedback}` : ''}`;
}

module.exports = { headOf, unchangedSinceLastQa, unchangedRoundSection, REPORT_MAX_CHARS };
