'use strict';

/**
 * A decision layer with the System One shape: state in, typed answers with
 * probabilities out. See docs/plans/calibrated-decisions-over-agent-text.md.
 *
 * The engine's judgements about agent text are regular expressions, and an
 * agent is a writer, not a serializer. This layer asks the same questions in
 * words and records a calibrated answer beside the existing one.
 *
 * THREE RULES, all from the plan:
 *
 *  1. OFF unless configured. Build Studio must run without it: no config, no
 *     key, or a project that opted out means nothing is called and nothing new
 *     is loaded.
 *  2. SHADOW ONLY. Nothing here changes what the engine does. Answers are
 *     logged beside the existing logic's answer; acting on a probability waits
 *     until its calibration has been measured on these questions.
 *  3. FAILS OPEN. A provider that is down, slow or refusing returns null, and
 *     the failure is logged once per kind rather than once per call.
 *
 * Config (installation-wide, ~/.build-studio/config.json):
 *
 *   "decisions": { "enabled": true, "provider": "openrouter", "model": "typesafe/jev-1.13" }
 *
 * A project opts out in its .build-studio/config.yaml:
 *
 *   decisions:
 *     enabled: false
 *
 * The model is PINNED by default, not `~typesafe/jev-latest`: the shadow log is
 * a calibration dataset, and an alias would change the model under it.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_PROVIDER = 'openrouter';
const DEFAULT_MODEL = 'typesafe/jev-1.13';
const OPENROUTER_DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const DEFAULT_TIMEOUT_MS = 8000;
// Jev's state limit is 32k tokens. Characters are a cheap, conservative proxy;
// the plan asks for the NARROWEST state anyway (irrelevant state costs accuracy).
const MAX_STATE_CHARS = 24000;
const SHADOW_LOG = 'shadow.jsonl';

/**
 * The effective decisions config for one project, or null when it is off.
 *
 * @param {object|null} hub      the installation-wide config (loadHubConfig())
 * @param {object|null} project  the project's raw config
 */
function resolveDecisionsConfig(hub, project) {
  const g = hub && hub.decisions;
  if (!g || g.enabled !== true) return null;
  const p = (project && project.decisions) || {};
  if (p.enabled === false) return null;
  const provider = p.provider || g.provider || DEFAULT_PROVIDER;
  if (provider !== 'openrouter') {
    warnOnce(`provider:${provider}`, `[decide] unknown provider "${provider}" — decisions disabled`);
    return null;
  }
  return {
    provider,
    model: p.model || g.model || DEFAULT_MODEL,
    timeoutMs: Number(g.timeout_ms) > 0 ? Number(g.timeout_ms) : DEFAULT_TIMEOUT_MS,
  };
}

// ── failure logging: once per kind ──────────────────────────────────────────

const warned = new Set();
function warnOnce(kind, message) {
  if (warned.has(kind)) return;
  warned.add(kind);
  console.warn(message);
}
function resetWarningsForTests() { warned.clear(); }

// ── provider: OpenRouter's decisions endpoint ───────────────────────────────

/**
 * Ask OpenRouter. Its decisions endpoint takes Jev's own request shape and
 * returns Jev's typed answers, probabilities and confidence unchanged.
 *
 * The endpoint path is /api/alpha/: its shape may change. Everything that
 * depends on it is in this function.
 */
