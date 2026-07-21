'use strict';

// Unit tests for FU-1 opencode telemetry. The event/export fixtures mirror the
// shapes verified live on 2026-07-20 (opencode 1.18.x): step_finish events
// carry part.tokens{input,output,reasoning,cache{read,write}} + part.cost;
// `opencode export` returns {info, messages:[{info:{role, model{modelID,providerID}, modelID}}]}.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseEventsFile, captureFromEvents, modelFromExport, resolveActualModel } = require('./opencode-telemetry');

function writeTmp(name, content) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oc-tel-')), name);
  fs.writeFileSync(p, content);
  return p;
}

const ev = (type, part) => JSON.stringify({ type, timestamp: 1784577000000, sessionID: part?.sessionID || null, part });

const STEP1 = ev('step_finish', {
  id: 'p1', messageID: 'm1', sessionID: 'ses_test123', type: 'step_finish',
  tokens: { total: 14379, input: 14344, output: 16, reasoning: 19, cache: { write: 0, read: 0 } },
  cost: 0.043557,
});
const STEP2 = ev('step_finish', {
  id: 'p2', messageID: 'm2', sessionID: 'ses_test123', type: 'step_finish',
  tokens: { total: 21000, input: 18000, output: 900, reasoning: 100, cache: { write: 500, read: 1600 } },
  cost: 0.021,
});

test('parseEventsFile: sums tokens + cost across step_finish events; skips malformed lines', () => {
  const file = writeTmp('events.jsonl', [
    ev('step_start', { id: 's1', messageID: 'm1', sessionID: 'ses_test123', type: 'step_start' }),
    STEP1,
    '{"type":"text","part":{"text":"partial',  // malformed — skipped
    STEP2,
    '',
  ].join('\n'));

  const r = parseEventsFile(file);
  assert.equal(r.sessionId, 'ses_test123');
  assert.equal(r.steps, 2);
  assert.equal(r.inputTokens, 14344 + 18000);
  assert.equal(r.outputTokens, 16 + 900);
  assert.equal(r.reasoningTokens, 19 + 100);
  assert.equal(r.cacheCreate, 500);
  assert.equal(r.cacheRead, 1600);
  assert.equal(r.costUSD, 0.0646); // 0.043557 + 0.021, rounded to 4dp
});

test('parseEventsFile: missing file → null; session-only file → sessionId without token data', () => {
  assert.equal(parseEventsFile('/nonexistent/events.jsonl'), null);
  const file = writeTmp('events.jsonl', ev('step_start', { id: 's1', sessionID: 'ses_only', type: 'step_start' }));
  const r = parseEventsFile(file);
  assert.equal(r.sessionId, 'ses_only');
  assert.equal(r.steps, 0);
});

test('captureFromEvents: fills badge-shaped tokenUsage (reasoning folded into output)', () => {
  const file = writeTmp('events.jsonl', [STEP1, STEP2].join('\n'));
  const agent = {};
  const sid = captureFromEvents(agent, file);
  assert.equal(sid, 'ses_test123');
  assert.deepEqual(agent.tokenUsage, {
    inputTokens: 32344,
    outputTokens: 1035, // 16+900 + 19+100 reasoning
    cacheCreate: 500,
    cacheRead: 1600,
    costUSD: 0.0646,
  });
});

test('captureFromEvents: no events file → null session, agent untouched', () => {
  const agent = {};
  assert.equal(captureFromEvents(agent, '/nonexistent/x.jsonl'), null);
  assert.equal(agent.tokenUsage, undefined);
});

test('modelFromExport: last assistant model wins; provider joined when unscoped', () => {
  const exp = {
    info: {},
    messages: [
      { info: { role: 'user', id: 'u1' }, parts: [] },
      { info: { role: 'assistant', model: { modelID: 'kimi-k3', providerID: 'moonshotai' } }, parts: [] },
      { info: { role: 'assistant', model: { modelID: 'anthropic/claude-sonnet-4.5' } }, parts: [] },
    ],
  };
  assert.equal(modelFromExport(exp), 'anthropic/claude-sonnet-4.5');
  const single = { messages: [{ info: { role: 'assistant', model: { modelID: 'kimi-k3', providerID: 'moonshotai' } } }] };
  assert.equal(modelFromExport(single), 'moonshotai/kimi-k3');
  const bare = { messages: [{ info: { role: 'assistant', modelID: 'moonshotai/kimi-k3' } }] };
  assert.equal(modelFromExport(bare), 'moonshotai/kimi-k3');
  assert.equal(modelFromExport({ messages: [] }), null);
  assert.equal(modelFromExport({}), null);
});

test('resolveActualModel: parses export stdout; null on error/invalid/missing session', async () => {
  const good = (cmd, args, opts, cb) => cb(null, JSON.stringify({ messages: [{ info: { role: 'assistant', model: { modelID: 'kimi-k3', providerID: 'moonshotai' } } }] }));
  assert.equal(await resolveActualModel('ses_x', { execFileImpl: good }), 'moonshotai/kimi-k3');

  const failing = (cmd, args, opts, cb) => cb(new Error('no such session'));
  assert.equal(await resolveActualModel('ses_x', { execFileImpl: failing }), null);

  const garbage = (cmd, args, opts, cb) => cb(null, 'not json');
  assert.equal(await resolveActualModel('ses_x', { execFileImpl: garbage }), null);

  assert.equal(await resolveActualModel(null), null);
});
