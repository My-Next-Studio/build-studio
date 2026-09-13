'use strict';

/**
 * "The gate could not run" — a signal distinct from "the gate ran and failed".
 *
 * A verification step reports one verdict: `**Approved:** no` plus a blocking
 * count. That single channel carried two unrelated conditions:
 *
 *   1. the gate RAN and the code failed it  → a defect, route to the fix loop;
 *   2. the gate COULD NOT RUN               → an environment problem, and no
 *      developer can fix it.
 *
 * Downstream they were indistinguishable, so (2) entered the fix pipeline as
 * work nobody could complete. Every instance cost a full loop before anyone
 * noticed: a QA agent that could not reach a browser filed "No browser is
 * available" as BLOCKING and the fix planner aimed a task at the project; a QA
 * agent pointed at an invented dev-server port filed the connection refusal the
 * same way. In both cases the code was fine and the run could not close.
 *
 * The remedy is a separate marker the agent writes INSTEAD of a blocking
 * verdict, which the engine routes to the owner rather than to a developer.
 *
 * Deliberately narrow. This is not "the gate found nothing"; it is "the gate did
 * not execute". An agent that ran the tests and saw failures must still report
 * them the normal way — that is the case the fix loop exists for.
 */

/** The exact marker agents are told to emit. Kept strict so prose cannot trip it. */
const MARKER = /^\s*\*\*Gate could not run:\*\*\s*(.+)$/im;

/**
 * An explicit "nothing blocked" written into the marker line.
 *
 * Agents treat the marker as a FIELD TO FILL IN rather than a line to omit, and
 * fill it with a negative. Seen live 2026-09-13: a QA agent reported
 * `**Tests passed:** 664/665`, `**Blocking:** 1` — a clean run with a real
 * defect, exactly what the fix loop is for — and alongside it
 * `**Gate could not run:** N/A — suite executed fully; no environment blockers.`
 * Any non-empty text counted as a blocker, so the run could not advance, and the
 * message told the owner to fix an environment the agent had just certified as
 * fine.
 *
 * Matching is deliberately tight, because the failure direction here is
 * expensive in both directions:
 *
 *  - too strict and a false block stalls a healthy run (the bug above);
 *  - too loose and a REAL blocker gets silently swallowed, which is worse —
 *    the run proceeds into a fix loop against an environment that is broken.
 *
 * So: the whole reason must BE a negative token, or begin with one followed by a
 * separator. A bare `no` counts only when it stands alone — `no browser is
 * available` is a real blocker and must keep blocking, which is why `no` is
 * absent from the prefix list.
 */
const NEGATIVE_WHOLE = /^(n\/?a|none|no|nothing|null|-{1,2}|—|–|\.)$/i;
const NEGATIVE_PREFIX = /^(n\/?a|none|nothing)\s*[-—–:;,.]/i;

function isExplicitNegative(reason) {
  const bare = reason.replace(/[.\s]+$/, '').trim();
  return NEGATIVE_WHOLE.test(bare) || NEGATIVE_PREFIX.test(bare);
}

/**
 * Did the agent report that the gate could not execute?
 *
 * @param {string} feedback
 * @returns {{blocked: true, reason: string} | null}
 */
function parseGateBlocked(feedback) {
  const m = MARKER.exec(String(feedback || ''));
  if (!m) return null;
  const reason = m[1].trim();
  if (!reason) return null;
  // The agent wrote the line but said nothing blocked. Treat that as the absent
  // line it was meant to be, rather than as a blocker with a nonsense reason.
  if (isExplicitNegative(reason)) return null;
  return { blocked: true, reason };
}

/**
 * The instruction block telling a gate agent when to use the marker.
 *
 * Two things it has to get right, both learned from real failures:
 *
 *  - a missing capability is NOT a finding. An agent that reports "no browser
 *    is available" as a defect sends a developer after an environment;
 *  - the marker must not become an escape hatch from real failures. It is for
 *    "could not execute", never for "executed and I did not like the result".
 */
const GATE_BLOCKED_INSTRUCTIONS = `

## IF A CHECK CANNOT RUN AT ALL — USE THIS, NOT A BLOCKING FINDING

A tool that is missing, a service that is unreachable, a credential that expired,
a port nobody is serving: none of these are defects in the code, and reporting
them as \`**Approved:** no\` sends a developer to fix something no developer can
fix. That has happened, and it cost a full fix round each time.

When a check cannot EXECUTE, report it on its own line, exactly:

\`**Gate could not run:** <what could not execute, and the exact error>\`

Include the command you ran and the verbatim error. Report every check that DID
run as normal — a partial run is useful, and its results still count.

**If every check ran, OMIT THIS LINE ENTIRELY.** It is not a field to fill in.
Do not write \`N/A\`, \`none\`, or "no blockers" — the line's PRESENCE is the
signal. Writing a negative into it has stalled a run that was otherwise ready to
advance.

**This is not for a check that ran and failed.** If the tests executed and
something is broken, that is an ordinary blocking finding and belongs in the fix
loop. Use this marker only when the check never got to produce a result.`;

module.exports = { parseGateBlocked, GATE_BLOCKED_INSTRUCTIONS, MARKER };
