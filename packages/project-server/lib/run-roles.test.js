'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { implementationRoles, runRoleSummary } = require('./run-roles');

// A monolithic execution run: the builder lives under taskExecution.taskStates,
// NOT under steps.task_execution.agents — that mirror is filled by
// updateStepAgents, which the normal launch path does not call.
const MONOLITHIC = {
  builderRole: 'Android Dev',
  builderRoleSource: 'prd',
  steps: {
    task_execution: { status: 'completed', agents: [] },
    code_review: { agents: [{ role: 'Code Reviewer' }] },
  },
  taskExecution: {
    taskStates: { '0': { agents: [{ role: 'Android Dev', status: 'done' }] } },
  },
};

test('the builder is found where the launcher actually puts it', () => {
  // Reading steps.task_execution.agents alone returns nothing here, which is
  // the bug this test exists to prevent.
  assert.deepEqual(implementationRoles(MONOLITHIC), [{ step: 'task_execution', roles: ['Android Dev'] }]);
});

test('review and QA roles are not implementation lenses', () => {
  const roles = implementationRoles(MONOLITHIC).flatMap(s => s.roles);
  assert.ok(!roles.includes('Code Reviewer'), 'a reviewer did not write the code');
});

test('the fix loop is reported separately when it retargets', () => {
  // The fix planner is explicitly told NOT to inherit the builder's role — it
  // routes by the files a fix touches. So this is the normal case, not drift,
  // and it is exactly what a single run-level field would have hidden.
  const wf = {
    ...MONOLITHIC,
    steps: {
      ...MONOLITHIC.steps,
      fix_execution: { agents: [{ role: 'iOS Dev' }] },
    },
  };
  assert.deepEqual(implementationRoles(wf), [
    { step: 'task_execution', roles: ['Android Dev'] },
    { step: 'fix_execution', roles: ['iOS Dev'] },
  ]);
});

test('a step with several agents reports each role once, in launch order', () => {
  const wf = { steps: { fix_execution: { agents: [
    { role: 'iOS Dev' }, { role: 'Frontend Dev' }, { role: 'iOS Dev' },
  ] } } };
  assert.deepEqual(implementationRoles(wf), [{ step: 'fix_execution', roles: ['iOS Dev', 'Frontend Dev'] }]);
});

test('fine-grained runs collect every task role', () => {
  const wf = { taskExecution: { taskStates: {
    '0': { agents: [{ role: 'Backend Dev' }] },
    '1': { agents: [{ role: 'Frontend Dev' }] },
    '2': { agents: [{ role: 'Backend Dev' }] },
  } } };
  assert.deepEqual(implementationRoles(wf), [{ step: 'task_execution', roles: ['Backend Dev', 'Frontend Dev'] }]);
});

test('an empty or absent workflow is an empty list, not a throw', () => {
  assert.deepEqual(implementationRoles(null), []);
  assert.deepEqual(implementationRoles({}), []);
  assert.deepEqual(implementationRoles({ steps: {}, taskExecution: {} }), []);
});

// ── the header summary ───────────────────────────────────────────────────────

test('a run whose fixes stayed on the builder is not divergent', () => {
  const s = runRoleSummary(MONOLITHIC);
  assert.deepEqual(s.ran, ['Android Dev']);
  assert.equal(s.chosen, 'Android Dev');
  assert.equal(s.source, 'prd');
  assert.equal(s.divergent, false);
});

test('a retargeted fix loop marks the run divergent', () => {
  const wf = { ...MONOLITHIC, steps: { ...MONOLITHIC.steps, fix_execution: { agents: [{ role: 'iOS Dev' }] } } };
  const s = runRoleSummary(wf);
  assert.deepEqual(s.ran, ['Android Dev', 'iOS Dev']);
  assert.equal(s.divergent, true);
});

test('a single role that is not the chosen one is divergent too', () => {
  // The case worth catching: the run was started as one thing and built as
  // another. Only reachable through a relaunch or a hand-edited plan, but it is
  // precisely the question this summary exists to answer.
  const wf = {
    builderRole: 'Android Dev',
    taskExecution: { taskStates: { '0': { agents: [{ role: 'iOS Dev' }] } } },
  };
  assert.equal(runRoleSummary(wf).divergent, true);
});

test('a run that has launched nothing yet is not divergent', () => {
  // Nothing has run, so there is nothing to disagree with the choice — flagging
  // it would put a warning on every freshly started run.
  const s = runRoleSummary({ builderRole: 'Android Dev', steps: { task_execution: { agents: [] } } });
  assert.deepEqual(s.ran, []);
  assert.equal(s.divergent, false);
});

test('a run with no chosen role reports what ran without claiming a choice', () => {
  const s = runRoleSummary({ taskExecution: { taskStates: { '0': { agents: [{ role: 'iOS Dev' }] } } } });
  assert.equal(s.chosen, null);
  assert.deepEqual(s.ran, ['iOS Dev']);
  assert.equal(s.divergent, false, 'the project default is not a disagreement');
});
