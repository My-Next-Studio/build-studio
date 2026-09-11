'use strict';

const { MODEL_IDS } = require('@build-studio/shared/cli');

/**
 * What a run cost, per model — or an honest null.
 *
 * The table this replaces had two keys, `opus` and `sonnet`, holding Opus 4.x
 * prices, and resolved with `TOKEN_COSTS[model] || TOKEN_COSTS.sonnet`. Every
 * model id in actual use — `claude-opus-5[1m]`, `gpt-5.6-sol`,
 * `openrouter/x-ai/grok-4.6` — matched neither key, so every agent in every
 * project was silently priced at Sonnet 4.x rates. Measured on one execution
 * run, that understated the true figure by roughly 1.7x, and it named a model
 * that had not been used at all.
 *
 * Two rules follow from that, and they are the whole design:
 *
 * 1. **An unknown model prices to null, never to a default.** A blank cell is
 *    recoverable; a confident wrong number is what made the previous accounting
 *    worthless and went unnoticed for months. Nothing here falls back.
 *
 * 2. **Cache reads are their own rate.** This workload is cache-read dominated
 *    — a measured execution run showed 28.4M cache-read tokens against 173K of
 *    output, a ratio near 200:1. A table without a cache-read column is not
 *    approximately right, it is wrong by two orders of magnitude on the term
 *    that dominates.
 *
 * Rates are USD per million tokens, from each provider's published pricing.
 * They are STATIC by choice: a runtime fetch would put a network dependency in
 * the completion path, and prices that silently change under recorded history
 * make old runs unreproducible. When a price moves, add a new entry.
 */

/** @typedef {{input:number, output:number, cacheRead:number, cacheWrite:number}} Rate */

const M = 1_000_000;

/**
 * Per-million-token rates. Keys are matched case-insensitively against the
 * model id after normalisation (see `normalizeModelId`).
 *
 * `cacheWrite: 0` where a provider does not bill cache writes separately.
 */
const RATES = {
  // ── Anthropic ──────────────────────────────────────────────────────────
  'claude-opus-5':    { input: 5,  output: 25, cacheRead: 0.5,  cacheWrite: 6.25 },
  'claude-opus-4-8':  { input: 5,  output: 25, cacheRead: 0.5,  cacheWrite: 6.25 },
  'claude-opus-4-7':  { input: 5,  output: 25, cacheRead: 0.5,  cacheWrite: 6.25 },
  'claude-sonnet-5':  { input: 3,  output: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-sonnet-4-6':{ input: 3,  output: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-fable-5':   { input: 3,  output: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-haiku-4-5': { input: 1,  output: 5,  cacheRead: 0.1,  cacheWrite: 1.25 },

  // ── OpenAI (Codex) ─────────────────────────────────────────────────────
  'gpt-5.6-sol':      { input: 4,  output: 20, cacheRead: 0.4,  cacheWrite: 5 },
  'gpt-5.6-terra':    { input: 4,  output: 20, cacheRead: 0.4,  cacheWrite: 5 },

  // ── OpenRouter-served ──────────────────────────────────────────────────
  'x-ai/grok-4.6':       { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
  'x-ai/grok-build-0.1': { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 0 },
};

/**
 * Reduce a model id to a table key.
 *
 * Handles the three shapes the engine actually stores:
 *   `claude-opus-5[1m]`        → `claude-opus-5`   (the 1M tier is priced the
 *                                                   same below 200K, and the
 *                                                   long-context premium is a
 *                                                   separate question — see
 *                                                   `longContext` below)
 *   `openrouter/x-ai/grok-4.6` → `x-ai/grok-4.6`   (drop the routing prefix)
 *   `claude-opus-5-20260514`   → `claude-opus-5`   (dated snapshot)
 *   `sonnet`                   → `claude-sonnet-5` (bare CLI alias)
 *
 * The bare alias is not an edge case — it is what the launcher stores whenever a
 * step runs on `agent_defaults.model`, which defaults to the literal 'opus'. So
 * a default-configured agent recorded `model: "sonnet"` / `"opus"`, found no
 * rate, and was priced null: measured 2026-09-11, eleven agents in one fazon run
 * carried real token counts with costUSD null. That is the telemetry reading as
 * "unmeasured" for the most ordinary configuration there is.
 *
 * MODEL_IDS (shared/cli.js) is the same alias table the launcher resolves
 * `--model` through, so pricing and launching now agree by construction rather
 * than by two hand-maintained lists.
 */
function normalizeModelId(model) {
  if (!model || typeof model !== 'string') return null;
  let id = model.trim().toLowerCase();
  if (!id) return null;
  // Alias first, and BEFORE the [1m] strip, since the table carries both
  // `opus` and `opus[1m]` forms.
  if (MODEL_IDS[id]) id = String(MODEL_IDS[id]).toLowerCase();
  id = id.replace(/\[1m\]$/, '');            // long-context suffix
  id = id.replace(/^openrouter\//, '');      // routing prefix
  if (RATES[id]) return id;
  const dated = id.replace(/-\d{8}$/, '');   // dated snapshot
  return RATES[dated] ? dated : id;
}

/** The rate for a model, or null when it is not in the table. */
function rateFor(model) {
  const id = normalizeModelId(model);
  return (id && RATES[id]) || null;
}

/**
 * Cost in USD, or **null** when the model is unpriced.
 *
 * Callers must render null as "not priced" rather than 0. Summing an unpriced
 * agent as zero is the same lie as pricing it wrongly, just quieter — it makes
 * a run look cheaper the less it is understood.
 *
 * @param {string} model
 * @param {{inputTokens?:number, outputTokens?:number, cacheRead?:number, cacheCreate?:number}} usage
 * @returns {number|null}
 */
function costUSD(model, usage) {
  const r = rateFor(model);
  if (!r || !usage) return null;
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const total =
    (n(usage.inputTokens) * r.input
      + n(usage.outputTokens) * r.output
      + n(usage.cacheRead) * r.cacheRead
      + n(usage.cacheCreate) * r.cacheWrite) / M;
  return Math.round(total * 10000) / 10000;
}

/** Model ids the table can price — for surfacing coverage gaps in a scorecard. */
function pricedModels() {
  return Object.keys(RATES).sort();
}

module.exports = { RATES, normalizeModelId, rateFor, costUSD, pricedModels };
