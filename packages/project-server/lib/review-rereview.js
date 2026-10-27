'use strict';

/**
 * Targeted re-review for PRD review rounds after the first.
 *
 * Round 1 should sweep the whole document — that is where the real defects are.
 * Rounds 2+ were doing the same thing again: the instruction was byte-identical
 * every round ("Read the PRD file, then analyze it"), with no diff and no
 * changed-section scoping. The only round-awareness was a rule saying *"after
 * round 2, only raise genuinely new issues"*.
 *
 * That combination is a finding generator, not a review. A round-3 reviewer
 * opens the full PRD, is told the only acceptable output is NEW material, and
 * carries a fresh lens (its role skill) to apply. Observed on a real run: a
 * reviewer reported "round-2 blocker is resolved" and then raised three new
 * findings from a surface no earlier round had touched. It did exactly what it
 * was asked to do.
 *
 * `code_review` already solved this for implementation review — rounds > 1 get
 * "verify each fix actually resolves the issue it claims to fix … do not
 * re-audit code that was already approved in round 1". PRD review never got the
 * same treatment; the asymmetry looks accidental rather than designed.
 *
 * Complements `review-wrapup.js` rather than replacing it. This narrows what a
 * re-review LOOKS at (the cause); wrap-up/closure changes what happens to
 * findings that still surface (the symptom). A run wants both: verification
 * first, and a contract for the residue.
 */

/**
 * The feedback a re-reviewing role actually needs: its OWN prior findings, plus
 * every PM fix report.
 *
 * The default history hands each reviewer all six roles' feedback from the last
 * three rounds. That is the bulk of the prompt, and it invites anchoring — Brand
 * reads Architect's blocking finding before forming its own view. For a targeted
 * re-review the question is narrower: *did the fixes close MY findings?*
 *
 * PM fix reports are always included regardless of role, because they are the
 * claim being verified.
 *
 * **The most recent round is delivered in full.** A flat 1200-char cap used to
 * apply to every entry, which on a measured run gave each reviewer 11-18% of its
 * own prior review: the cut landed on the first finding's TITLE, so the bodies —
 * the things being verified — were gone, along with 80% of the PM fix report
 * claiming to close them. One reviewer responded by running `sed` over its own
 * transcript .jsonl to recover what had been cut (fazon, 2026-08-22).
 *
 * Delivering the latest round whole is also the cheap option, which is what
 * settles it: the biggest observed review plus fix report is ~17k chars against
 * the 30.7k-char PRD a truncated reviewer re-reads instead. Older rounds stay
 * capped — their findings were already adjudicated in the round that followed —
 * so the block does not grow without bound as rounds accumulate.
 *
 * @param {object} wf
 * @param {string} role
 * @param {number} [olderMaxChars] truncation for rounds before the latest
 * @returns {string} markdown block, or '' when there is nothing to show
 */
function roleHistory(wf, role, olderMaxChars = 1200) {
  const all = (wf && wf.feedback) || [];
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');
  const wanted = norm(role);
  const mine = all.filter((f) => norm(f.role) === wanted);
  const fixes = all.filter((f) => f.step === 'pm_fix');
  if (mine.length === 0 && fixes.length === 0) return '';

  // A hard ceiling for the full-text entries too, so one pathological review
  // cannot dominate the prompt. Far above anything observed (~11k).
  const FULL_MAX = 24000;
  const latestRound = Math.max(
    0,
    ...mine.map((f) => Number(f.round) || 0),
    ...fixes.map((f) => Number(f.round) || 0),
  );
  // Say what was cut and why. A silent truncation reads as 'this is all of it',
  // which is how a reviewer ends up verifying a finding it cannot see.
  const clip = (t, full) => {
    const s = String(t || '');
    const limit = full ? FULL_MAX : olderMaxChars;
    if (s.length <= limit) return s;
    return `${s.slice(0, limit)}\n\n… (truncated — ${s.length - limit} more characters from an`
      + ` earlier round; the latest round is shown in full)`;
  };

  let out = `\n\n## YOUR PRIOR FINDINGS AND THE FIXES CLAIMED FOR THEM\n\n`
    + `Only your own findings are listed. Other reviewers' findings are theirs to verify — `
    + `re-litigating them is how a re-review turns back into a fresh sweep.\n`;

  for (const f of mine) {
    const full = (Number(f.round) || 0) === latestRound;
    out += `\n### Round ${f.round} — your review${full ? ' (full text)' : ''}\n${clip(f.feedback, full)}\n`;
  }
  for (const f of fixes) {
    const full = (Number(f.round) || 0) === latestRound;
    out += `\n### Round ${f.round} — PM fix report (the claim you are verifying)${full ? ' (full text)' : ''}\n${clip(f.feedback, full)}\n`;
  }
  return out;
}

