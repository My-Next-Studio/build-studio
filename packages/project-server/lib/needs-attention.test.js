'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveNeedsAttention } = require('./needs-attention');

const running = () => ({
  type: 'execution', input: 'ls-101', currentStep: 'task_execution', round: 1,
  steps: { task_execution: { status: 'running', agents: [{ role: 'iOS Dev', status: 'running' }] } },
});

test('a healthy running workflow needs nothing', () => {
  assert.equal(deriveNeedsAttention(running()), null);
  assert.equal(deriveNeedsAttention(null), null);
  assert.equal(deriveNeedsAttention({}), null);
});

test('completed-but-unfinished is reported — it holds the slot with nothing running', () => {
  // This is the case every consumer previously read as "busy": no agent is
  // working, yet POST /workflow/start still 409s.
  const wf = { type: 'bugfix', input: 'DR-090', currentStep: 'completed', steps: {} };
  const n = deriveNeedsAttention(wf);
  assert.equal(n.reason, 'completed_not_finished');
  assert.match(n.detail, /DR-090/);
  assert.match(n.detail, /workflow slot/);
  assert.match(n.action, /Done/);
});

test('review cap reports the round count and which loop capped', () => {
  const wf = {
    type: 'execution', input: 'ls-101', currentStep: 'review_cap_reached', round: 8,
    steps: { review_cap_reached: { status: 'blocked', cap: 'final_review', rounds: 8 } },
  };
  const n = deriveNeedsAttention(wf);
  assert.equal(n.reason, 'review_cap_reached');
  assert.match(n.detail, /final_review/);
  assert.match(n.detail, /8 rounds/);
});

test('a dead step surfaces the stashed explanation verbatim', () => {
  const wf = running();
  wf.currentStep = 'code_review';
  wf.steps.code_review = {
    status: 'completed',
    autoAdvanceError: 'all 1 agent(s) errored with no output — halted instead of advancing past a dead step',
    agents: [{ role: 'Code Reviewer', status: 'error' }],
  };
  const n = deriveNeedsAttention(wf);
  assert.equal(n.reason, 'dead_step');
  assert.equal(n.step, 'code_review');
  assert.match(n.detail, /errored with no output/);
});

test('a blocked step reports its own error rather than a generic message', () => {
  const wf = running();
  wf.currentStep = 'fix_plan';
  wf.steps.fix_plan = { status: 'blocked', error: 'Fix planner returned 0 tasks but final_review reported 1 blocking finding(s).' };
  const n = deriveNeedsAttention(wf);
  assert.equal(n.reason, 'blocked');
  assert.match(n.detail, /0 tasks/);
});

test('dead_step outranks blocked when a step carries both', () => {
  // autoAdvanceError is the more specific signal — it says *why* nothing can
  // advance, where status:'blocked' only says that it cannot.
  const wf = running();
  wf.currentStep = 'fix_plan';
  wf.steps.fix_plan = { status: 'blocked', error: 'generic', autoAdvanceError: 'specific cause' };
  assert.equal(deriveNeedsAttention(wf).reason, 'dead_step');
});

test('human gates are reported as waiting, not as failures', () => {
  for (const gate of ['device_testing', 'owner_consultations', 'demo_review']) {
    const wf = { type: 'execution', input: 'x', currentStep: gate, steps: { [gate]: { status: 'pending' } } };
    const n = deriveNeedsAttention(wf);
    assert.equal(n.reason, 'human_gate', gate);
    assert.equal(n.step, gate);
  }
});

test('demo_review is not a gate when the owner opted out of it', () => {
  const wf = {
    type: 'execution', input: 'x', currentStep: 'demo_review',
    autoAdvanceSkipDemoReview: true,
    steps: { demo_review: { status: 'pending' } },
  };
  assert.equal(deriveNeedsAttention(wf), null);
});

test('a completed gate step is not still waiting', () => {
  const wf = { type: 'execution', input: 'x', currentStep: 'demo_review', steps: { demo_review: { status: 'completed' } } };
  assert.equal(deriveNeedsAttention(wf), null);
});

test('every result carries a machine key, a human title, and an action', () => {
  const cases = [
    { type: 'bugfix', input: 'a', currentStep: 'completed', steps: {} },
    { type: 'execution', input: 'b', currentStep: 'review_cap_reached', round: 5, steps: { review_cap_reached: {} } },
    { type: 'execution', input: 'c', currentStep: 's', steps: { s: { autoAdvanceError: 'x' } } },
    { type: 'execution', input: 'd', currentStep: 's', steps: { s: { status: 'blocked' } } },
    { type: 'execution', input: 'e', currentStep: 'demo_review', steps: { demo_review: {} } },
  ];
  for (const wf of cases) {
    const n = deriveNeedsAttention(wf);
    assert.ok(n && n.reason && n.title && n.detail && n.action, JSON.stringify(wf.currentStep));
  }
});
