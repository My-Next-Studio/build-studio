'use strict';

/**
 * "Can this workflow proceed without a human, and if not, why?"
 *
 * The engine already halts correctly in half a dozen places, but each one
 * records itself differently — `step.autoAdvanceError`, `step.status ===
 * 'blocked'`, a `review_cap_reached` step, a manual gate, a completed run still
 * holding the slot. Nothing named the *condition*, so every consumer
 * (auto-advance, the hub, the Backlog Start button) re-derived it from a
 * different subset and disagreed.
 *
 * This is the one answer. It is DERIVED, never stored: a stored flag goes stale
 * the moment a step advances, and a stale "needs you" is worse than none.
 *
 * Returns null when the workflow can proceed on its own, otherwise:
 *   { reason, step, title, detail, action }
 *
 * `reason` is a stable machine key; `title` and `detail` are for humans; and
 * `action` says what actually clears it. Every case here is waiting on a
 * PERSON — nothing in this list resolves itself with time.
 */

/** Gates that exist to stop for a human, regardless of anything going wrong. */
const HUMAN_GATES = {
  device_testing: 'Someone has to exercise the build on a device.',
  owner_consultations: 'The owner reviews the PM output and provides notes.',
  demo_review: 'The owner watches the demo and approves it.',
};

function currentStepOf(wf) {
  if (!wf || !wf.currentStep || !wf.steps) return null;
  return wf.steps[wf.currentStep] || null;
}

/**
 * The agents actually on the current step.
 *
 * `steps.task_execution.agents` is only a mirror of
 * `taskExecution.taskStates[i].agents`, refreshed by updateStepAgents — which
 * the normal launch path does not call, so the mirror is routinely empty while
 * a task is running. Fall back to the source rather than concluding a step has
 * no agents.
 */
function agentsOfStep(wf, stepKey, step) {
  const mirrored = (step && step.agents) || [];
  if (mirrored.length > 0) return mirrored;
  if (stepKey !== 'task_execution') return [];
  const states = (wf.taskExecution && wf.taskExecution.taskStates) || {};
  return Object.values(states).flatMap((ts) => (ts && ts.agents) || []);
}

/**
 * @param {object|null} wf  workflow state, or null when no run is active
 * @returns {null|{reason:string, step:string|null, title:string, detail:string, action:string}}
 */
