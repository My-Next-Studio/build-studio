'use strict';

/**
 * Relaunch ONE agent of a step, leaving the others alone.
 *
 * "Relaunch step" resets the whole step, so one failed reviewer cost the five
 * that had already reported: their reviews were discarded and redone (run-studio
 * RS-043, 2026-10-25: a codex QA reviewer died on a rate limit after Brand,
 * Marketing, UX, Architect and Security had all posted). This rebuilds the one
 * agent from the spec it was launched with.
 *
 * Pure: the tmux and launch side lives in api/workflow.js.
 */

/**
 * The fields launchWorkflowAgents reads from an agent spec. Everything else on
 * a stored agent was written by the launch or by the watchdog since (session
 * ids, error text, nudge timestamps, limit blocks), and carrying any of it over
 * would make the new agent inherit the old one's history.
 */
const SPEC_FIELDS = ['role', 'window', 'reportFeedback', 'instruction', 'historyOverride', 'taskIndex', 'branch', 'goalCondition'];

/** Agents in these states can be relaunched; a 'done' one has already reported. */
const RELAUNCHABLE = new Set(['error', 'running', 'pending']);

/**
 * Find the agent to relaunch in the current step.
 *
 * @param {object} wf
 * @param {{role?: string, window?: string}} which  role, and window to tell apart two agents of one role
 * @returns {{index: number, agent: object} | {error: string}}
 */
function findRelaunchable(wf, { role, window } = {}) {
  if (!wf) return { error: 'no active workflow' };
  if (!role) return { error: 'role is required' };
  const stepKey = wf.currentStep;
  // Task agents live on wf.taskExecution and have their own relaunch; the
  // step's agent list is only a mirror of them.
  if (stepKey === 'task_execution' && wf.taskExecution) {
    return { error: 'task_execution agents are relaunched per task (relaunch_task)' };
  }
  const step = wf.steps && wf.steps[stepKey];
  if (!step || !Array.isArray(step.agents)) return { error: `step ${stepKey} has no agents` };
  if (['completed', 'skipped'].includes(step.status)) return { error: `step ${stepKey} is already ${step.status}` };
  const matches = step.agents
    .map((agent, index) => ({ agent, index }))
    .filter(({ agent }) => agent.role === role && (!window || agent.window === window));
  if (matches.length === 0) return { error: `no ${role} agent in ${stepKey}` };
  if (matches.length > 1) return { error: `${matches.length} ${role} agents in ${stepKey}; name the window` };
  const { agent, index } = matches[0];
  if (!RELAUNCHABLE.has(agent.status)) {
    return { error: `${role} is ${agent.status}${agent.status === 'done' ? ' and has reported' : ''}; only a failed, stuck or pending agent is relaunched` };
  }
  if (!agent.instruction) return { error: `${role} has no stored instruction to relaunch from` };
  return { index, agent };
}

/**
 * The spec to hand launchWorkflowAgents, rebuilt from a stored agent.
 *
 * The stored window carries the round suffix the launcher added (`qa-r2`), and
 * the launcher adds it again, so it is taken off here.
 */
function relaunchSpec(agent, round = 1) {
  const spec = { status: 'pending', feedback: null };
  for (const k of SPEC_FIELDS) if (agent[k] !== undefined) spec[k] = agent[k];
  if (spec.window && round > 1) spec.window = spec.window.replace(new RegExp(`-r${round}$`), '');
  return spec;
}

module.exports = { findRelaunchable, relaunchSpec, SPEC_FIELDS };