/**
 * The targeted re-review contract, replacing the full-sweep instruction body.
 *
 * Deliberately does NOT forbid blocking: an unfixed finding or a regression
 * introduced by a fix must still stop the run. What it forbids is treating the
 * document as unread.
 */
function buildRereviewInstruction(role, skill, prdPath, round, diffBase) {
  // Telling a reviewer "do not re-read untouched sections" without showing it
  // WHAT changed does not work — it opens the document to find out. Measured on
  // a fazon review (2026-08-22): 5 of 6 round-2 reviewers read the full 394-line
  // PRD, and round 2 cost 27% more cache reads and 20% more turns than round 1.
  // By round 3 they had drifted to diff-first on their own and cost halved. This
  // makes that the instruction rather than an accident.
  const diffCmd = diffBase
    ? `git diff ${diffBase} -- ${prdPath}`
    : `git log --oneline -3 -- ${prdPath}   # then diff the previous commit against HEAD`;
  return `You are a ${role} reviewer doing a TARGETED RE-REVIEW. Use your /${skill} skill.

PRD path: ${prdPath}

This is round ${round}. Round 1 swept the whole document; that has happened. Your job now is to
verify that the fixes claimed since your last review actually close the findings YOU raised —
not to audit the document again from a new angle.

## START HERE — THE DELTA, NOT THE DOCUMENT

Run this first. It is the complete set of changes since your last review:

    ${diffCmd}

Work from that diff. Open the PRD only for a section the diff touches or one your own prior
findings name, and read just that range (\`sed -n 'START,ENDp' ${prdPath}\`). Re-reading the whole
document is exactly what this round exists to avoid: it costs a full review and produces findings
about surfaces nobody changed.

## WHAT TO DO

1. Read the diff, then match each of your prior findings below to the change that claims to
   close it.
2. For each one, decide: **CLOSED** (the fix resolves it), **NOT CLOSED** (the fix misses or
   only partly addresses it — say precisely what remains), or **REGRESSED** (the fix broke
   something that previously read correctly).
3. Read only the sections the fixes touched. Do NOT re-read and re-assess sections that no fix
   touched and that you did not previously flag — those were reviewed in round 1 and are
   settled.

## WHAT BLOCKS

- A finding of yours that is **NOT CLOSED** — cite which round it came from.
- A **REGRESSION** introduced by a fix.
- A defect in the changed text that would cause real harm to ship.

## WHAT DOES NOT BLOCK

- Anything you notice by examining a surface no earlier round examined and no fix touched.
  If it is genuinely worth recording, put it under \`### Follow-up proposals\` — it is not a
  reason to withhold approval at this stage.
- Wording, polish or completeness preferences that you did not raise in round 1.

**If every finding of yours is CLOSED, say so and set \`Approved: yes\` with \`Blocking: 0\`.**
That is the expected outcome of a working fix round, not a rubber stamp.

## REVIEW FORMAT — MANDATORY

The owner reads this report for what still needs fixing. Do the verification above for every
prior finding, but do NOT list the ones that are CLOSED: a list of settled findings buries the
open ones, and a "MEDIUM" next to a closed item reads as an open medium. Report only the count.
The Blocking / Medium / Low counts cover the findings below and nothing else.

## Review: ${role}

**Approved:** yes | no
**Blocking:** N  |  **Medium:** N  |  **Low:** N
**Prior findings:** N checked, N closed

### Findings
[Only what needs fixing now: each NOT CLOSED or REGRESSED finding, cited as
\`[round N] <finding> — NOT CLOSED | REGRESSED — <what remains>\`, and any defect in the changed
text. If there are none, write "None." and nothing else here.]

### Action Items
- [ ] [assignee_role] — description
[Only for the findings above. Omit the section when there are none.]`;
}

/**
 * The PRD's current commit sha — the base the NEXT review round diffs against.
 *
 * This lives here, rather than inline at the call site, because the inline
 * version silently did nothing for a week. It called `execFileSync` in a scope
 * that never imported it (every other use in workflow.js does its own local
 * `require('child_process')` first), so it threw `ReferenceError` on every
 * round, in every project — and the caller's `catch (_) {}` swallowed it. The
 * re-review prompt shipped, correctly, in its no-diff form, so nothing looked
 * broken: the block was present, just never carrying a `git diff` line.
 *
 * A module that does its own require cannot fail that way, and can be tested.
 *
 * @returns {string|null} the sha, or null when there is genuinely no base
 *   (no git, PRD never committed, path unknown) — which the prompt handles.
 */
function prdHeadSha(projectRoot, prdPath) {
  if (!projectRoot || !prdPath) return null;
  const { execFileSync } = require('child_process');
  try {
    const sha = execFileSync('git', ['log', '-n', '1', '--format=%H', '--', prdPath],
      { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return sha || null;
  } catch (_) {
    return null; // uncommitted PRD or no git — a real, expected absence
  }
}

module.exports = { roleHistory, buildRereviewInstruction, prdHeadSha };