async function askOpenRouter({ key, model, state, questions, timeoutMs, fetchImpl }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(OPENROUTER_DECISIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, state, questions }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch (_) { /* best effort */ }
      throw Object.assign(new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`), { kind: `http-${res.status}` });
    }
    return await res.json();
  } catch (e) {
    if (e && e.name === 'AbortError') throw Object.assign(new Error(`timed out after ${timeoutMs} ms`), { kind: 'timeout' });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** One answer, in a shape that does not depend on the question type. */
function normalizeAnswer(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.type === 'noul') return { type: 'noul', value: a.noul, p: a.noul };
  if (a.type === 'choice') return { type: 'choice', value: a.choice, confidence: a.confidence, probabilities: a.probabilities };
  if (a.type === 'score') return { type: 'score', value: a.score, confidence: a.confidence, probabilities: a.probabilities };
  return { type: a.type || 'unknown', raw: a };
}

/**
 * Ask the configured provider. Never throws.
 *
 * @returns {Promise<null | {answers: object, model: string, latencyMs: number, usage: object|null}>}
 */
async function decide({ state, questions }, { config, key, fetchImpl = globalThis.fetch } = {}) {
  if (!config || !key || typeof fetchImpl !== 'function') return null;
  const started = Date.now();
  try {
    const body = await askOpenRouter({
      key, model: config.model, state: clampState(state), questions,
      timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS, fetchImpl,
    });
    const answers = {};
    for (const [k, a] of Object.entries((body && body.answers) || {})) answers[k] = normalizeAnswer(a);
    return { answers, model: (body && body.model) || config.model, latencyMs: Date.now() - started, usage: (body && body.usage) || null };
  } catch (e) {
    warnOnce(`fail:${(e && e.kind) || 'error'}`, `[decide] provider call failed (${(e && e.message) || e}) — continuing without it; further failures of this kind are not logged`);
    return null;
  }
}

function clampState(state) {
  if (typeof state !== 'string') return state;
  return state.length > MAX_STATE_CHARS ? state.slice(-MAX_STATE_CHARS) : state;
}

// ── language, for measuring calibration per language ────────────────────────

const SV = /\b(och|att|det|som|är|för|inte|med|på|jag|vi|kan|ska|har|eller|när|också|från)\b/gi;
const EN = /\b(the|and|that|is|for|not|with|on|was|are|this|have|or|when|also|from)\b/gi;

/**
 * 'sv', 'en' or 'unknown', from stopword counts and å/ä/ö. Deliberately crude:
 * it only has to split the shadow log so calibration can be compared per
 * language, and agent reports are long enough for stopwords to dominate.
 */
function detectLanguage(text) {
  const s = String(text || '');
  const sv = (s.match(SV) || []).length + (s.match(/[åäöÅÄÖ]/g) || []).length / 4;
  const en = (s.match(EN) || []).length;
  if (sv + en < 5) return 'unknown';
  if (sv > en * 1.5) return 'sv';
  if (en > sv * 1.5) return 'en';
  return 'unknown';
}

// ── shadow mode ─────────────────────────────────────────────────────────────

/**
 * Ask in the background and record both answers. Fire-and-forget: the caller
 * does not wait, and nothing the caller does depends on the result.
 *
 * The record keeps the STATE, so every answer can be reproduced offline. It is
 * written under ~/.build-studio, never into a managed project: a log in the
 * repo would need a .gitignore change in every project, and a modified
 * .gitignore blocks the next execution run.
 *
 * @param {string} point     decision point id, e.g. 'gate_blocked'
 * @param {object} payload   { state, questions, existing, meta }
 * @param {object} ctx       { config, key, logDir, fetchImpl, now }
 * @returns {Promise<object|null>} the record written (tests await it)
 */
async function shadow(point, { state, questions, existing, meta = {} }, ctx = {}) {
  if (!ctx.config || !ctx.key) return null;
  const result = await decide({ state, questions }, ctx);
  if (!result) return null;
  const stateText = typeof state === 'string' ? state : JSON.stringify(state);
  const record = {
    at: new Date(ctx.now ? ctx.now() : Date.now()).toISOString(),
    point,
    ...meta,
    existing,
    answers: result.answers,
    model: result.model,
    latencyMs: result.latencyMs,
    usage: result.usage,
    lang: detectLanguage(stateText),
    questions,
    state: clampState(state),
  };
  try {
    fs.mkdirSync(ctx.logDir, { recursive: true });
    fs.appendFileSync(path.join(ctx.logDir, SHADOW_LOG), JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    warnOnce('log', `[decide] could not write the shadow log: ${e.message}`);
  }
  return record;
}

module.exports = {
  DEFAULT_MODEL,
  OPENROUTER_DECISIONS_URL,
  SHADOW_LOG,
  resolveDecisionsConfig,
  decide,
  shadow,
  detectLanguage,
  normalizeAnswer,
  resetWarningsForTests,
};
