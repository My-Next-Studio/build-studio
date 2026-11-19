'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// The 45-minute task-overrun escalation is for fine-grained tasks. A monolithic
// run's single task is the whole build; the escalation's "Kill-and-skip" there
// would throw the build away (fazon FAZ-361, 2026-09-28).
test('task wall-clock overrun is not raised for a monolithic run', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'overseer.js'), 'utf8');
  const i = src.indexOf('function detectTaskWallclockOverrun(wf) {');
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf('\n  }\n', i));
  const guard = body.indexOf('if (wf.taskPlan && wf.taskPlan.monolithic) return candidates;');
  assert.ok(guard > 0, 'monolithic guard missing');
  assert.ok(guard < body.indexOf('for (const [idx, ts]'), 'guard must come before the task scan');
});

// A turn that ends with background shells pending is a pause; the feedback
// nudge told a dev agent mid-test-suite its output "looks complete"
// (fazon FAZ-376, 2026-10-05).
test('the forgot-feedback nudge skips agents with background work pending', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'overseer.js'), 'utf8');
  const i = src.indexOf('function detectAgentForgotFeedback(wf) {');
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf('\n  }\n', i));
  const turn = body.indexOf('if (!lastTurnEnded(pane)) return;');
  const guard = body.indexOf('if (hasBackgroundWork(pane)) return;');
  const push = body.indexOf('candidates.push({ agent, stepLabel });');
  assert.ok(turn > 0 && guard > turn && push > guard, 'background-work guard must sit between the turn check and the push');
});

// A usage-limit banner outlived its agent: Claude Code continued on its own
// when the limit reset, the agent reported and its window was reaped, and the
// banner's Nudge typed into a session that no longer existed (phoclub,
// 2026-11-19).
const { agentEscalationStale } = require('./overseer');

const nudge = (extra = {}) => ({ symptom: 'usage-limit-t1', action: 'nudge-agent', actionTarget: 't1', ...extra });
const taskWf = (agent, status = 'running') => ({ steps: {}, taskExecution: { taskStates: { 0: { status, agents: [agent] } } } });

test('an agent banner stays while its agent is still running', () => {
  const wf = taskWf({ window: 't1', status: 'running', startedAt: 'a' });
  assert.equal(agentEscalationStale(wf, nudge({ actionAgentStartedAt: 'a' })), false);
  assert.equal(agentEscalationStale(wf, nudge()), false, 'an older banner without a start time matches by window');
});

test('an agent banner is stale once its agent has reported, errored or gone', () => {
  assert.equal(agentEscalationStale(taskWf({ window: 't1', status: 'running', feedback: '**All issues addressed:** yes' }), nudge()), true);
  assert.equal(agentEscalationStale(taskWf({ window: 't1', status: 'error' }, 'error'), nudge()), true);
  assert.equal(agentEscalationStale({ steps: {}, taskExecution: { taskStates: { 0: { status: 'pending', agents: [] } } } }, nudge()), true);
});

test('a relaunched task reusing the window does not keep the old agent banner up', () => {
  const wf = taskWf({ window: 't1', status: 'running', startedAt: 'b' });
  assert.equal(agentEscalationStale(wf, nudge({ actionAgentStartedAt: 'a' })), true);
});

test('a step agent counts as well as a task agent', () => {
  const wf = { steps: { reviewing: { status: 'running', agents: [{ window: 't1', status: 'running' }] } } };
  assert.equal(agentEscalationStale(wf, nudge()), false);
  wf.steps.reviewing.status = 'done';
  assert.equal(agentEscalationStale(wf, nudge()), true);
});

test('only banners that name an agent are ever stale', () => {
  assert.equal(agentEscalationStale(taskWf({ window: 't1', status: 'error' }), { symptom: 'agent-stall', description: 'x' }), false);
  assert.equal(agentEscalationStale(taskWf({ window: 't1', status: 'error' }), null), false);
  assert.equal(agentEscalationStale(taskWf({ window: 't1', status: 'error' }), { action: 'task-overrun', actionTarget: 't1' }), true);
});

test('the overseer clears a stale agent banner on its tick and on Nudge', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'overseer.js'), 'utf8');
  assert.match(src, /if \(agentEscalationStale\(wf, overseer\.pendingEscalation\)\) \{/);
  const n = src.indexOf('function nudgeAgent(windowName) {');
  const body = src.slice(n, src.indexOf('\n  }\n', n));
  assert.ok(body.indexOf('agentEscalationStale(wf, pending)') > 0
    && body.indexOf('agentEscalationStale(wf, pending)') < body.indexOf('sendContinueToAgentPane('), 'Nudge must check before typing into the pane');
  assert.equal((src.match(/actionAgentStartedAt: agent\.startedAt \|\| null/g) || []).length, 2);
});
