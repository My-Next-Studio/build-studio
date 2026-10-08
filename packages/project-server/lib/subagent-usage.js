'use strict';

/**
 * What the subagents of one Claude session did, and what they used.
 *
 * Claude Code keeps a subagent's transcript apart from its parent's, under
 * `<session id>/subagents/agent-<id>.jsonl` beside the parent's own
 * `<session id>.jsonl`, with a `.meta.json` that names its type and the task it
 * was given. Usage read from the parent transcript alone misses all of it.
 *
 * That gap matters most for an orchestrating builder (the lean execution
 * preset), whose subagents may do most of the work: read the parent only, and
 * a lean run looks cheaper than it was, which is the comparison the lean trial
 * exists to make. It also applies to any agent that fans out, such as a code
 * review using parallel subagents.
 *
 * Each subagent is priced at its own model, read from its transcript, since an
 * orchestrator may pick a cheaper model for routine parts. A model with no
 * rate prices to null, and so does the total it would have been part of.
 */

const fs = require('fs');
const path = require('path');

/** At most this many subagents are listed per agent; the totals count all. */
const MAX_LISTED = 50;

const WINDOW_SLACK_MS = 5000;

/**
 * Sum one subagent transcript within [startMs, endMs].
 * Returns null when it has no usage in the window.
 */
function readSubagentTranscript(file, startMs, endMs) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const t = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0 };
  let model = null;
  let first = null;
  let last = null;
  let found = false;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
    if (Number.isFinite(ts) && (ts < startMs - WINDOW_SLACK_MS || ts > endMs + WINDOW_SLACK_MS)) continue;
    if (Number.isFinite(ts)) {
      if (first === null || ts < first) first = ts;
      if (last === null || ts > last) last = ts;
    }
    const usage = rec.message && rec.message.usage;
    if (!usage) continue;
    if (rec.message.model) model = rec.message.model;
    t.inputTokens += usage.input_tokens || 0;
    t.outputTokens += usage.output_tokens || 0;
    t.cacheCreate += usage.cache_creation_input_tokens || 0;
    t.cacheRead += usage.cache_read_input_tokens || 0;
    found = true;
  }
  if (!found) return null;
  return {
    ...t,
    model,
    startedAt: first !== null ? new Date(first).toISOString() : null,
    completedAt: last !== null ? new Date(last).toISOString() : null,
  };
}

function readMeta(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { agentType: m.agentType || null, description: m.description || null };
  } catch (_) {
    return { agentType: null, description: null };
  }
}

/**
 * The subagents of the session whose transcripts live in `claudeDir`, used
 * within the window.
 *
 * @param {string} claudeDir  ~/.claude/projects/<cwd slug>
 * @param {string} sessionId  the parent session
 * @param {number} startMs
 * @param {number} endMs
 * @param {(model: string|null, tokens: object) => number|null} priceFn
 * @returns {null | {count:number, inputTokens:number, outputTokens:number,
 *   cacheRead:number, cacheCreate:number, costUSD:number|null, unpriced:number,
 *   models:string[], list:object[]}}  null when there were none.
 */
function subagentUsage(claudeDir, sessionId, startMs, endMs, priceFn) {
  if (!claudeDir || !sessionId) return null;
  const dir = path.join(claudeDir, sessionId, 'subagents');
  let files;
  try { files = fs.readdirSync(dir); } catch (_) { return null; }
  const out = {
    count: 0, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0,
    costUSD: 0, unpriced: 0, models: [], list: [],
  };
  const models = new Set();
  for (const f of files.filter((n) => /^agent-.+\.jsonl$/.test(n)).sort()) {
    const file = path.join(dir, f);
    try {
      if (fs.statSync(file).mtimeMs < startMs - WINDOW_SLACK_MS) continue;
    } catch (_) { continue; }
    const usage = readSubagentTranscript(file, startMs, endMs);
    if (!usage) continue;
    const meta = readMeta(file.replace(/\.jsonl$/, '.meta.json'));
    const tokens = {
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
      cacheRead: usage.cacheRead, cacheCreate: usage.cacheCreate,
    };
    const cost = priceFn ? priceFn(usage.model, tokens) : null;
    out.count += 1;
    out.inputTokens += tokens.inputTokens;
    out.outputTokens += tokens.outputTokens;
    out.cacheRead += tokens.cacheRead;
    out.cacheCreate += tokens.cacheCreate;
    if (typeof cost === 'number' && Number.isFinite(cost)) {
      if (out.costUSD !== null) out.costUSD += cost;
    } else {
      out.unpriced += 1;
      out.costUSD = null;
    }
    if (usage.model) models.add(usage.model);
    if (out.list.length < MAX_LISTED) {
      out.list.push({
        id: f.replace(/^agent-/, '').replace(/\.jsonl$/, ''),
        agentType: meta.agentType,
        description: meta.description,
        model: usage.model,
        startedAt: usage.startedAt,
        completedAt: usage.completedAt,
        ...tokens,
        costUSD: typeof cost === 'number' && Number.isFinite(cost) ? cost : null,
      });
    }
  }
  if (!out.count) return null;
  out.models = [...models].sort();
  return out;
}

/**
 * A parent's usage with its subagents' added in.
 *
 * Totals include the subagents; `subagents` keeps the breakdown. The cost is
 * null when either side is unpriced: a total that silently leaves out part of
 * the spend is the number this whole area keeps getting wrong.
 */
function withSubagents(parent, subs) {
  if (!subs) return parent;
  const base = parent || { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, costUSD: 0, model: null };
  const both = typeof base.costUSD === 'number' && typeof subs.costUSD === 'number';
  return {
    ...base,
    inputTokens: (base.inputTokens || 0) + subs.inputTokens,
    outputTokens: (base.outputTokens || 0) + subs.outputTokens,
    cacheRead: (base.cacheRead || 0) + subs.cacheRead,
    cacheCreate: (base.cacheCreate || 0) + subs.cacheCreate,
    costUSD: both ? base.costUSD + subs.costUSD : null,
    subagents: subs,
  };
}

module.exports = { subagentUsage, withSubagents, MAX_LISTED };
