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
  return { efforts: parseModelEfforts(apiJson), openaiModels: parseProviderModelIds(apiJson, 'openai') };
}

// Model ids of one provider in models.dev's api.json — used for the codex
// model picker (the codex CLI has no `models` command; models.dev's openai
// provider is the closest public list of slugs it accepts).
function parseProviderModelIds(apiJson, provider) {
  const models = apiJson?.[provider]?.models;
  if (!models || typeof models !== 'object') return [];
  return Object.keys(models);
}

function readCatalogCache(cachePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (raw && raw.fetchedAt && Array.isArray(raw.models)) return raw;
  } catch (_) {}
  return null;
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
  if (!refresh && cached && Date.now() - new Date(cached.fetchedAt).getTime() < ttlMs) {
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
  const payload = {
    fetchedAt: new Date().toISOString(),
    models: modelsR.status === 'fulfilled' ? modelsR.value : (cached?.models || []),
    efforts: effortsR.status === 'fulfilled' ? effortsR.value.efforts : (cached?.efforts || {}),
    openaiModels: effortsR.status === 'fulfilled' ? effortsR.value.openaiModels : (cached?.openaiModels || []),
  };
  writeCatalogCache(cachePath, payload);
  return { ...payload, cached: false, ...(modelsR.status === 'rejected' || effortsR.status === 'rejected' ? { stale: true } : {}) };
}

module.exports = {
  parseOpencodeModelsOutput,
  parseModelEfforts,
  parseProviderModelIds,
  fetchOpencodeModels,
  fetchModelEfforts,
  getCatalog,
  readCatalogCache,
  CATALOG_CACHE_TTL_MS,
  GLOBAL_CACHE_PATH,
};
