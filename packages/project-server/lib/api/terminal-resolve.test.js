const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

// The drafting window is resolved here so the existing terminal panel can attach
// to it unchanged. Increment 2 moved the state from a map of per-item sessions
// to ONE session per project, and this lookup was not moved with it — every
// attach answered `No agent "draft" found` (2026-09-19). Both shapes resolve.
test('resolves the drafting window from the one-session-per-project shape', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-resolve-'));
  fs.writeFileSync(path.join(dir, 'draft-state.json'), JSON.stringify({
    sessionName: 'draft-proj',
    session: { window: 'draft', cliSessionId: 'x' },
  }));
  const target = resolveAgentTarget({ loadWorkflow: () => null, loadRun: () => null }, 'draft', dir);
  assert.deepEqual(target, { sessionName: 'draft-proj', window: 'draft' });
});

test('still resolves a window named by the older per-item shape', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-resolve-old-'));
  fs.writeFileSync(path.join(dir, 'draft-state.json'), JSON.stringify({
    sessionName: 'draft-proj',
    sessions: { 'EX-1': { window: 'draft-EX-1' } },
  }));
  const target = resolveAgentTarget({ loadWorkflow: () => null, loadRun: () => null }, 'draft-EX-1', dir);
  assert.deepEqual(target, { sessionName: 'draft-proj', window: 'draft-EX-1' });
});

test('an unknown window is still unresolved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-resolve-none-'));
  fs.writeFileSync(path.join(dir, 'draft-state.json'), JSON.stringify({ sessionName: 'draft-proj', session: { window: 'draft' } }));
  assert.equal(resolveAgentTarget({ loadWorkflow: () => null, loadRun: () => null }, 'nope', dir), null);
});
