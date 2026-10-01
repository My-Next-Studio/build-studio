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

// --- Dead steps, derived rather than reported (2026-07-31) --------------------
//
// The auto-advance tick stashes `autoAdvanceError` when every agent dies, but
// only while auto-advance is ON. These pin the same condition being derived
// directly, and — the case that actually bit — being seen at all on a
// task_execution step, whose `steps.*.agents` is a mirror that is usually empty.

test('a step whose agents all errored is dead even with auto-advance off', () => {
  const wf = {
    type: 'execution', input: 'x', currentStep: 'code_review',
    steps: { code_review: { status: 'running', agents: [{ role: 'Code Reviewer', status: 'error', error: 'Session lost' }] } },
  };
  const n = deriveNeedsAttention(wf);
  assert.equal(n.reason, 'dead_step');
  assert.match(n.detail, /Session lost/);
});

test('an agent that errored but still delivered feedback is not a dead step', () => {
  // Feedback proves the agent lived and produced something to advance on.
  const wf = {
    type: 'execution', input: 'x', currentStep: 'code_review',
    steps: { code_review: { status: 'running', agents: [{ role: 'R', status: 'error', feedback: 'Approved: yes' }] } },
  };
  assert.equal(deriveNeedsAttention(wf), null);
});

test('one live agent among dead ones is not a dead step', () => {
  const wf = {
    type: 'execution', input: 'x', currentStep: 'reviewing',
    steps: { reviewing: { status: 'running', agents: [
      { role: 'A', status: 'error' }, { role: 'B', status: 'running' },
    ] } },
  };
  assert.equal(deriveNeedsAttention(wf), null);
});

test('task_execution agents are found through the empty step mirror', () => {
  // The deskrhythm DR-092 shape: the mirror is empty, the real agent record
  // lives under taskExecution. Reading only the mirror reported "nothing wrong".
  const wf = {
    type: 'bugfix', input: 'DR-092', currentStep: 'task_execution',
    steps: { task_execution: { status: 'running', agents: [] } },
    taskExecution: {
      currentTaskIndex: 0,
      taskStates: { 0: { status: 'running', agents: [{ role: 'iOS Dev', status: 'error', error: 'Session lost — the tmux session is gone' }] } },
    },
  };
  const n = deriveNeedsAttention(wf);
  assert.equal(n.reason, 'dead_step');
  assert.match(n.detail, /tmux session is gone/);
});

test('a healthy task_execution run still reports nothing', () => {
  const wf = {
    type: 'bugfix', input: 'DR-092', currentStep: 'task_execution',
    steps: { task_execution: { status: 'running', agents: [] } },
    taskExecution: { currentTaskIndex: 0, taskStates: { 0: { status: 'running', agents: [{ role: 'iOS Dev', status: 'running' }] } } },
  };
  assert.equal(deriveNeedsAttention(wf), null);
});

// --- The round cap, told apart from the fix loop's (2026-08-01) -------------

test('a capped PRD review names both ways out, not the fix loop’s', () => {
  const wf = {
    type: 'review', input: 'FAZ-218', currentStep: 'review_cap_reached', round: 5,
    steps: { review_cap_reached: { status: 'blocked', cap: 'review', rounds: 5 } },
  };
  const n = deriveNeedsAttention(wf);
  assert.equal(n.reason, 'review_cap_reached');
  assert.match(n.title, /PRD review/);
  assert.match(n.detail, /FAZ-218/);
  assert.match(n.detail, /5 rounds/);
  assert.match(n.action, /next review round as if there were no cap/i);
  assert.match(n.action, /companion specs/);
  assert.match(n.action, /companion specs/i);
});

test('a capped execution fix loop keeps its own wording', () => {
  const wf = {
    type: 'execution', input: 'PRD-1', currentStep: 'review_cap_reached', round: 5,
    steps: { review_cap_reached: { status: 'blocked', cap: 'code_review', rounds: 5 } },
  };
  const n = deriveNeedsAttention(wf);
  assert.match(n.title, /Fix loop/);
  assert.match(n.action, /as if there were no cap/);
  assert.match(n.action, /accept its open findings/);
});

