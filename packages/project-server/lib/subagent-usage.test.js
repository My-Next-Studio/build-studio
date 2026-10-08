'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { subagentUsage, withSubagents } = require('./subagent-usage');

const T0 = Date.parse('2026-10-07T10:00:00.000Z');
const at = (min) => new Date(T0 + min * 60000).toISOString();

const line = (min, model, usage) => JSON.stringify({
  timestamp: at(min), type: 'assistant', isSidechain: true,
  message: { role: 'assistant', model, usage },
});

function makeSession(subagents) {
  const claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-usage-'));
  const dir = path.join(claudeDir, 'sess-1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  for (const s of subagents) {
    fs.writeFileSync(path.join(dir, `agent-${s.id}.jsonl`), s.lines.join('\n') + '\n');
    if (s.meta) fs.writeFileSync(path.join(dir, `agent-${s.id}.meta.json`), JSON.stringify(s.meta));
  }
  return { claudeDir, clean: () => fs.rmSync(claudeDir, { recursive: true, force: true }) };
}

const PRICES = { cheap: 1, dear: 10 };
const price = (model, t) => (PRICES[model] === undefined ? null : PRICES[model] * (t.inputTokens + t.outputTokens) / 1000);

test('each subagent is summed and priced at its own model', () => {
  const s = makeSession([
    { id: 'a', meta: { agentType: 'general-purpose', description: 'Write spec tests' },
      lines: [line(1, 'cheap', { input_tokens: 100, output_tokens: 0 }), line(2, 'cheap', { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 50 })] },
    { id: 'b', meta: { agentType: 'general-purpose', description: 'Implement the parser' },
      lines: [line(3, 'dear', { input_tokens: 100, output_tokens: 100 })] },
  ]);
  try {
    const u = subagentUsage(s.claudeDir, 'sess-1', T0, T0 + 10 * 60000, price);
    assert.equal(u.count, 2);
    assert.equal(u.inputTokens, 300);
    assert.equal(u.cacheRead, 50);
    assert.equal(u.costUSD, 0.2 + 2);
    assert.deepEqual(u.models, ['cheap', 'dear']);
    const spec = u.list.find((x) => x.id === 'a');
    assert.equal(spec.description, 'Write spec tests');
    assert.equal(spec.startedAt, at(1));
    assert.equal(spec.completedAt, at(2));
  } finally { s.clean(); }
});

test('turns outside the agent window are not charged to it', () => {
  const s = makeSession([{ id: 'a', lines: [
    line(-30, 'cheap', { input_tokens: 9999, output_tokens: 0 }),
    line(1, 'cheap', { input_tokens: 100, output_tokens: 0 }),
  ] }]);
  try {
    assert.equal(subagentUsage(s.claudeDir, 'sess-1', T0, T0 + 600000, price).inputTokens, 100);
  } finally { s.clean(); }
});

test('an unpriced subagent makes the subagent cost null, and counts as unpriced', () => {
  const s = makeSession([
    { id: 'a', lines: [line(1, 'cheap', { input_tokens: 100, output_tokens: 0 })] },
    { id: 'b', lines: [line(2, 'mystery', { input_tokens: 100, output_tokens: 0 })] },
  ]);
  try {
    const u = subagentUsage(s.claudeDir, 'sess-1', T0, T0 + 600000, price);
    assert.equal(u.costUSD, null);
    assert.equal(u.unpriced, 1);
    assert.equal(u.list.find((x) => x.id === 'a').costUSD, 0.1);
  } finally { s.clean(); }
});

test('no subagents directory, or no session id, is null', () => {
  const s = makeSession([]);
  try {
    assert.equal(subagentUsage(s.claudeDir, 'sess-1', T0, T0 + 600000, price), null);
    assert.equal(subagentUsage(s.claudeDir, 'other', T0, T0 + 600000, price), null);
    assert.equal(subagentUsage(s.claudeDir, null, T0, T0 + 600000, price), null);
  } finally { s.clean(); }
});

test('withSubagents adds the subagents into the totals and keeps the breakdown', () => {
  const parent = { inputTokens: 10, outputTokens: 5, cacheRead: 100, cacheCreate: 1, costUSD: 1, model: 'opus' };
  const subs = { count: 2, inputTokens: 20, outputTokens: 10, cacheRead: 200, cacheCreate: 2, costUSD: 0.5, unpriced: 0, models: [], list: [] };
  const u = withSubagents(parent, subs);
  assert.equal(u.inputTokens, 30);
  assert.equal(u.cacheRead, 300);
  assert.equal(u.costUSD, 1.5);
  assert.equal(u.model, 'opus');
  assert.equal(u.subagents.count, 2);
});

test('withSubagents: a total with an unpriced part is null, not a partial sum', () => {
  const parent = { inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheCreate: 0, costUSD: 1, model: 'opus' };
  assert.equal(withSubagents(parent, { count: 1, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheCreate: 0, costUSD: null }).costUSD, null);
  assert.equal(withSubagents({ ...parent, costUSD: null }, { count: 1, inputTokens: 1, outputTokens: 1, cacheRead: 0, cacheCreate: 0, costUSD: 2 }).costUSD, null);
});

test('withSubagents with no subagents returns the parent unchanged', () => {
  const parent = { inputTokens: 1, costUSD: 1 };
  assert.equal(withSubagents(parent, null), parent);
});
