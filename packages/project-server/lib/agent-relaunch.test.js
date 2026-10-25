'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { findRelaunchable, relaunchSpec } = require('./agent-relaunch');

const reviewing = (agents, status = 'running') => ({
  currentStep: 'reviewing', round: 1, steps: { reviewing: { status, agents } },
});
const done = (role) => ({ role, window: role.toLowerCase(), status: 'done', feedback: '## Review', instruction: 'x' });

// run-studio RS-043 (2026-10-25): five reviewers done, QA died on a rate limit.
test('finds the one failed reviewer among finished ones', () => {
  const qa = { role: 'QA', window: 'qa', status: 'error', instruction: 'review it' };
  const wf = reviewing([done('Brand'), done('UX'), qa]);
  const r = findRelaunchable(wf, { role: 'QA' });
  assert.equal(r.index, 2);
  assert.equal(r.agent, qa);
});

test('a reviewer that has reported is not relaunched', () => {
  const r = findRelaunchable(reviewing([done('Brand')]), { role: 'Brand' });
  assert.match(r.error, /has reported/);
});

test('refuses what it cannot relaunch sensibly', () => {
  assert.match(findRelaunchable(reviewing([]), { role: 'QA' }).error, /no QA agent/);
  assert.match(findRelaunchable(reviewing([{ role: 'QA', status: 'error', instruction: 'x' }], 'completed'), { role: 'QA' }).error, /already completed/);
  assert.match(findRelaunchable(reviewing([{ role: 'QA', status: 'error' }]), { role: 'QA' }).error, /no stored instruction/);
  assert.match(findRelaunchable(reviewing([]), {}).error, /role is required/);
  assert.match(findRelaunchable(null, { role: 'QA' }).error, /no active workflow/);
  const tex = { currentStep: 'task_execution', taskExecution: {}, steps: { task_execution: { status: 'running', agents: [] } } };
  assert.match(findRelaunchable(tex, { role: 'iOS Dev' }).error, /relaunch_task/);
});

test('two agents of one role are told apart by window', () => {
  const a = { role: 'QA', window: 'qa-a', status: 'error', instruction: 'x' };
  const b = { role: 'QA', window: 'qa-b', status: 'error', instruction: 'y' };
  const wf = reviewing([a, b]);
  assert.match(findRelaunchable(wf, { role: 'QA' }).error, /name the window/);
  assert.equal(findRelaunchable(wf, { role: 'QA', window: 'qa-b' }).agent, b);
});

test('the spec keeps what the launch read and drops what the run wrote', () => {
  const stored = {
    role: 'QA', window: 'qa', reportFeedback: true, instruction: 'review it', historyOverride: 'h',
    status: 'error', error: 'Process exited', feedback: null, cli: 'codex', model: 'codex', startedAt: 't',
    agentCwd: '/p', codexRolloutPath: '/r.jsonl', limitResumeScript: 'start-qa-limit-resume.sh',
    stalled: { reason: 'model_stalled' }, stalledReason: 'model_stalled', blockedOnLimit: {}, feedbackNudgedAt: 't',
    injectedLearnings: [], cliSessionId: 'u',
  };
  assert.deepEqual(relaunchSpec(stored), {
    status: 'pending', feedback: null,
    role: 'QA', window: 'qa', reportFeedback: true, instruction: 'review it', historyOverride: 'h',
  });
});

test('the round suffix is taken off, since the launcher adds it again', () => {
  assert.equal(relaunchSpec({ role: 'QA', window: 'qa-r2', instruction: 'x' }, 2).window, 'qa');
  assert.equal(relaunchSpec({ role: 'QA', window: 'qa', instruction: 'x' }, 1).window, 'qa');
  // Only this round's suffix: an r2 window seen in round 3 is not touched.
  assert.equal(relaunchSpec({ role: 'QA', window: 'qa-r2', instruction: 'x' }, 3).window, 'qa-r2');
});

test('a done agent whose report was reconstructed from git can be relaunched', () => {
  const { buildWorkSummary } = require('./exit-recovery');
  const qa = { role: 'QA', window: 'qa-validate', status: 'done', instruction: 'x', feedback: buildWorkSummary({ role: 'QA', cli: 'codex', commits: [] }) };
  assert.equal(findRelaunchable({ currentStep: 'qa_validation', steps: { qa_validation: { status: 'running', agents: [qa] } } }, { role: 'QA' }).agent, qa);
  const own = { ...qa, feedback: '## QA\n\nSee the work recovered from git (RECONSTRUCTED, not agent-authored) above.' };
  assert.match(findRelaunchable({ currentStep: 'qa_validation', steps: { qa_validation: { status: 'running', agents: [own] } } }, { role: 'QA' }).error, /has reported/, 'only the reconstruction heading counts, not the phrase anywhere');
});
