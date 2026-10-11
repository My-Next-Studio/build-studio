'use strict';

/**
 * "This waits on the owner" — a finding the fix loop can never close.
 *
 * A review reports one verdict: `**Approved:** no` plus a blocking count, and a
 * blocking finding goes back to the developers. Some findings are not code at
 * all: an acceptance criterion that needs the owner to approve study queries,
 * sign off a legal notice, or start a paid run. Counted as blocking, each one
 * bought a fix round that changed nothing, round after round, until the round
 * cap stopped the run. One run went five rounds on two such findings, with the
 * fix agent writing "stop re-cycling the lean fix loop" from round one
 * (launch-studio, 2026-10-11); another went five on a legal sign-off (fazon,
 * 2026-10-10).
 *
 * The remedy mirrors gate-blocked.js: a separate marker the reviewer writes for
 * each such finding INSTEAD of counting it as blocking, which the engine routes
 * to the owner rather than to a developer. Code defects in the same report
 * still go to the fix loop.
 *
 * Narrowed the same day (owner, 2026-10-11): the hold is for a DECISION only
 * the owner can make and the build cannot go on without (which option, whether
 * to spend money). Anything the owner could only VERIFY (look at screens,
 * attach a log, sign off rendering, read and approve generated text) never
 * holds a run and needs no proof: it goes under `### Owner checks`, collected
 * across the run and listed at its end as remaining manual checks, which the
 * owner runs or not. A run had held on exactly that: "attach the screenshot
 * run log and sign off AC-6's visual rendering".
 */

/** The exact marker reviewers are told to emit, one line per finding. */
const MARKER = /^\s*\*\*Awaiting owner:\*\*\s*(.+)$/gim;

// The line written as a field to fill in, with a negative ("N/A", "none"):
// treated as absent, by gate-blocked.js's rule. A bare "no" counts only alone,
// so "No query approvals recorded" still waits on the owner.
const NEGATIVE_WHOLE = /^(n\/?a|none|no|nothing|null|-{1,2}|—|–|\.)$/i;
const NEGATIVE_PREFIX = /^(n\/?a|none|nothing)\s*[-—–:;,.]/i;
const isNegative = (item) => {
  const bare = item.replace(/[.\s]+$/, '').trim();
  return NEGATIVE_WHOLE.test(bare) || NEGATIVE_PREFIX.test(bare);
};

/**
 * What the report says waits on the owner.
 *
 * @param {string} feedback
 * @returns {string[]} one entry per marker line, in order; [] when there is none
 */
function parseAwaitingOwner(feedback) {
  const items = [];
  for (const m of String(feedback || '').matchAll(MARKER)) {
    const item = m[1].trim();
    if (item && !isNegative(item)) items.push(item);
  }
  return items;
}

/**
 * Does this report leave the run waiting for the owner, with nothing for a
 * developer to do? True when it names something awaiting the owner, counts no
 * blocking defect, and is not a certified clean verdict (`**Approved:** yes` +
 * `**Blocking:** 0`, which approves and leaves the owner items informational).
 *
 * @param {string} feedback
 * @param {(feedback: string) => number} blockingCount
 * @returns {string[] | null} the items, or null when the report does not hold
 */
function holdsForOwner(feedback, blockingCount) {
  const items = parseAwaitingOwner(feedback);
  if (!items.length || blockingCount(feedback) > 0) return null;
  const fb = String(feedback || '');
  if (/\*\*Approved:\*\*\s*yes\b/i.test(fb)) return null;
  return items;
}

// `### Owner checks` (or the AC verifier's older `### Owner action items`):
// bullets until the next heading.
const CHECKS_HEADING = /^#{2,4}\s+Owner (?:checks|action items)[ \t]*$/i;

/**
 * The manual checks a report leaves for the owner: optional, never blocking,
 * listed at the end of the run.
 *
 * @param {string} feedback
 * @returns {string[]}
 */
function parseOwnerChecks(feedback) {
  const lines = String(feedback || '').split('\n');
  const out = [];
  let inSection = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) { inSection = CHECKS_HEADING.test(line.trim()); continue; }
    if (!inSection) continue;
    const m = line.match(/^\s*[-*]\s+(?:\[[ x]\]\s+)?(.+?)\s*$/i);
    if (m && !isNegative(m[1])) out.push(m[1]);
  }
  return out;
}

/** Add `checks` from `step` to the run's list, once each. */
function mergeOwnerChecks(existing, checks, step) {
  const list = Array.isArray(existing) ? [...existing] : [];
  for (const text of checks) {
    if (!list.some((c) => c.text === text)) list.push({ text, step });
  }
  return list;
}

/** Appended to a fix round's input when the report also carries code defects. */
function fixNoteForOwnerItems(items) {
  return '\n\n## Waiting on the owner — these are not tasks\n\n'
    + 'The review also reported:\n'
    + items.map((item) => `- ${item}`).join('\n')
    + '\n\nOnly the owner can close these. Do not plan or attempt them, and do not '
    + 'fake the approval they wait on. Fix only the blocking findings above.';
}

/** The instruction block: owner checks (never blocking) and the narrow hold. */
const AWAITING_OWNER_INSTRUCTIONS = `

## WHAT ONLY THE OWNER CAN DO — LIST IT, DON'T BLOCK ON IT

**Owner checks — never blocking.** Something only the owner can verify (look
at screens or a visual rendering, try it on a device or in the packaged app,
run a manual script, read or approve generated text, attach a log or a
screenshot, sign off a criterion) is NOT a finding and does NOT make the
change unapproved. List each one under a \`### Owner checks\` section, one
bullet per check, saying what to look at. The workflow shows them to the owner
at the end of the run as remaining manual checks; the owner runs them or not,
and no proof is ever required. A spec that calls such a check a "gate" or asks
for evidence does not change this: list it, and judge the rest.

**Awaiting owner — rare.** Only when the change cannot be built at all until
the owner makes a product decision the spec left open (which of two options,
whether to spend money on a paid service), write:

\`**Awaiting owner:** <the decision, and what it unblocks>\`

Do not count it in \`**Blocking:**\`, which counts only defects a developer can
fix, and keep \`**Approved:** no\`: the run then stops and waits for the
owner. Never use it for anything the owner would only check or sign off.

If an agent could do it (run a check, reproduce a result, capture a
screenshot, write the missing code or document), it is neither: do it, or
report it as a blocking finding. If nothing is left for the owner, OMIT both.`;

module.exports = { parseAwaitingOwner, holdsForOwner, parseOwnerChecks, mergeOwnerChecks, fixNoteForOwnerItems, AWAITING_OWNER_INSTRUCTIONS, MARKER };
