const { test } = require('node:test');
const assert = require('node:assert');
const { resolveAgentTarget } = require('./terminal');

function stateWith(wf, run) {
  return { loadWorkflow: () => wf || null, loadRun: () => run || null };
}

const WF = {
  sessionName: 'wf-2026-01-01T00-00-00',
  currentStep: 'task_execution',
  steps: {
    prd_review: { agents: [{ role: 'Architect', window: 'architect' }] },
    task_execution: { agents: [{ role: 'QA', window: 'qa-validate' }] },
  },
  taskExecution: {
    taskStates: {
      t1: { agents: [{ role: 'iOS Dev', window: 't1-ios-dev' }] },
    },
  },
};

test('resolves an agent in the current step by window name', () => {
  const t = resolveAgentTarget(stateWith(WF), 'qa-validate');
  assert.deepEqual(t, { sessionName: WF.sessionName, window: 'qa-validate' });
});

test('resolves by role name case-insensitively', () => {
  const t = resolveAgentTarget(stateWith(WF), 'architect');
  assert.deepEqual(t, { sessionName: WF.sessionName, window: 'architect' });
});

test('resolves task-execution agents', () => {
  const t = resolveAgentTarget(stateWith(WF), 't1-ios-dev');
  assert.deepEqual(t, { sessionName: WF.sessionName, window: 't1-ios-dev' });
});

test('falls back to run workers by window or branch', () => {
  const run = { sessionName: 'run-x', workers: [{ branch: 'agent-dev/foo', window: 'w-foo' }] };
  assert.deepEqual(resolveAgentTarget(stateWith(null, run), 'w-foo'),
    { sessionName: 'run-x', window: 'w-foo' });
  assert.deepEqual(resolveAgentTarget(stateWith(null, run), 'agent-dev/foo'),
    { sessionName: 'run-x', window: 'w-foo' });
});

test('returns null for unknown agents and missing state', () => {
  assert.equal(resolveAgentTarget(stateWith(WF), 'nope'), null);
  assert.equal(resolveAgentTarget(stateWith(null, null), 'qa-validate'), null);
  assert.equal(resolveAgentTarget({ loadWorkflow: () => null }, 'qa-validate'), null);
});
