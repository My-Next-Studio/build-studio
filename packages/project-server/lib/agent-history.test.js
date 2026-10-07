'use strict';

// Every round a run launched reaches the scorecard, not only the last one
// (2026-10-06: the round whose findings sent the work back was lost, so most
// runs with fix rounds recorded no findings at all).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { archiveReplacedAgents } = require('./agent-history');
const { agentRecords, dedupe } = require('./agent-scorecard');
const { createStateManager } = require('./state');

const reviewer = (window, startedAt, feedback, extra = {}) => ({
  role: 'Code Reviewer', window, startedAt, completedAt: startedAt, status: 'done', cli: 'claude',
  feedback, instruction: 'x'.repeat(5000), injectedLearnings: [{ title: 'big' }],
  tokenUsage: { inputTokens: 1, outputTokens: 2, cacheRead: 3, cacheCreate: 4, costUSD: 0.5, model: 'm' }, ...extra,
});
const ROUND1 = reviewer('code-review', '2026-10-06T10:00:00.000Z', '**Approved:** no\n**Blocking:** 2  |  **Medium:** 1  |  **Low:** 0');
const ROUND2 = reviewer('code-review-r2', '2026-10-06T11:00:00.000Z', '**Approved:** yes\n**Blocking:** 0  |  **Medium:** 0  |  **Low:** 0');
const wfWith = (agents, extra = {}) => ({ id: 'execution-1', round: 2, steps: { code_review: { status: 'done', agents } }, ...extra });

test('a replaced round is archived, slim, with its verdict', () => {
  const next = wfWith([ROUND2]);
  assert.equal(archiveReplacedAgents(wfWith([ROUND1]), next), 1);
  const [h] = next.agentHistory;
  assert.equal(h.step, 'code_review');
  assert.equal(h.window, 'code-review');
  assert.deepEqual(h._severity, { blocking: 2, medium: 1, low: 0 });
  assert.equal(h.tokenUsage.costUSD, 0.5, 'its cost is kept for the comparison');
  assert.equal(h.instruction, undefined, 'the prompt is not kept for every round');
  assert.equal(h.feedback, undefined);
});

test('never archived twice, never for a live agent, never across runs', () => {
  const next = wfWith([ROUND2]);
  archiveReplacedAgents(wfWith([ROUND1]), next);
  assert.equal(archiveReplacedAgents(wfWith([ROUND1]), next), 0, 'already archived');
  assert.equal(archiveReplacedAgents(wfWith([ROUND1, ROUND2]), wfWith([ROUND1, ROUND2])), 0, 'still present');
  assert.equal(archiveReplacedAgents({ ...wfWith([ROUND1]), id: 'execution-0' }, wfWith([ROUND2])), 0, 'a different run');
  assert.equal(archiveReplacedAgents(wfWith([{ role: 'X', window: 'x' }]), wfWith([])), 0, 'never launched');
});

test('the scorecard records every round, and reading the log keeps them apart', () => {
  const next = wfWith([ROUND2]);
  archiveReplacedAgents(wfWith([ROUND1]), next);
  const rows = agentRecords(next, 'p');
  assert.equal(rows.length, 2);
  const byRound = Object.fromEntries(rows.map((r) => [r.round, r]));
  assert.deepEqual(byRound[1].severity, { blocking: 2, medium: 1, low: 0 });
  assert.deepEqual(byRound[2].severity, { blocking: 0, medium: 0, low: 0 });
  assert.equal(byRound[1].costUSD, 0.5);
  assert.equal(dedupe([...rows, ...rows]).length, 2, 'an appended-twice run still dedupes, by round');
});

test('saveWorkflow archives the round a re-run replaced, before the completion hook', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-history-'));
  const docs = path.join(dir, 'docs');
  fs.mkdirSync(docs);
  const state = createStateManager({ statePath: dir, docsPath: docs }, () => {});
  let seenAtCompletion = null;
  state.registerCompletionHook((wf) => { seenAtCompletion = (wf.agentHistory || []).length; });

  state.saveWorkflow({ ...wfWith([ROUND1]), currentStep: 'code_review' });
  state.saveWorkflow({ ...wfWith([ROUND2]), currentStep: 'completed' });
  assert.equal(seenAtCompletion, 1, 'the scorecard sees round 1');
  assert.equal(state.loadWorkflow().agentHistory.length, 1);
});