function deriveNeedsAttention(wf) {
  if (!wf) return null;
  const stepKey = wf.currentStep || null;
  const step = currentStepOf(wf);

  // Ordered most-specific first: a completed run and a capped loop are both
  // terminal states that a generic "blocked" check would describe far less
  // usefully.

  // 1. Finished, but still occupying the single workflow slot. Nothing is
  //    running, yet nothing else can start — which reads as "busy" to every
  //    consumer that only checks whether a workflow object exists.
  if (stepKey === 'completed') {
    return {
      reason: 'completed_not_finished',
      step: stepKey,
      title: 'Run finished — waiting to be closed',
      detail: `The ${wf.type || 'workflow'} run for ${wf.input || 'this item'} completed. It still holds the project's workflow slot, so nothing else can start here.`,
      action: 'Click Done on the Workflow tab to close it out.',
    };
  }

  // 2. A loop ran past its round cap. Continuing is a judgement call, and the
  //    two loops that can reach here offer different choices — a PRD review can
  //    go round again or move on to companion specs, while an execution fix
  //    loop resumes at the step it was called from.
  if (stepKey === 'review_cap_reached') {
    const rounds = (step && step.rounds) || wf.round;
    const isPrdReview = (step && step.cap) === 'review';
    return {
      reason: 'review_cap_reached',
      step: stepKey,
      title: isPrdReview ? 'PRD review hit its round cap' : 'Fix loop hit its round cap',
      detail: isPrdReview
        ? `The review of ${wf.input || 'this item'} reached ${rounds} rounds. Hitting the cap says the loop ran as long as you allowed — not that the PRD is finished or unfinished — so the run stops here rather than deciding for you.`
        : `The ${(step && step.cap) || 'fix'} loop reached ${rounds} rounds. The engine stops here rather than looping indefinitely.`,
      action: isPrdReview
        ? 'Continue to run the next review round as if there were no cap, or stop reviewing and move on to companion specs.'
        : `Continue to send the latest fixes back to ${(step && step.cap) || 'the review'} as if there were no cap, or accept its open findings and move on.`,
    };
  }

  // 2b. An agent that is ALIVE but will never progress on its own — waiting at
  //     a dialog, blocked on an expired login, or finished without posting its
  //     report. The watchdog derives this second axis onto the agent
  //     (agent-stalled.js) and deletes it the moment the agent recovers, so the
  //     presence of `a.stalled` is itself the signal.
  //
  //     This runs BEFORE the dead-step rules below, and deliberately does not
  //     require `status === 'running'`. Both of those were wrong for the case
  //     this rule exists to catch. An agent that stalls by WAITING produces no
  //     log output, so it always trips the 15-minute idle timeout, which stamps
  //     `status = 'error'` — the rule then skipped it, and the dead-step rule
  //     underneath reported "all agents errored with no output, relaunch the
  //     step" about a live agent holding uncommitted work. The diagnosis was
  //     computed correctly, stored on the agent, and never shown to anyone
  //     (2026-08-23). `a.stalled` only exists because the process check said the
  //     agent was alive, so it is the more specific answer wherever both apply.
  // agentsOfStep, not st.agents: a task_execution agent lives on its task
  // state, and the mirror is routinely empty (launch-studio LS-167).
  for (const [key, st] of Object.entries(wf.steps || {})) {
    for (const a of agentsOfStep(wf, key, st)) {
      // 'done' still disqualifies — a flag must not outlive its condition. But
      // 'error' does not: that is the idle timeout's stamp, not a verdict about
      // the process, and it is the state a waiting agent always ends up in.
      if (a && a.stalled && !a.feedback && a.status !== 'done') {
        return {
          reason: a.stalled.reason,
          step: key,
          ...(a.window ? { window: a.window } : {}),
          title: a.stalled.title,
          detail: `${a.role}: ${a.stalled.detail}${a.stalled.question ? `\n\nIt is asking:\n${a.stalled.question}` : ''}`,
          action: a.stalled.action,
        };
      }
    }
  }

  if (step) {
    // 3. Every agent died with no output, or a gate rejected the step past the
    //    retry ceiling. Both stash the explanation in the same place.
    if (step.autoAdvanceError) {
      return {
        reason: 'dead_step',
        step: stepKey,
        title: `${stepKey} cannot advance`,
        detail: String(step.autoAdvanceError),
        action: 'Fix the cause, then relaunch the step — or override if the halt is not warranted.',
      };
    }

    // 3b. Every agent on the step died with nothing to advance on. The
    //     auto-advance tick already stashes this as autoAdvanceError — but only
    //     when auto-advance is ON. With it off, the identical dead step
    //     produced no signal at all, so derive it here too and let both look
    //     the same to every consumer.
    const agents = agentsOfStep(wf, stepKey, step);
    if (agents.length > 0 && agents.every((a) => a.status === 'error' && !a.feedback)) {
      const firstError = agents.map((a) => a.error).find(Boolean);
      return {
        reason: 'dead_step',
        step: stepKey,
        title: `${stepKey} cannot advance`,
        detail: firstError
          ? `All ${agents.length} agent(s) on this step failed. First error: ${firstError}`
          : `All ${agents.length} agent(s) on this step failed with no output.`,
        action: 'Fix the cause, then relaunch the step — or override if the halt is not warranted.',
      };
    }

    // 4. A guardrail blocked the step outright (validation failure, an empty fix
    //    plan against a flagged blocker, a failed precondition).
    // 3a. The run is waiting on the owner, not on a fix: the planner found a
    //     blocking finding only the owner can clear and listed the steps.
    if (step.status === 'blocked' && step.ownerAction && step.ownerAction.text) {
      return {
        reason: 'owner_action',
        step: stepKey,
        title: 'Waiting on you: owner action required',
        detail: `A blocking finding from ${step.ownerAction.sourceStep || 'the review'} can only be cleared by you, so no agent task was planned. What to do:\n\n${step.ownerAction.text}`,
        action: 'Do those steps (or defer them on the record), then approve with an override reason saying which.',
      };
    }
    if (step.status === 'blocked') {
      return {
        reason: 'blocked',
        step: stepKey,
        title: `${stepKey} is blocked`,
        detail: String(step.error || 'The step was blocked by a guardrail and needs a decision.'),
        action: 'Resolve the cause, or advance with an explicit override.',
      };
    }
  }

  // 4a. A verification gate that could not EXECUTE. Distinct from one that ran
  //     and failed: the code is not at fault and no developer can fix it, so it
  //     must reach the owner rather than the fix loop (gate-blocked.js).
  {
    const gb = require('./gate-blocked');
    for (const [key, st] of Object.entries(wf.steps || {})) {
      if (st && st.status === 'completed') continue;
      for (const a of st.agents || []) {
        const hit = a && a.feedback && gb.parseGateBlocked(a.feedback);
        // A report that also carries blocking defects implicates the code: those
        // go to the fix loop, so this is not an environment-only stop.
        if (hit && gb.blockingCount(a.feedback) === 0) {
          return {
            reason: 'gate_blocked',
            step: key,
            title: `${key} could not run a check`,
            detail: `${a.role} reported: ${hit.reason}. The code is not implicated — a check could not execute, so there is nothing for a developer to fix.`,
            action: 'Fix the environment and relaunch the step. If the check is not needed for this change, approve with an override (Force approve on the QA step).',
          };
        }
      }
    }
  }

  // (The alive-but-stuck scan that used to sit here is now rule 2b, above the
  //  dead-step rules it was losing to.)

  // 5. A gate that exists to wait for a person. Not a failure — but the run is
  //    stopped and will stay stopped, which is what a caller needs to know.
  //    demo_review is only a gate when the owner has not opted out of it.
  if (stepKey && Object.prototype.hasOwnProperty.call(HUMAN_GATES, stepKey)) {
    const skipped = stepKey === 'demo_review' && wf.autoAdvanceSkipDemoReview === true;
    if (!skipped && (!step || step.status !== 'completed')) {
      return {
        reason: 'human_gate',
        step: stepKey,
        title: `${stepKey} is waiting for you`,
        detail: HUMAN_GATES[stepKey],
        action: 'Approve or skip the gate on the Workflow tab.',
      };
    }
  }

  return null;
}

module.exports = { deriveNeedsAttention, HUMAN_GATES };
