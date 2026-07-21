'use strict';

// Regression: a false dead-process watchdog halt (launch-studio qa_tests,
// 2026-07-20 — opencode agent misclassified while still working) left a stale
// `agent.error` on the record even after the agent's feedback arrived and
// flipped status to 'done'. The hub renders agent.error unconditionally, so
// the scary "Relaunch the step" note persisted next to an approved result.
// The feedback handlers must clear the error when feedback lands.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createWorkflowRouter } = require('./workflow');

const STALE_ERROR = 'Agent process died (pane returned to a shell prompt) — auto-resume unavailable for this CLI. Relaunch the step.';

function makeApp(wf) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-feedback-test-'));
  const config = {
    projectRoot: root,
    docsPath: path.join(root, 'docs'),
    worktreesPath: path.join(root, 'tmp', '.worktrees'),
    logsPath: path.join(root, 'tmp', '.logs'),
    tmpPath: path.join(root, 'tmp'),
    roles: { review: [], execution: [], standalone: [] },
  };
  const state = {
    loadWorkflow: () => wf,
    saveWorkflow: (w) => { wf.saved = true; Object.assign(wf, w); },
    loadRun: () => null,
    registerCompletionHook: () => {},
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createWorkflowRouter(config, state, {}, {}, () => {}));
  app.locals.testConfig = config;
  return app;
}

async function postFeedback(app, body) {
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/workflow/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  } finally {
    server.close();
  }
}

function baseWf() {
  return {
    id: 'test-wf',
    type: 'execution',
    input: 'test',
    createdAt: new Date().toISOString(),
    round: 1,
    currentStep: 'qa_tests',
    autoAdvance: false,
    autoIterateRemaining: 0,
    feedback: [],
    steps: {
      qa_tests: {
        status: 'running',
        agents: [{ role: 'QA', window: 'qa-tests', status: 'running', error: STALE_ERROR }],
      },
    },
  };
}

test('step-level feedback clears a stale watchdog error when marking the agent done', async () => {
  const wf = baseWf();
  const app = makeApp(wf);
  const { status, body } = await postFeedback(app, { role: 'QA', feedback: '**Approved:** yes\nAll good.' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const agent = wf.steps.qa_tests.agents[0];
  assert.equal(agent.status, 'done');
  assert.equal(agent.error, undefined);
  assert.ok(agent.completedAt);
});

test('task-level feedback clears a stale watchdog error too (handleTaskFeedback)', async () => {
  const wf = baseWf();
  wf.currentStep = 'task_execution';
  wf.taskExecution = {
    currentTaskIndex: 0,
    taskStates: {
      '0': {
        status: 'running',
        agents: [
          { role: 'Frontend Dev', window: 'fw-0', status: 'running', error: STALE_ERROR },
          { role: 'Backend Dev', window: 'be-0', status: 'running' }, // keeps allDone false → no async state machine
        ],
      },
    },
  };
  const app = makeApp(wf);
  const { status, body } = await postFeedback(app, { role: 'Frontend Dev', feedback: 'Done, no claims.', taskIndex: 0 });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const agent = wf.taskExecution.taskStates['0'].agents[0];
  assert.equal(agent.status, 'done');
  assert.equal(agent.error, undefined);
});

test('opencode agent: feedback harvests the events stream into tokenUsage (FU-1)', async () => {
  const wf = baseWf();
  wf.steps.qa_tests.agents[0].cli = 'opencode';
  const app = makeApp(wf);
  // Seed the events file the launch path would have tee'd (no sessionID — keeps
  // the test hermetic: token capture runs, async model resolution never fires).
  const logsDir = app.locals.testConfig.logsPath;
  fs.mkdirSync(logsDir, { recursive: true });
  const stepFinish = JSON.stringify({
    type: 'step_finish', timestamp: 1, sessionID: null,
    part: { id: 'p1', type: 'step_finish', tokens: { input: 1000, output: 50, reasoning: 5, cache: { write: 0, read: 200 } }, cost: 0.0123 },
  });
  fs.writeFileSync(path.join(logsDir, 'qa-tests-test-wf.events.jsonl'), stepFinish + '\n');

  const { status, body } = await postFeedback(app, { role: 'QA', feedback: '**Approved:** yes' });
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const agent = wf.steps.qa_tests.agents[0];
  assert.equal(agent.status, 'done');
  assert.deepEqual(agent.tokenUsage, { inputTokens: 1000, outputTokens: 55, cacheCreate: 0, cacheRead: 200, costUSD: 0.0123 });
});
