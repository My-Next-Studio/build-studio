'use strict';

// OpenCode model catalog: the `opencode models` list + per-model effort
// variants from models.dev (reasoning_options[type=effort].values). Shared
// between the hub (global Model tab — global cache) and project-servers
// (project Agents tab — per-project cache). Parse functions are pure and
// unit-tested; fetch effects are injectable.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BUILD_STUDIO_DIR } = require('./constants');

const CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MODELS_DEV_URL = 'https://models.dev/api.json';
const GLOBAL_CACHE_PATH = path.join(BUILD_STUDIO_DIR, 'opencode-catalog-cache.json');

// `opencode models` prints one id per line (verified 2026-07-20, opencode
// 1.18.x). Ids are provider/model, but OpenRouter entries are THREE segments
// (openrouter/<author>/<model>, e.g. openrouter/moonshotai/kimi-k3, and
// tilde-author aliases like openrouter/~anthropic/claude-fable-latest) — the
// pattern must accept one OR MORE path segments. (A single-segment-only
// version of this regex silently collapsed the 342-model list to the 6
// one-segment opencode/* entries.) Parse strictly; if a future opencode
// changes the format and nothing matches, fall back to raw non-empty token
// lines so pickers degrade to odd entries instead of going empty silently.
function parseOpencodeModelsOutput(out) {
  const lines = String(out || '').split('\n').map(l => l.trim()).filter(Boolean);
  const strict = lines.filter(l => /^[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~:-]+)+$/.test(l));
  return strict.length > 0 ? strict : lines.filter(l => !/\s/.test(l));
}

// models.dev api.json → { 'provider/model': ['low','high',…] } for every model
// exposing reasoning_options[type=effort].values — the variants opencode's
// --variant accepts.
function parseModelEfforts(apiJson) {
  const out = {};
  for (const [provider, pdata] of Object.entries(apiJson || {})) {
    const models = pdata && pdata.models;
    if (!models || typeof models !== 'object') continue;
    for (const [id, m] of Object.entries(models)) {
      const opts = Array.isArray(m?.reasoning_options) ? m.reasoning_options : [];
      const eff = opts.find(o => o && o.type === 'effort' && Array.isArray(o.values) && o.values.length > 0);
      if (eff) out[`${provider}/${id}`] = eff.values.filter(v => typeof v === 'string');
    }
  }
  return out;
}

// Same env as the agent start scripts (zsh + brew shellenv) so a GUI-launched
// process finds the binary too.
function fetchOpencodeModels({ execImpl = execFileSync, timeoutMs = 30000 } = {}) {
  const out = execImpl(
    'zsh',
    ['-c', 'eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null; opencode models'],
    { stdio: 'pipe', timeout: timeoutMs, encoding: 'utf8' }
  );
  return parseOpencodeModelsOutput(out);
}

async function fetchModelEfforts({ fetchImpl, timeoutMs = 30000 } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const res = await f(MODELS_DEV_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
  const apiJson = await res.json();
  return {
    efforts: parseModelEfforts(apiJson),
    contexts: parseModelContexts(apiJson),
    openaiModels: parseProviderModelIds(apiJson, 'openai'),
    anthropicModels: parseProviderModelIds(apiJson, 'anthropic'),
  };
}

// Model ids of one provider in models.dev's api.json — used for the codex and
// claude model pickers. Neither CLI has a `models` command (unlike opencode),
// so models.dev's openai/anthropic providers are the closest public list of
// slugs they accept. Both resolve through `MODEL_IDS[v] || v`, so a raw id
// discovered here passes straight to --model.
function parseProviderModelIds(apiJson, provider) {
  const models = apiJson?.[provider]?.models;
  if (!models || typeof models !== 'object') return [];
  return Object.keys(models);
}

// models.dev api.json → { 'provider/model': contextWindowTokens }. Mirrors
// parseModelEfforts; the claude picker uses it to decide which ids get a
// synthesized `[1m]` variant.
function parseModelContexts(apiJson) {
  const out = {};
  for (const [provider, pdata] of Object.entries(apiJson || {})) {
    const models = pdata && pdata.models;
    if (!models || typeof models !== 'object') continue;
    for (const [id, m] of Object.entries(models)) {
      const ctx = m && m.limit && m.limit.context;
      if (typeof ctx === 'number') out[`${provider}/${id}`] = ctx;
    }
  }
  return out;
}

function readCatalogCache(cachePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (raw && raw.fetchedAt && Array.isArray(raw.models)) return raw;
  } catch (_) {}
  return null;
}

