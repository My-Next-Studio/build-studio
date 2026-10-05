'use strict';

/**
 * Codex run telemetry — the third CLI's token usage.
 *
 * Claude agents are measured from their transcript (pinned via `--session-id`)
 * and OpenCode from its NDJSON event stream. Codex had neither, so every Codex
 * agent reported no usage at all: `computeTokenUsage` returns null without a
 * session id, and only Claude gets one at launch.
 *
 * That blind spot is not evenly spread — it follows whichever roles a project
 * assigns to Codex. On this installation the monolithic builder runs on Codex
 * in several projects, so the single most expensive step in a run was the one
 * with no cost attached.
 *
 * WHY NOT PIN A SESSION ID AT LAUNCH, AS CLAUDE DOES
 *
 * `codex exec` has no flag to supply one (`resume`/`fork` take an existing id;
 * there is no `--session-id`). It does PRINT the id it chose, on a line of its
 * own, before doing any work — and the launcher already pipes the whole pane to
 * `<window>-<wfid>.log`. So the id is recoverable from a file we already keep,
 * which is why this reads the log rather than changing the launch command.
 *
 * WHY NOT MATCH BY TIME WINDOW
 *
 * Because that is exactly the bug this repo already paid for. Attributing usage
 * by "transcripts touched during the agent's window" charged each of six
 * concurrent reviewers for all six plus the owner's own terminal session, and
 * overstated one round by 4.3x. An id read from the agent's own output is the
 * only honest link; when it cannot be found, this returns null and the agent
 * reports no usage, which is the correct answer rather than a plausible one.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Codex writes rollouts under ~/.codex/sessions/<yyyy>/<mm>/<dd>/ and moves
 *  older ones to ~/.codex/archived_sessions/. Both are searched. */
function codexSessionRoots(home = os.homedir()) {
  return [path.join(home, '.codex', 'sessions'), path.join(home, '.codex', 'archived_sessions')];
}

/**
 * The session id Codex announced in its own output.
 *
 * The line is `session id: <uuid>`, wrapped in ANSI bold — the pane log keeps
 * the escapes, so they are stripped before matching. Scans only the head of the
 * file: the id is printed in the banner, and a long run's log is megabytes of
 * output we have no reason to read.
 */
function sessionIdFromLog(logPath, headBytes = 64 * 1024) {
  let head;
  try {
    const fd = fs.openSync(logPath, 'r');
    try {
      const buf = Buffer.alloc(headBytes);
      const n = fs.readSync(fd, buf, 0, headBytes, 0);
      head = buf.slice(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch (_) { return null; }
  // eslint-disable-next-line no-control-regex
  const plain = head.replace(/\[[0-9;]*m/g, '');
  const m = plain.match(/session id:\s*([0-9a-fA-F-]{8,})/i);
  return m ? m[1].toLowerCase() : null;
}

/** The rollout file for a session id, or null. Filenames end in the id. */
function findRolloutFile(sessionId, home = os.homedir()) {
  if (!sessionId) return null;
  const target = String(sessionId).toLowerCase();
  const stack = codexSessionRoots(home);
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (e.isFile() && e.name.endsWith('.jsonl') && e.name.toLowerCase().includes(target)) return full;
    }
  }
  return null;
}

/**
 * When the rollout was last written, as epoch ms, or null.
 *
 * Codex appends to its rollout as the model streams and as each tool call
 * returns, so this is the truest "last sign of life" for a `codex exec` agent,
 * whose pane log only changes when a command finishes. A rollout that has not
 * moved for many minutes after a `function_call_output` means codex sent the
 * model its tool result and has had nothing back.
 */
function rolloutLastWrittenMs(rolloutPath) {
  if (!rolloutPath) return null;
  try { return fs.statSync(rolloutPath).mtimeMs; } catch (_) { return null; }
}

/**
 * Token usage from a Codex rollout.
 *
 * Codex emits `event_msg` rows of type `token_count` carrying
 * `info.total_token_usage` — a RUNNING TOTAL for the session, not a delta. So
 * the last one wins; summing them would multiply the true figure by the number
 * of turns. (`last_token_usage` beside it is the per-turn delta, which is what
 * a naive "sum the usage events" reading would land on.)
 *
 * Field mapping into the shape the rest of the engine uses:
 *   input_tokens            total input INCLUDING cached reads
 *   cached_input_tokens     the cache-read part of it
 *   cache_write_input_tokens
 *   output_tokens           includes reasoning_output_tokens
 *
 * `inputTokens` is therefore reported NET of cached reads, matching what the
 * Claude reader stores, so the two are comparable in a scorecard rather than
 * one silently counting cache reads twice.
 *
 * @returns {null|{inputTokens,outputTokens,reasoningTokens,cacheRead,cacheCreate,totalTokens}}
 */
function parseRollout(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
  let latest = null;
  let model = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch (_) { continue; }
    const payload = e.payload || e;
    // The MODEL, from the rollout rather than from the launch config.
    //
    // `agent.model` for a Codex agent is the literal string "codex" — the CLI
    // name, not a model slug — so pricing it would always come back unpriced
    // and this whole capture would produce tokens with no cost. `turn_context`
    // carries the slug the run actually used (e.g. gpt-5.6-sol), which is also
    // the honest answer when a project's configured model differs from what
    // served the request.
    if (e.type === 'turn_context' || payload.type === 'turn_context') {
      const m = payload.model || (payload.info || {}).model || e.model;
      if (typeof m === 'string' && m) model = m;
    }
    if (payload.type !== 'token_count') continue;
    const total = (payload.info || {}).total_token_usage;
    if (total && typeof total === 'object') latest = total;
  }
  if (!latest) return null;
  const cacheRead = num(latest.cached_input_tokens);
  const rawInput = num(latest.input_tokens);
  return {
    inputTokens: Math.max(0, rawInput - cacheRead),
    outputTokens: num(latest.output_tokens),
    reasoningTokens: num(latest.reasoning_output_tokens),
    cacheRead,
    cacheCreate: num(latest.cache_write_input_tokens),
    totalTokens: num(latest.total_tokens),
    model,
  };
}

/**
 * Resolve an agent's usage from its pane log.
 *
 * Returns null — never a guess — when the id is unreadable or the rollout is
 * missing. A blank cell in a scorecard is recoverable; a confident wrong number
 * is what made the previous accounting worthless.
 *
 * @returns {null|{sessionId, usage}}
 */
function captureFromLog(logPath, home = os.homedir()) {
  const sessionId = sessionIdFromLog(logPath);
  if (!sessionId) return null;
  const rollout = findRolloutFile(sessionId, home);
  if (!rollout) return null;
  const usage = parseRollout(rollout);
  if (!usage) return null;
  return { sessionId, usage, rolloutPath: rollout };
}

module.exports = {
  sessionIdFromLog,
  findRolloutFile,
  rolloutLastWrittenMs,
  parseRollout,
  captureFromLog,
  codexSessionRoots,
};
