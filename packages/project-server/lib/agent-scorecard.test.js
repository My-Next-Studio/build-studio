'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  severityFromFeedback, agentRecords, aggregate, appendRun, readLog, dedupe,
  USAGE_TRUSTED_FROM,
} = require('./agent-scorecard');

const AFTER = '2026-09-01T10:00:00.000Z';   // usage recorded post-fix: trusted
const BEFORE = '2026-08-09T10:00:00.000Z';  // pre-fix: not trusted

const usage = (over = {}) => ({
  inputTokens: 1000, outputTokens: 200, cacheRead: 50000, cacheCreate: 100,
  costUSD: 0.5, model: 'claude-opus-5', source: 'transcript', ...over,
});

function wfWith(agents, over = {}) {
  return {
    id: 'wf-1', type: 'execution', input: 'EX-1', round: 2, updatedAt: AFTER,
    steps: { code_review: { agents } }, ...over,
  };
}

// ── severity parsing ─────────────────────────────────────────────────────────

test('a structured verdict yields its three counts', () => {
  const s = severityFromFeedback('## Review: QA\n\n**Approved:** no\n**Blocking:** 2  |  **Medium:** 3  |  **Low:** 1\n');
  assert.deepEqual(s, { blocking: 2, medium: 3, low: 1 });
});

test('feedback with no verdict is null, not zeroes', () => {
  // A builder posts an implementation report with no severities. Counting that
  // as 0/0/0 would make every builder look like a flawless reviewer in any
  // average over "findings raised".
  assert.equal(severityFromFeedback('Implemented all ACs; suite green.'), null);
  assert.equal(severityFromFeedback(''), null);
  assert.equal(severityFromFeedback(null), null);
});

test('a verdict missing the optional tiers still counts blocking', () => {
  assert.deepEqual(severityFromFeedback('**Blocking:** 0'), { blocking: 0, medium: 0, low: 0 });
});

// ── flattening a workflow ────────────────────────────────────────────────────

test('both agent homes are swept, including task_execution', () => {
  // task_execution's agents live under taskExecution.taskStates; the step-level
  // mirror is routinely empty mid-run. Reading only steps[] drops the builder —
  // the role a scorecard most wants to see.
  const wf = wfWith([{ role: 'Code Reviewer', status: 'done', startedAt: AFTER }], {
    taskExecution: { taskStates: { '0': { agents: [{ role: 'iOS Dev', status: 'done', startedAt: AFTER }] } } },
  });
  const roles = agentRecords(wf, 'p').map((r) => `${r.role}@${r.step}`).sort();
  assert.deepEqual(roles, ['Code Reviewer@code_review', 'iOS Dev@task_execution']);
});

test('duration is computed only when both timestamps are present and ordered', () => {
  const [a, b, c] = agentRecords(wfWith([
    { role: 'A', startedAt: AFTER, completedAt: '2026-09-01T10:00:30.000Z' },
    { role: 'B', startedAt: AFTER },
    { role: 'C', startedAt: '2026-09-01T10:01:00.000Z', completedAt: AFTER }, // ends before it starts
  ]), 'p');
  assert.equal(a.durationMs, 30000);
  assert.equal(b.durationMs, null);
  assert.equal(c.durationMs, null, 'a negative duration is not data');
});

// ── the trust boundary, which is the point of the module ─────────────────────

test('usage recorded before the attribution fix is not counted as data', () => {
  // Pre-2026-08-22 numbers came from a time-window sweep that charged six
  // concurrent reviewers for all six, overstating one round by 4.3x. Averaging
  // that into real measurements produces a confident wrong answer.
  const [r] = agentRecords(wfWith([{ role: 'QA', startedAt: BEFORE, tokenUsage: usage() }]), 'p');
  assert.equal(r.tokens, null);
  assert.equal(r.costUSD, null);
  assert.equal(r.usageSource, null);
});

test('usage recorded after the fix is counted', () => {
  const [r] = agentRecords(wfWith([{ role: 'QA', startedAt: AFTER, tokenUsage: usage() }]), 'p');
  assert.equal(r.tokens.cacheRead, 50000);
  assert.equal(r.costUSD, 0.5);
});

test('the boundary constant is the date of the attribution fix', () => {
  assert.match(USAGE_TRUSTED_FROM, /^2026-08-22/);
});

test('a null cost on trusted usage stays null rather than becoming zero', () => {
  // An unpriced model. Zero would make the role look free.
  const [r] = agentRecords(wfWith([{ role: 'QA', startedAt: AFTER, tokenUsage: usage({ costUSD: null }) }]), 'p');
  assert.notEqual(r.tokens, null, 'tokens are still measured');
  assert.equal(r.costUSD, null);
});

// ── aggregation ──────────────────────────────────────────────────────────────