// ── Alive but not progressing (2026-08-12) ─────────────────────────────────
// The process checks answer "is it alive?" correctly; this is the second axis.

function wfWithStalled(reason, status = 'running') {
  return {
    currentStep: 'reviewing',
    steps: { reviewing: { status: 'running', agents: [
      { role: 'Security', status, feedback: null,
        stalled: { reason, title: 'T', detail: 'D', action: 'A' } },
    ] } },
  };
}

test('a stalled-but-alive agent surfaces as needsAttention', () => {
  const n = deriveNeedsAttention(wfWithStalled('finished_not_reported'));
  assert.equal(n.reason, 'finished_not_reported');
  assert.equal(n.step, 'reviewing');
  assert.match(n.detail, /^Security: /);   // names WHICH agent
});

test('auth_blocked surfaces the same way', () => {
  assert.equal(deriveNeedsAttention(wfWithStalled('auth_blocked')).reason, 'auth_blocked');
});

test('a stalled marker on an agent that is no longer running is ignored', () => {
  // Stale state is worse than none — the flag must not outlive the condition.
  assert.equal(deriveNeedsAttention(wfWithStalled('agent_waiting', 'done')), null);
});

// The 15-minute idle timeout stamps status='error' on any agent whose log has
// gone quiet — and an agent that stalls by WAITING produces no log output, so
// it always gets stamped. Requiring status==='running' therefore excluded the
// exact case this rule exists for: the diagnosis was computed, stored, and
// never shown, while the dead-step rule reported "all agents errored with no
// output — relaunch" about a live agent holding uncommitted work.
test('an agent stamped error by the idle timeout still surfaces its diagnosis', () => {
  const n = deriveNeedsAttention(wfWithStalled('awaiting_decision', 'error'));
  assert.equal(n.reason, 'awaiting_decision');
  assert.equal(n.step, 'reviewing');
});

test('the alive-but-stuck diagnosis outranks the dead-step rules', () => {
  // Both describe the same step. dead_step's action is "relaunch", which is the
  // one thing that must not happen to an agent waiting at a dialog.
  const wf = {
    currentStep: 'qa_tests',
    steps: {
      qa_tests: {
        status: 'running',
        autoAdvanceError: 'all 1 agent(s) errored with no output — halted instead of advancing past a dead step',
        agents: [{
          role: 'QA', status: 'error', feedback: null,
          stalled: {
            reason: 'awaiting_decision',
            title: 'An agent is waiting for your decision',
            detail: 'It asked a question and is holding at its own prompt.',
            action: 'Open that agent\'s terminal and answer it.',
          },
        }],
      },
    },
  };
  const n = deriveNeedsAttention(wf);
  assert.equal(n.reason, 'awaiting_decision');
  assert.doesNotMatch(n.action, /relaunch/i);
});

// A task agent lives on taskExecution.taskStates, and the step's mirror is
// routinely empty — so the rule never saw it, and the dead-step rule reported
// "task_execution cannot advance — All 1 agent(s) failed" about an agent that
// was waiting for an answer (launch-studio LS-167, 2026-09-30).
test('a task-execution agent waiting for an answer surfaces, with the question', () => {
  const wf = {
    currentStep: 'task_execution',
    steps: { task_execution: { status: 'running', agents: [] } },
    taskExecution: { taskStates: { 0: { agents: [{
      role: 'Fullstack Dev', status: 'running', feedback: null, window: 'task-0',
      stalled: {
        reason: 'awaiting_decision',
        title: 'An agent is waiting for your decision',
        detail: 'It asked a question and is holding at its own prompt.',
        action: 'Open that agent\'s terminal and answer it.',
        question: 'Dependency\nLS-179 is not built. How should I proceed?',
      },
    }] } } },
  };
  const n = deriveNeedsAttention(wf);
  assert.equal(n.reason, 'awaiting_decision');
  assert.equal(n.step, 'task_execution');
  assert.equal(n.window, 'task-0');
  assert.match(n.detail, /It is asking:\nDependency\nLS-179 is not built/);
});

