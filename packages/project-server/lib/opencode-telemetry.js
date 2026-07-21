'use strict';

// OpenCode run telemetry (FU-1 — docs/plans/usage-monitoring-and-opencode-telemetry.md).
// `opencode run --format json` streams NDJSON events (verified 2026-07-20,
// opencode 1.18.x): step_start / text / step_finish, each carrying sessionID;
// step_finish adds part.tokens{input,output,reasoning,cache{read,write}} and
// part.cost (real OpenRouter USD charges — not TOKEN_COSTS estimates). The
// launch path tees the stream to <window>-<wfid>.events.jsonl; on completion
// we sum it into the existing agent.tokenUsage shape so the standard badge
// lights up unchanged, and resolve the ACTUAL serving model (e.g. behind
// openrouter/auto) from the session export.

const fs = require('fs');
const { execFile } = require('child_process');

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Parse an events.jsonl file. Returns null when the file is missing or has no
 * usable events; otherwise `{ sessionId, steps, inputTokens, outputTokens,
 * reasoningTokens, cacheRead, cacheCreate, costUSD }` (steps = step_finish
 * count — 0 when the run died before its first step completed).
 */
function parseEventsFile(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_) { return null; }
  let sessionId = null;
  let steps = 0;
  let input = 0, output = 0, reasoning = 0, cacheRead = 0, cacheCreate = 0, cost = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let e;
    try { e = JSON.parse(t); } catch (_) { continue; }
    if (!sessionId && typeof e.sessionID === 'string' && e.sessionID) sessionId = e.sessionID;
    if (e.type !== 'step_finish') continue;
    const part = e.part || {};
    const tok = part.tokens || {};
    input += num(tok.input);
    output += num(tok.output);
    reasoning += num(tok.reasoning);
    cacheRead += num(tok.cache && tok.cache.read);
    cacheCreate += num(tok.cache && tok.cache.write);
    cost += num(part.cost);
    steps++;
  }
  if (!sessionId && steps === 0) return null;
  return {
    sessionId,
    steps,
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cacheRead,
    cacheCreate,
    costUSD: Math.round(cost * 10000) / 10000,
  };
}

/**
 * Harvest an agent's events file: fill agent.tokenUsage with the existing
 * badge shape (reasoning folds into output — that's how it's billed). Returns
 * the run's sessionId (for async model resolution), or null when nothing was
 * parsed. Never clobbers an existing tokenUsage with empty data.
 */
function captureFromEvents(agent, eventsFile) {
  const parsed = parseEventsFile(eventsFile);
  if (!parsed) return null;
  if (parsed.steps > 0) {
    agent.tokenUsage = {
      inputTokens: parsed.inputTokens,
      outputTokens: parsed.outputTokens + parsed.reasoningTokens,
      cacheCreate: parsed.cacheCreate,
      cacheRead: parsed.cacheRead,
      costUSD: parsed.costUSD,
    };
  }
  return parsed.sessionId;
}

/**
 * Extract the actual serving model from an `opencode export` payload.
 * Assistant messages carry info.model{ID,providerID} (and/or bare info.modelID);
 * the LAST assistant message reflects the final routing (auto may switch
 * mid-run). Joins provider/model when the id itself is unscoped.
 */
function modelFromExport(exportJson) {
  const messages = Array.isArray(exportJson?.messages) ? exportJson.messages : [];
  let last = null;
  for (const m of messages) {
    const info = m?.info || {};
    if (info.role !== 'assistant') continue;
    const id = info?.model?.modelID || info.modelID || null;
    const provider = info?.model?.providerID || info.providerID || null;
    if (id) last = { id, provider };
  }
  if (!last) return null;
  return last.provider && !last.id.includes('/') ? `${last.provider}/${last.id}` : last.id;
}

/**
 * Best-effort actual-model resolution via `opencode export <sessionId>`
 * (local sqlite read, no network). Resolves null on any failure — callers
 * fall back to the configured model string.
 */
function resolveActualModel(sessionId, { timeoutMs = 15000, execFileImpl = execFile } = {}) {
  return new Promise((resolve) => {
    if (!sessionId) return resolve(null);
    try {
      execFileImpl('opencode', ['export', sessionId], { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
        if (err) return resolve(null);
        try {
          resolve(modelFromExport(JSON.parse(stdout)));
        } catch (_) {
          resolve(null);
        }
      });
    } catch (_) {
      resolve(null);
    }
  });
}

module.exports = { parseEventsFile, captureFromEvents, modelFromExport, resolveActualModel };
