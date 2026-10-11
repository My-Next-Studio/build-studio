'use strict';

// One project's overview block: task agents count as active work, the
// running task is named, the server's own needs-attention reason is carried,
// and the queue's current and next entries ride along.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { projectOverview } = require('./project-overview');

const taskRun = () => ({
  id: 'execution-1', type: 'execution', itemId: 'EX-002', input: 'EX-002', currentStep: 'task_execution', round: 1,
  updatedAt: '2026-10-11T08:00:00.000Z',
  // The step's own agent list is the empty mirror; the agents are on the task.
  steps: { task_execution: { status: 'running', agents: [] } },
  taskPlan: { tasks: [{ name: 'Implement EX-002 end-to-end' }] },
  taskExecution: { taskStates: { 0: { status: 'running', startedAt: '2026-10-11T08:05:00.000Z',
    agents: [{ role: 'Fullstack Dev', status: 'running', cli: 'claude', window: 'build', startedAt: '2026-10-11T08:05:00.000Z' }] } } },
});

test('task agents are active work, and the running task is named', () => {
  const o = projectOverview({ name: 'p', wf: taskRun(), queue: null, draft: null, lastCommit: null });
  assert.equal(o.work.kind, 'workflow');
  assert.deepEqual(o.work.agents.map((a) => a.role), ['Fullstack Dev']);
  assert.equal(o.work.task.name, 'Implement EX-002 end-to-end');
  assert.equal(o.work.task.of, 1);
  assert.equal(o.progress.lastActivity, '2026-10-11T08:05:00.000Z');
  assert.equal(o.needsOwner, null);
});

test('the queue rides along: current, next with its readiness, and the few after it', () => {
  const wf = taskRun();
  const queue = {
    current: { id: 'c', item: 'EX-002', run: { kind: 'workflow', id: wf.id }, status: { state: 'running' } },
    pending: ['EX-003', 'EX-004', 'EX-005', 'EX-006', 'EX-007'].map((item, i) => ({ id: `e${i}`, item, itemInfo: { title: item } })),
    next: { entryId: 'e0', ready: false, reason: 'workflow already active' },
  };
  const o = projectOverview({ name: 'p', wf, queue, draft: null, lastCommit: { sha: 'abc', at: 'x', subject: 's' } });
  assert.equal(o.work.fromQueue, true);
  assert.equal(o.queue.next.reason, 'workflow already active');
  assert.deepEqual(o.queue.following.map((e) => e.item), ['EX-004', 'EX-005', 'EX-006']);
  assert.equal(o.queue.pendingCount, 5);
  assert.equal(o.progress.lastCommit.sha, 'abc');
});

test('no run, but a draft agent running, is work too', () => {
  const o = projectOverview({ name: 'p', wf: null, queue: null, draft: { agentRunning: true, session: { lastItemId: 'EX-009' } } });
  assert.equal(o.work.kind, 'draft');
  assert.equal(o.work.item, 'EX-009');
});

test('nothing running reads as no work, live', () => {
  const o = projectOverview({ name: 'p', wf: null, queue: null, draft: { agentRunning: false } });
  assert.equal(o.work, null);
  assert.equal(o.source, 'live');
});
