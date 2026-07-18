'use strict';

/**
 * Wrap-up mode for final_review rounds past the owner-approved review cap
 * (designed 2026-07-18 from the finance-studio FS-002 run: rounds 1–4 found
 * real implementation defects, but the reviewer's "spec-forward, fresh angle
 * each round" method is an unbounded lens generator — round 5 swept the
 * renderer line-by-line against the UX spec, round 6 swept the test suite
 * against AC test-mandate language. Every round past the cap found NEW,
 * never-recycled material, so the loop was genuinely progressing yet could
 * never converge on approval: final_review had no stopping criterion of its
 * own beyond the owner cancelling).
 *
 * The mode changes the finding CONTRACT for post-cap rounds only: regressions,
 * incomplete fixes, and critical newly-found defects may still block; fresh-
 * lens discoveries must be filed as follow-up proposals (a structured heading
 * the owner turns into backlog items) instead of blocking. Rounds at or under
 * the cap are untouched — early rounds SHOULD sweep with fresh lenses.
 *
 * Opt-out: config `final_review.wrapup_past_cap: false`.
 */

/** Is wrap-up mode active for this round? */
function wrapupActive(round, maxRounds, config) {
  if (config && config.final_review && config.final_review.wrapup_past_cap === false) return false;
  if (!Number.isFinite(round) || !Number.isFinite(maxRounds)) return false;
  return round > maxRounds;
}

/** The instruction block appended to the final_review agent prompt. */
function buildWrapupBlock(round, maxRounds) {
  return `

## WRAP-UP MODE — THIS ROUND IS PAST THE OWNER-APPROVED REVIEW CAP (round ${round}, cap ${maxRounds})

The owner explicitly chose to continue past the round cap. Your job this round is CLOSURE, not fresh discovery — this change has already been through ${maxRounds}+ full review rounds and every previously flagged finding has a landed, verified fix. The bar for BLOCKING changes in this round:

**May still block (Approved: no):**
- A REGRESSION — a fix round broke something that previously worked.
- An INCOMPLETE FIX — a specific previous round's finding whose fix does not actually close it. Cite the round and finding.
- A newly discovered defect causing data loss, security exposure, or corruption that no reasonable owner would knowingly ship.

**Must NOT block — file as follow-up proposals instead:**
- Anything surfaced by sweeping a spec surface, file, or angle no previous round examined. If a finding cites neither a specific previous round's finding nor a specific fix commit, it is follow-up material BY DEFINITION.
- Missing or weak tests for behavior you verified correct by other means.
- Copy, polish, naming, or spec-letter divergences without concrete user-facing harm.

Report the follow-ups under this exact heading so the owner can file them as backlog items:

### Follow-up proposals (file as backlog items)
- [severity] <short title> — <one sentence: what + where (file:line)>

State \`**Mode:** wrap-up (round ${round}, cap ${maxRounds})\` directly under the Approved/Blocking lines.

An **Approved: yes** carrying a rich follow-up list is the DESIGNED good outcome of a wrap-up round — it is not a rubber stamp, and nothing in that list is lost by approving: the owner files every proposal as a tracked backlog item.`;
}

module.exports = { wrapupActive, buildWrapupBlock };