test('a genuinely dead step is still reported as dead', () => {
  // The reordering must not shadow the rule it now sits in front of.
  const wf = {
    currentStep: 'qa_tests',
    steps: { qa_tests: { status: 'running', agents: [{ role: 'QA', status: 'error', feedback: null, error: 'boom' }] } },
  };
  assert.equal(deriveNeedsAttention(wf).reason, 'dead_step');
});

test('a gate that could not run reaches the owner, not the fix loop', () => {
  const wf = { currentStep: 'qa_validation', steps: { qa_validation: { status: 'running', agents: [
    { role: 'QA', status: 'done', feedback: '**Tests passed:** 7/7\n**Gate could not run:** ERR_CONNECTION_REFUSED' },
  ] } } };
  const n = deriveNeedsAttention(wf);
  assert.equal(n.reason, 'gate_blocked');
  assert.match(n.detail, /nothing for a developer to fix/);
});

test('a gate that could not run beside a real defect is not an environment-only stop', () => {
  // fazon, 2026-09-30: a CLS regression (Blocking: 1) plus a font check that
  // could not run. Saying "nothing for a developer to fix" there is false.
  const wf = { currentStep: 'qa_validation', steps: { qa_validation: { status: 'running', agents: [
    { role: 'QA', status: 'done', feedback: '**Tests passed:** 1435/1466\n**Gate could not run:** No module named fontTools\n**Approved:** no\n**Blocking:** 1' },
  ] } } };
  const n = deriveNeedsAttention(wf);
  assert.ok(!n || n.reason !== 'gate_blocked');
});

test('an unrun check with no defect is named as gate-blocked, with remedies that fit', () => {
  // fazon FAZ-365, 2026-10-01: one file's setup timed out, Blocking 0, no
  // Approved line. The tick now holds, so this banner is what the owner sees.
  const wf = { currentStep: 'qa_validation', steps: { qa_validation: { status: 'running', agents: [
    { role: 'QA', status: 'done', feedback: '**Blocking:** 0\n Test Files  1 failed | 53 passed\n**Gate could not run:** `cd web && npm test`: setup timed out' },
  ] } } };
  const n = deriveNeedsAttention(wf);
  assert.equal(n.reason, 'gate_blocked');
  assert.equal(n.step, 'qa_validation');
  assert.match(n.action, /override/);
  assert.doesNotMatch(n.action, /route it to the devs/);
});

test('a certified clean verdict beside an unrun check is not a stop', () => {
  // launch-studio LS-168, 2026-10-01: Approved yes, 8157/8157, one screenshot
  // command could not run and QA captured the same dialog another way.
  const wf = { currentStep: 'qa_validation', steps: { qa_validation: { status: 'running', agents: [
    { role: 'QA', status: 'done', feedback: '**Approved:** yes\n**Blocking:** 0\n**Tests passed:** 8157/8157\n**Gate could not run:** screenshot readiness timed out' },
  ] } } };
  const n = deriveNeedsAttention(wf);
  assert.ok(!n || n.reason !== 'gate_blocked');
});

test('a completed step is not re-reported as gate-blocked', () => {
  const wf = { currentStep: 'code_review', steps: { qa_validation: { status: 'completed', agents: [
    { role: 'QA', status: 'done', feedback: '**Gate could not run:** old news' },
  ] }, code_review: { status: 'running', agents: [] } } };
  assert.equal(deriveNeedsAttention(wf), null);
});

test('an empty fix plan that names an owner action reads as waiting on the owner', () => {
  const { deriveNeedsAttention } = require('./needs-attention');
  const wf = {
    type: 'execution', currentStep: 'fix_plan', input: 'FAZ-272',
    steps: { fix_plan: { status: 'blocked', error: 'Waiting on you: owner action required.', agents: [{ role: 'Fix Planner', status: 'done', feedback: 'x' }],
      ownerAction: { text: '1. Run the device script.\n2. Fill in the record.', sourceStep: 'code_review' } } },
  };
  const n = deriveNeedsAttention(wf);
  assert.equal(n.reason, 'owner_action');
  assert.match(n.title, /Waiting on you/);
  assert.match(n.detail, /code_review/);
  assert.match(n.detail, /Run the device script/);
});
