'use strict';

/**
 * Which role actually implemented each part of a run.
 *
 * `wf.builderRole` answers "what was chosen at start", and that is NOT the same
 * question. A run has more than one implementation lens by design:
 *
 *   - `task_execution` builds under the builder role (picked, or named by the
 *     PRD, or `roles.execution[0]`).
 *   - `fix_execution` derives its own role from the FIX PLANNER's output, and
 *     the fix-planner prompt explicitly says *"Do not default to whichever role
 *     ran the original task_execution"* — it routes by the files a fix will
 *     touch. A cross-cutting fix genuinely belongs to the role that owns those
 *     files, so this is correct behaviour, not drift.
 *
 * So recording one role per run is a half-truth: it names the builder and
 * silently implies the fixes shared its lens. This reports what ran, per step,
 * which is what "which lens produced this code?" actually needs.
 *
 * Derived, never stored. The agents already carry their roles; a second copy
 * would be one more thing that can disagree with reality.
 */

/** Steps whose agents write production code. Review/QA roles are not lenses. */
const IMPLEMENTATION_STEPS = ['task_execution', 'fix_execution'];

/**
 * Every implementation role that ran, grouped by step and in step order.
 *
 * `task_execution`'s agents live in TWO places: `wf.taskExecution.taskStates[i].agents`
 * is where the launcher actually puts them, and `wf.steps.task_execution.agents`
 * is a mirror that only `updateStepAgents` fills — routinely empty mid-run.
 * Reading one and not the other is how a task_execution role goes missing.
 *
 * @param {object} wf
 * @returns {{step: string, roles: string[]}[]}
 */
function implementationRoles(wf) {
  if (!wf) return [];
  const out = [];
  for (const step of IMPLEMENTATION_STEPS) {
    const roles = [];
    const push = (r) => { if (r && !roles.includes(r)) roles.push(r); };
    for (const a of ((wf.steps || {})[step] || {}).agents || []) push(a && a.role);
    if (step === 'task_execution') {
      for (const ts of Object.values((wf.taskExecution || {}).taskStates || {})) {
        for (const a of (ts.agents || [])) push(a && a.role);
      }
    }
    if (roles.length) out.push({ step, roles });
  }
  return out;
}

/**
 * A one-line answer for the run header.
 *
 * `chosen` is what was selected at start (may be absent — that means the
 * project default). `ran` is what actually did the work. `divergent` is the
 * flag worth showing: it means the fix loop retargeted, which is expected but
 * is exactly the thing a reader would otherwise never learn.
 *
 * @returns {{chosen: string|null, source: string|null, ran: string[], divergent: boolean}}
 */
function runRoleSummary(wf) {
  const perStep = implementationRoles(wf);
  const ran = [];
  for (const s of perStep) for (const r of s.roles) if (!ran.includes(r)) ran.push(r);
  const chosen = (wf && wf.builderRole) || null;
  // Divergent when more than one role implemented, or when the single role that
  // ran is not the one chosen. A run that has not launched anything yet is not
  // divergent — there is nothing to disagree with.
  const divergent = ran.length > 1 || (!!chosen && ran.length === 1 && ran[0] !== chosen);
  return {
    chosen,
    source: (wf && wf.builderRoleSource) || null,
    ran,
    divergent,
    perStep,
  };
}

module.exports = { implementationRoles, runRoleSummary, IMPLEMENTATION_STEPS };
