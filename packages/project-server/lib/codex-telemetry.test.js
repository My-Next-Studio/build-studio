'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  sessionIdFromLog, findRolloutFile, parseRollout, captureFromLog,
} = require('./codex-telemetry');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-tel-')); }

function writeLog(dir, body) {
  const p = path.join(dir, 'agent.log');
  fs.writeFileSync(p, body);
  return p;
}

/** A fake ~/.codex tree with one rollout for `id`. */
function fakeHome(id, rows) {
  const home = tmp();
  const dir = path.join(home, '.codex', 'sessions', '2026', '09', '05');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `rollout-2026-09-05T10-00-00-${id}.jsonl`), rows.join('\n'));
  return home;
}

const tokenCount = (total) => JSON.stringify({
  timestamp: '2026-09-05T10:00:00Z',
  type: 'event_msg',
  payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: { input_tokens: 1 } } },
});

// ── reading the id out of the pane log ───────────────────────────────────────

test('the session id is read through the ANSI escapes the pane log keeps', () => {
  // The launcher pipes raw pane output, so the line arrives bold-wrapped. A
  // matcher written against clean text finds nothing here.
  const d = tmp();
  const p = writeLog(d, 'banner\n[1msession id:[0m 019FA7E4-0CE2-7FD2-8E74-E94C78F6DD0E\nwork...\n');
  assert.equal(sessionIdFromLog(p), '019fa7e4-0ce2-7fd2-8e74-e94c78f6dd0e');
});

test('a plain, unstyled line works too', () => {
  const d = tmp();
  assert.equal(sessionIdFromLog(writeLog(d, 'session id: abc12345-0000\n')), 'abc12345-0000');
});

test('no id in the log is null, not a throw or a guess', () => {
  const d = tmp();
  assert.equal(sessionIdFromLog(writeLog(d, 'no banner here\n')), null);
  assert.equal(sessionIdFromLog(path.join(d, 'missing.log')), null);
});

test('only the head of the log is read', () => {
  // A long run's log is megabytes; the id is in the banner. Scanning the whole
  // file would make this cost scale with run length for no benefit — and an id
  // appearing late is not the agent's own session anyway.
  const d = tmp();
  const p = writeLog(d, 'x'.repeat(200000) + '\nsession id: deadbeef-1111\n');
  assert.equal(sessionIdFromLog(p), null);
});

// ── locating the rollout ─────────────────────────────────────────────────────

test('the rollout is found under the dated session tree', () => {
  const id = 'aaaabbbb-cccc-dddd';
  const home = fakeHome(id, [tokenCount({ input_tokens: 10, output_tokens: 2 })]);
  assert.match(findRolloutFile(id, home), /rollout-2026-09-05T10-00-00-aaaabbbb-cccc-dddd\.jsonl$/);
});

test('archived sessions are searched as well', () => {
  const home = tmp();
  const dir = path.join(home, '.codex', 'archived_sessions');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'rollout-2026-08-28T21-52-58-01a049ee-c078.jsonl'), tokenCount({ input_tokens: 5 }));
  assert.ok(findRolloutFile('01a049ee-c078', home));
});

test('a missing id or absent tree is null', () => {
  assert.equal(findRolloutFile(null, tmp()), null);
  assert.equal(findRolloutFile('nope-nope', tmp()), null);
});

// ── the arithmetic, which is where this could silently lie ───────────────────

const TOTALS = {
  input_tokens: 229273269,          // includes the cached reads below
  cached_input_tokens: 218195712,
  cache_write_input_tokens: 4000,
  output_tokens: 646914,            // includes reasoning
  reasoning_output_tokens: 147106,
  total_tokens: 229920183,
};

test('input is reported net of cached reads', () => {
  // Codex counts cache reads INSIDE input_tokens; the Claude reader stores them
  // separately. Passing input_tokens straight through would double-count every
  // cache read and make the two CLIs incomparable in a scorecard — which is the
  // entire reason this number is being collected.
  const u = parseRollout(writeLog(tmp(), tokenCount(TOTALS)));
  assert.equal(u.cacheRead, 218195712);
  assert.equal(u.inputTokens, 229273269 - 218195712);
});