// Does a cache payload carry every field the current code reads? A cache
// written by an older build satisfies the TTL check but has `undefined` where
// a newly-added field should be, so callers silently serve empty lists for up
// to a full TTL window after an upgrade — which is exactly how the claude
// picker fell back to its static list after `anthropicModels` was introduced.
// Missing fields make a payload unusable as a FRESH read, but it stays good
// enough as the degraded fallback when a refresh can't reach the network.
function isCurrentCatalogSchema(raw) {
  return !!raw
    && Array.isArray(raw.models)
    && Array.isArray(raw.openaiModels)
    && Array.isArray(raw.anthropicModels)
    && !!raw.efforts
    && !!raw.contexts;
}

function writeCatalogCache(cachePath, payload) {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(payload), 'utf8');
  } catch (_) {}
}

/**
 * The full catalog { models, efforts, fetchedAt, cached, stale? }.
 * Cache-first within the TTL; on refresh failure falls back to a stale cache
 * (never hard-fails the pickers). Partial tolerance: if one source fails the
 * other's fresh data is still returned, with the failed half from cache/empty.
 */
async function getCatalog({ cachePath = GLOBAL_CACHE_PATH, ttlMs = CATALOG_CACHE_TTL_MS, refresh = false, execImpl, fetchImpl } = {}) {
  const cached = readCatalogCache(cachePath);
  // An upgrade that adds a field must not be served stale-empty from a cache
  // written before that field existed — schema mismatch forces a refetch even
  // inside the TTL. The old payload is still kept as the failure fallback below.
  if (!refresh && cached && isCurrentCatalogSchema(cached)
      && Date.now() - new Date(cached.fetchedAt).getTime() < ttlMs) {
    return { ...cached, cached: true };
  }
  const [modelsR, effortsR] = await Promise.allSettled([
    Promise.resolve().then(() => fetchOpencodeModels({ execImpl })),
    fetchModelEfforts({ fetchImpl }),
  ]);
  if (modelsR.status === 'rejected' && effortsR.status === 'rejected') {
    if (cached) return { ...cached, cached: true, stale: true, warning: `catalog refresh failed: ${modelsR.reason?.message || 'unknown'}` };
    throw modelsR.reason || new Error('catalog refresh failed');
  }
  const fresh = effortsR.status === 'fulfilled' ? effortsR.value : null;
  const payload = {
    fetchedAt: new Date().toISOString(),
    models: modelsR.status === 'fulfilled' ? modelsR.value : (cached?.models || []),
    efforts: fresh ? fresh.efforts : (cached?.efforts || {}),
    contexts: fresh ? fresh.contexts : (cached?.contexts || {}),
    openaiModels: fresh ? fresh.openaiModels : (cached?.openaiModels || []),
    anthropicModels: fresh ? fresh.anthropicModels : (cached?.anthropicModels || []),
  };
  writeCatalogCache(cachePath, payload);
  return { ...payload, cached: false, ...(modelsR.status === 'rejected' || effortsR.status === 'rejected' ? { stale: true } : {}) };
}

module.exports = {
  parseOpencodeModelsOutput,
  parseModelEfforts,
  parseModelContexts,
  parseProviderModelIds,
  fetchOpencodeModels,
  fetchModelEfforts,
  getCatalog,
  readCatalogCache,
  isCurrentCatalogSchema,
  CATALOG_CACHE_TTL_MS,
  GLOBAL_CACHE_PATH,
};
