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

/** Appended to a fix round's input when the report also carries code defects. */
function fixNoteForOwnerItems(items) {
  return '\n\n## Waiting on the owner — these are not tasks\n\n'
    + 'The review also reported:\n'
    + items.map((item) => `- ${item}`).join('\n')
    + '\n\nOnly the owner can close these. Do not plan or attempt them, and do not '
    + 'fake the approval they wait on. Fix only the blocking findings above.';
}

/** The instruction block telling a reviewer when to use the marker. */
const AWAITING_OWNER_INSTRUCTIONS = `

## IF A FINDING CAN ONLY BE CLOSED BY THE OWNER — USE THIS, NOT A BLOCKING FINDING

Some unmet acceptance criteria are not code: they wait on the owner to approve,
sign off or decide something (study queries to approve, a legal notice to sign
off, a paid run only the owner may start, a choice between options). A developer
cannot close them, so counting them as blocking sends a fix round that changes
nothing, and the next round finds the same thing.

For each such finding, write a line, exactly:

\`**Awaiting owner:** <what the owner has to do, and the AC or finding it closes>\`

Do NOT count it in \`**Blocking:**\`, which counts only defects a developer can
fix. If the change cannot be accepted until the owner acts, keep
\`**Approved:** no\`: the run then stops and waits for the owner instead of
looping.

**This is not a way to defer work.** If an agent could do it (run a check,
reproduce a result, write the missing code or document), it is a blocking
finding. Use the line only for what genuinely needs the owner's decision or
authority. If nothing waits on the owner, OMIT THE LINE ENTIRELY.`;

module.exports = { parseAwaitingOwner, holdsForOwner, fixNoteForOwnerItems, AWAITING_OWNER_INSTRUCTIONS, MARKER };