test('the LAST total wins — the events are running totals, not deltas', () => {
  // Summing them multiplies the true figure by the turn count. With three
  // events the naive reading gives 60 instead of 30.
  const p = writeLog(tmp(), [
    tokenCount({ input_tokens: 10, output_tokens: 1 }),
    tokenCount({ input_tokens: 20, output_tokens: 2 }),
    tokenCount({ input_tokens: 30, output_tokens: 3 }),
  ].join('\n'));
  const u = parseRollout(p);
  assert.equal(u.inputTokens, 30);
  assert.equal(u.outputTokens, 3);
});

test('reasoning tokens are reported but not added on top of output', () => {
  const u = parseRollout(writeLog(tmp(), tokenCount(TOTALS)));
  assert.equal(u.outputTokens, 646914, 'output already includes reasoning');
  assert.equal(u.reasoningTokens, 147106);
});

test('a rollout with no token_count rows is null, not zeroes', () => {
  // Zero is a claim ("this agent cost nothing"); null is the truth ("not
  // measured"). A scorecard averaging phantom zeroes is worse than a gap.
  const p = writeLog(tmp(), JSON.stringify({ type: 'response_item', payload: {} }));
  assert.equal(parseRollout(p), null);
  assert.equal(parseRollout(path.join(tmp(), 'nothing.jsonl')), null);
});

test('malformed lines are skipped rather than aborting the parse', () => {
  const p = writeLog(tmp(), ['{not json', tokenCount({ input_tokens: 7, output_tokens: 1 }), ''].join('\n'));
  assert.equal(parseRollout(p).inputTokens, 7);
});

// ── end to end ───────────────────────────────────────────────────────────────

test('captureFromLog links a pane log to its rollout', () => {
  const id = '019fa7e4-0ce2-7fd2';
  const home = fakeHome(id, [tokenCount(TOTALS)]);
  const p = writeLog(tmp(), `[1msession id:[0m ${id}\n`);
  const got = captureFromLog(p, home);
  assert.equal(got.sessionId, id);
  assert.equal(got.usage.cacheRead, 218195712);
});

test('an unlinkable agent yields null at every stage', () => {
  // Each of these is a real situation — a run that died before the banner, a
  // rollout Codex never wrote, a session pruned since. All must decline.
  const home = fakeHome('present-id', [tokenCount({ input_tokens: 1 })]);
  assert.equal(captureFromLog(writeLog(tmp(), 'no banner\n'), home), null);
  assert.equal(captureFromLog(writeLog(tmp(), 'session id: absent-id\n'), home), null);
});

// ── the model, which is what makes the usage priceable ───────────────────────

test('the model comes from the rollout, not the launch config', () => {
  // `agent.model` for a Codex agent is the literal string "codex" — the CLI
  // name. Pricing on that yields nothing, so this capture would produce tokens
  // with no cost attached, which is most of the point of collecting them.
  const p = writeLog(tmp(), [
    JSON.stringify({ type: 'turn_context', payload: { type: 'turn_context', model: 'gpt-5.6-sol' } }),
    tokenCount({ input_tokens: 100, output_tokens: 10 }),
  ].join('\n'));
  assert.equal(parseRollout(p).model, 'gpt-5.6-sol');
});

test('a rollout with no turn_context reports a null model rather than inventing one', () => {
  const p = writeLog(tmp(), tokenCount({ input_tokens: 1 }));
  assert.equal(parseRollout(p).model, null);
});

test('the last turn_context wins if the model changed mid-session', () => {
  const p = writeLog(tmp(), [
    JSON.stringify({ type: 'turn_context', payload: { type: 'turn_context', model: 'gpt-5.6-terra' } }),
    JSON.stringify({ type: 'turn_context', payload: { type: 'turn_context', model: 'gpt-5.6-sol' } }),
    tokenCount({ input_tokens: 1 }),
  ].join('\n'));
  assert.equal(parseRollout(p).model, 'gpt-5.6-sol');
});
