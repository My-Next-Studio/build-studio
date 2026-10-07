'use strict';

/**
 * Keep a record of every agent a run launched, not only the ones still on it.
 *
 * A step that runs again replaces its agents: round 2's reviewers take round
 * 1's place in `wf.steps[step].agents`. The scorecard is written once, at
 * completion, from whatever agents the run still holds, so every round but the
 * last was lost. Its findings, its tokens and its time went with it. Measured
 * 2026-10-06: in one project, 27 of 32 runs with fix rounds recorded no findings
 * at all, because the round whose findings sent the work back was gone and the
 * final, clean round read 0 / 0 / 0.
 *
 * Steps are re-launched from many places, so this does not hook any of them.
 * It runs where they all meet — saving the workflow — and compares the agents
 * in the previous save with the new one. An agent that was there and is not
 * now has been replaced, and a slim copy of it goes to `wf.agentHistory`.
 */

const { severityFromFeedback } = require('./agent-scorecard');

/** Identity of one launched agent: the same window can be reused, a start time cannot. */
function agentKey(step, a) {
  return `${step}|${a.window || a.role}|${a.startedAt || ''}`;
}

/** Every launched agent in a workflow, with the step it belongs to. */
function launchedAgents(wf) {
  const out = [];
  for (const [step, st] of Object.entries((wf && wf.steps) || {})) {
    for (const a of (st && st.agents) || []) if (a && a.role && a.startedAt) out.push({ step, a });
  }
  for (const ts of Object.values(((wf && wf.taskExecution) || {}).taskStates || {})) {
    for (const a of (ts && ts.agents) || []) if (a && a.role && a.startedAt) out.push({ step: 'task_execution', a });
  }
  return out;
}

/**
 * The fields the scorecard reads, and nothing else: an agent record also holds
 * its full prompt and injected learnings, and keeping those for every round
 * would grow the state file by tens of kilobytes per round.
 */
function slim(step, a) {
  return {
    step,
    role: a.role,
    window: a.window || null,
    taskIndex: a.taskIndex,
    cli: a.cli || null,
    model: a.model || null,
    status: a.status || null,
    startedAt: a.startedAt || null,
    completedAt: a.completedAt || null,
    tokenUsage: a.tokenUsage || null,
    _severity: severityFromFeedback(a.feedback),
  };
}

/**
 * Archive into `next.agentHistory` every agent `prev` held that `next` no
 * longer does. Mutates `next`; returns how many were archived.
 *
 * Only within one run: a save of a different workflow is a new run, not a
 * replacement. An agent already archived, or still present, is never archived
 * twice — so a stale copy of the workflow being saved over a newer one cannot
 * make a live agent count twice.
 */
function archiveReplacedAgents(prev, next) {
  if (!prev || !next || !prev.id || prev.id !== next.id) return 0;
  const present = new Set(launchedAgents(next).map(({ step, a }) => agentKey(step, a)));
  const history = Array.isArray(next.agentHistory) ? next.agentHistory : [];
  for (const h of history) present.add(agentKey(h.step, h));
  let n = 0;
  for (const { step, a } of launchedAgents(prev)) {
    const key = agentKey(step, a);
    if (present.has(key)) continue;
    history.push(slim(step, a));
    present.add(key);
    n += 1;
  }
  if (n) next.agentHistory = history;
  return n;
}

module.exports = { agentKey, launchedAgents, archiveReplacedAgents };
