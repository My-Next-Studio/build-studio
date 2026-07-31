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

  // 2. The fix loop ran past its round cap. Continuing is a judgement call.
  if (stepKey === 'review_cap_reached') {
    const rounds = (step && step.rounds) || wf.round;
    return {
      reason: 'review_cap_reached',
      step: stepKey,
      title: 'Fix loop hit its round cap',
      detail: `The ${(step && step.cap) || 'fix'} loop reached ${rounds} rounds. The engine stops here rather than looping indefinitely.`,
      action: 'Review the outstanding findings, then approve, override, or cancel the run.',
    };
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
