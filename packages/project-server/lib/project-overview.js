'use strict';

const { agentsOfStep, deriveNeedsAttention } = require('./needs-attention');

/**
 * One project's block in the cross-project overview
 * (docs/plans/work-queue-and-remote-overview.md › The overview): what is
 * running, its agents and task, evidence of recent progress, what needs the
 * owner, and the queue's current and next entries. Built from state already
 * read; it reads and writes nothing itself.
 */

const ACTIVE = new Set(['running', 'pending', 'starting']);

/** The agents working on the current step, task agents included. */
function activeAgents(wf) {
  if (!wf || !wf.currentStep || !wf.steps) return [];
  return agentsOfStep(wf, wf.currentStep, wf.steps[wf.currentStep])
    .filter((a) => a && ACTIVE.has(a.status))
    .map((a) => ({ role: a.role || null, status: a.status, cli: a.cli || null, window: a.window || null, startedAt: a.startedAt || null }));
}

/** The task being executed, when the run is in a task step. */
function currentTask(wf) {
  const tex = wf && wf.taskExecution;
  const tasks = (wf && wf.taskPlan && wf.taskPlan.tasks) || [];
  if (!tex || !tex.taskStates) return null;
  const entry = Object.entries(tex.taskStates).find(([, ts]) => ts && ts.status === 'running');
  if (!entry) return null;
  const task = tasks[Number(entry[0])] || {};
  return { index: Number(entry[0]), of: tasks.length, name: task.name || task.title || null, startedAt: entry[1].startedAt || null };
}

/** The latest moment something visibly happened: an agent start, a task start, a workflow write. */
function lastActivity(wf, agents, task) {
  const times = [wf && wf.updatedAt, task && task.startedAt, ...agents.map((a) => a.startedAt)].filter(Boolean);
  return times.length ? times.sort().at(-1) : null;
}

/**
 * @param {object} p
 * @param {string} p.name           project name
 * @param {object|null} p.wf        the active workflow
 * @param {object} p.queue          the work queue's view (GET /api/work-queue)
 * @param {object|null} p.draft     { session, agentRunning }
 * @param {object|null} p.lastCommit { sha, subject, at }
 * @param {string} p.source         live | persisted
 */
function projectOverview({ name, wf, queue, draft, lastCommit, source = 'live', observedAt = new Date().toISOString() }) {
  const agents = activeAgents(wf);
  const task = currentTask(wf);
  const attention = wf ? deriveNeedsAttention(wf) : null;
  const queued = queue && queue.current && queue.current.run && queue.current.run.kind === 'workflow' && wf && queue.current.run.id === wf.id;
  return {
    name,
    source,
    observedAt,
    work: wf ? {
      kind: 'workflow',
      id: wf.id,
      type: wf.type,
      item: wf.itemId || null,
      input: wf.input || null,
      step: wf.currentStep,
      round: wf.round || 1,
      task,
      agents,
      fromQueue: Boolean(queued),
    } : (draft && draft.agentRunning ? {
      kind: 'draft',
      item: (draft.session && (draft.session.lastItemId || draft.session.openingItemId)) || null,
      agents: [{ role: 'PM', status: 'running' }],
      fromQueue: Boolean(queue && queue.current && queue.current.run && queue.current.run.kind === 'draft'),
    } : null),
    progress: {
      lastActivity: lastActivity(wf, agents, task),
      lastCommit: lastCommit || null,
    },
    needsOwner: attention,
    queue: queue ? {
      current: queue.current || null,
      next: queue.next || null,
      following: (queue.pending || []).slice(1, 4).map((e) => ({ id: e.id, item: e.item, action: e.action || null, title: e.itemInfo ? e.itemInfo.title : null })),
      pendingCount: (queue.pending || []).length,
      // Manual checks the owner saved for later from finished runs.
      savedChecks: (queue.savedChecks || []).map((e) => ({ id: e.id, item: e.item, title: e.itemInfo ? e.itemInfo.title : null, checks: e.checks.map((c) => c.text) })),
    } : null,
  };
}

module.exports = { projectOverview, activeAgents, currentTask };