test('rows group by project, role and step', () => {
  const recs = [
    ...agentRecords(wfWith([{ role: 'QA', startedAt: AFTER, tokenUsage: usage() }]), 'alpha'),
    ...agentRecords(wfWith([{ role: 'QA', startedAt: AFTER, tokenUsage: usage() }]), 'beta'),
  ];
  const rows = aggregate(recs);
  assert.equal(rows.length, 2, 'same role in two projects must not merge — the comparison IS the product');
});

test('measured, unpriced and unmeasured are counted separately', () => {
  // Three different states that a single "cost" column would flatten into one
  // misleading number.
  const recs = agentRecords(wfWith([
    { role: 'QA', startedAt: AFTER, tokenUsage: usage() },                    // priced
    { role: 'QA', startedAt: AFTER, tokenUsage: usage({ costUSD: null }) },   // measured, unpriced
    { role: 'QA', startedAt: BEFORE, tokenUsage: usage() },                   // untrusted era
    { role: 'QA', startedAt: AFTER },                                         // no usage at all
  ]), 'p');
  const [row] = aggregate(recs);
  assert.equal(row.agents, 4);
  assert.equal(row.pricedAgents, 1);
  assert.equal(row.unpricedAgents, 1);
  assert.equal(row.unmeasuredAgents, 2);
  assert.equal(row.tokens.cacheRead, 100000, 'only the two trusted records contribute');
});

test('a run appearing once contributes one run, however many agents it had', () => {
  const recs = agentRecords(wfWith([
    { role: 'QA', startedAt: AFTER }, { role: 'QA', startedAt: AFTER },
  ]), 'p');
  const [row] = aggregate(recs);
  assert.equal(row.agents, 2);
  assert.equal(row.runs, 1);
});

test('findings sum only over agents that gave a verdict', () => {
  const recs = agentRecords(wfWith([
    { role: 'QA', startedAt: AFTER, feedback: '**Blocking:** 1  |  **Medium:** 2  |  **Low:** 0' },
    { role: 'QA', startedAt: AFTER, feedback: 'no verdict here' },
  ]), 'p');
  const [row] = aggregate(recs);
  assert.equal(row.verdicts, 1, 'the denominator excludes the agent that gave none');
  assert.deepEqual(row.findings, { blocking: 1, medium: 2, low: 0 });
});

test('errored agents are counted but still contribute their usage', () => {
  const recs = agentRecords(wfWith([{ role: 'QA', status: 'error', startedAt: AFTER, tokenUsage: usage() }]), 'p');
  const [row] = aggregate(recs);
  assert.equal(row.errored, 1);
  assert.equal(row.tokens.cacheRead, 50000, 'a failed agent still spent the tokens');
});

test('rows are ordered by cache reads — the term that dominates this workload', () => {
  const recs = [
    ...agentRecords(wfWith([{ role: 'Cheap', startedAt: AFTER, tokenUsage: usage({ cacheRead: 10 }) }]), 'p'),
    ...agentRecords(wfWith([{ role: 'Costly', startedAt: AFTER, tokenUsage: usage({ cacheRead: 999999 }) }]), 'p'),
  ];
  assert.equal(aggregate(recs)[0].role, 'Costly');
});

// ── the durable log ──────────────────────────────────────────────────────────

test('a run appends and reads back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-'));
  const n = appendRun(dir, wfWith([{ role: 'QA', startedAt: AFTER, tokenUsage: usage() }]), 'p');
  assert.equal(n, 1);
  const back = readLog(dir);
  assert.equal(back.length, 1);
  assert.equal(back[0].role, 'QA');
});

test('appending twice does not double the counts after dedupe', () => {
  // A relaunched completion, or a seed followed by a real run, must not inflate
  // every figure — the exact trap that made snapshots unusable (90 files, 12
  // distinct runs).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-'));
  const wf = wfWith([{ role: 'QA', startedAt: AFTER, tokenUsage: usage() }]);
  appendRun(dir, wf, 'p');
  appendRun(dir, wf, 'p');
  assert.equal(readLog(dir).length, 2);
  const rows = aggregate(dedupe(readLog(dir)));
  assert.equal(rows[0].agents, 1);
  assert.equal(rows[0].tokens.cacheRead, 50000);
});

test('a missing or corrupt log degrades to empty, never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-'));
  assert.deepEqual(readLog(dir), []);
  fs.writeFileSync(path.join(dir, 'scorecard.jsonl'), '{bad json\n{"role":"QA","wfId":"w","step":"s"}\n');
  assert.equal(readLog(dir).length, 1, 'the good line survives');
});

test('appending an empty workflow writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-'));
  assert.equal(appendRun(dir, { id: 'x', steps: {} }, 'p'), 0);
  assert.deepEqual(readLog(dir), []);
});
