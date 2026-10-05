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
 * Blocking findings reported alongside the marker, summed across agents.
 *
 * A partial run is still a run: the instructions tell the agent to report every
 * check that DID run as normal. So a report can carry both a check that could
 * not execute AND a real defect from one that did. The marker must not hide the
 * defect. Seen live 2026-09-30: QA reported a CLS regression against main as
 * `**Blocking:** 1`, plus a font check that could not run for a missing Python
 * module, and the run stalled with the regression never sent to a developer.
 *
 * @param {string} feedback
 * @returns {number}
 */
function blockingCount(feedback) {
  let total = 0;
  for (const m of String(feedback || '').matchAll(/\*\*Blocking:\*\*\s*(\d+)/gi)) total += parseInt(m[1], 10);
  return total;
}

/**
 * Does this report leave the run waiting for the owner?
 *
 * Only when a check could not run AND nothing else decides the step: no
 * blocking defect (those go to the fix loop) and no certified clean verdict.
 * `**Approved:** yes` + `**Blocking:** 0` means the agent triaged the unrun
 * check as non-blocking, and the engine honours that verdict elsewhere
 * (honor_clean_approval). Holding it anyway stalled a clean launch-studio run
 * whose QA had covered the unrun screenshot by another route (2026-10-01).
 *
 * @param {string} feedback
 * @returns {{blocked: true, reason: string} | null}
 */
function waitsForOwner(feedback) {
  const blocked = parseGateBlocked(feedback);
  if (!blocked || blockingCount(feedback) > 0) return null;
  const fb = String(feedback || '');
  const cleanApproval = /\*\*Approved:\*\*\s*yes\b/i.test(fb) && /\*\*Blocking:\*\*\s*0\b/i.test(fb);
  return cleanApproval ? null : blocked;
}

/**
 * The environment-blocked check is not development work. Appended to the fix
 * planner's input when a report carries both, so the planner plans the defects
 * and leaves the environment to the owner.
 */
function plannerNoteForBlockedGate(reason) {
  return `\n\n## A check could not run — this is not a task\n\n`
    + `QA also reported: ${reason}\n\n`
    + 'That is an environment problem, not a defect. Do not plan a task for it. '
    + 'Plan only the blocking findings above. If the environment is still broken when '
    + 'qa_validation re-runs, the run stops and asks the owner to fix it.';
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

/**
 * The same judgement as parseGateBlocked, asked in words, for the decision
 * layer's shadow mode (decide.js). Phrased affirmatively and as one condition,
 * per the model's documented literal reading. The two incidents above are the
 * cases it must get right in BOTH directions: "N/A — suite executed fully" is
 * false, "No browser is available" is true.
 */
const SHADOW_QUESTIONS = {
  // Kept exactly as first asked, so its data stays comparable across the trial.
  could_not_run: {
    type: 'noul',
    instructions: 'At least one check described in this report could not be executed at all, so it produced no result.',
    criteria: {
      true: 'A tool, browser, simulator, service, port or credential was unavailable for a check, or a check timed out or crashed before producing any result.',
      false: 'Every check the report describes ran and produced a result, whether it passed or failed.',
    },
  },
  // The first day showed `could_not_run` mixing two things: a check that was
  // simply not run (a reviewer leaving E2E out of scope: "were not executed
  // during this review") and one the environment stopped ("blocked by the
  // normal-build guard"). Only the second is what the marker is for. Asked as
  // two single-condition statements, per the model's documented literal
  // reading, so the answers can separate them.
  not_executed: {
    type: 'noul',
    instructions: 'The report mentions at least one check, test, suite or verification that was not executed.',
    criteria: {
      true: 'It says a check was skipped, not run, not executed, left out, deferred, pending, or could not run, for any reason.',
      false: 'Every check it mentions was executed and produced a result.',
    },
  },
  // v3 (2026-10-05): v2 listed "timed out" as an environment cause, and the
  // model took it literally. 7 of the 10 disagreements with the regex in
  // 2026-10-03..05 were test failures or flaky timeouts that passed on a
  // rerun: checks that ran and produced a result. "Timed out" now counts only
  // when the environment, not a test, is what timed out.
  environment_cause: {
    type: 'noul',
    instructions: 'The report names an environment problem that stopped a check from producing a result.',
    criteria: {
      true: 'A tool, browser, simulator, device, service, port, credential or build guard was unavailable or refused, so a check never started or was abandoned without a result.',
      false: 'No environment problem is named. A test that ran and failed, timed out, or failed once and passed on a rerun produced a result and does not count. Nor do checks left out by scope or choice, mocked integrations, or work marked pending or manual.',
    },
  },
};

/**
 * Logged on every shadow record, so answers can be compared across wording
 * changes. Bump it whenever any SHADOW_QUESTIONS text changes.
 *   1  2026-10-01  could_not_run only
 *   2  2026-10-03  + not_executed, environment_cause
 *   3  2026-10-05  environment_cause: a test timeout or flaky failure is a result
 * Records written before v3 carry no tag: v1 if they lack environment_cause,
 * else v2.
 */
const SHADOW_QUESTIONS_VERSION = 3;

module.exports = { parseGateBlocked, blockingCount, waitsForOwner, SHADOW_QUESTIONS, SHADOW_QUESTIONS_VERSION, plannerNoteForBlockedGate, GATE_BLOCKED_INSTRUCTIONS, MARKER };
