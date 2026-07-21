// Per-project agent-CLI settings API + installation-wide CLI availability.
//
// GET  /api/config/cli        → effective cli block + where each value comes
//                               from (config.yaml vs local.json) + which CLIs
//                               are enabled installation-wide + detected bins.
// PUT  /api/config/cli        → write hub-edited cli settings to
//                               .build-studio/local.json (NEVER config.yaml —
//                               hand-maintained comments must survive), then
//                               hot-reload the live config object.
// GET  /api/opencode/models   → `opencode models` output (provider/model per
//                               line), disk-cached; ?refresh=1 re-fetches.
// GET  /api/opencode/model-efforts → per-model effort variants from models.dev
//                               (reasoning_options[type=effort].values), disk-
//                               cached; powers the effort dropdowns.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadLocalOverrides, saveLocalOverrides, reloadConfig } = require('../config');
const {
  VALID_CLIS, resolveEnabledClis, detectClis, isValidEffortToken,
  loadHubConfig, hasGlobalCliDefaults, normalizeCliBlock,
} = require('@build-studio/shared/cli');
const { parseOpencodeModelsOutput, parseModelEfforts } = require('@build-studio/shared/opencode-catalog');

const MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MODELS_DEV_URL = 'https://models.dev/api.json';

function createCliConfigRouter(config) {
  const router = express.Router();
  const projectRoot = config.projectRoot;

  function modelsCachePath() {
    return path.join(projectRoot, '.build-studio', 'opencode-models-cache.json');
  }
  function effortsCachePath() {
    return path.join(projectRoot, '.build-studio', 'opencode-model-efforts-cache.json');
  }

  function readJsonCache(p) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (raw && raw.fetchedAt) return raw;
    } catch (_) {}
    return null;
  }

  function readModelsCache() {
    const raw = readJsonCache(modelsCachePath());
    return raw && Array.isArray(raw.models) ? raw : null;
  }
  function readEffortsCache() {
    const raw = readJsonCache(effortsCachePath());
    return raw && raw.efforts && typeof raw.efforts === 'object' ? raw : null;
  }

  function fetchOpencodeModels() {
    // Same env as the start scripts (zsh + brew shellenv) so a GUI-launched
    // project-server finds the binary too.
    const out = execFileSync(
      'zsh',
      ['-c', 'eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null; opencode models'],
      { stdio: 'pipe', timeout: 30000, encoding: 'utf8' }
    );
    const models = parseOpencodeModelsOutput(out);
    const payload = { fetchedAt: new Date().toISOString(), models };
    try { fs.writeFileSync(modelsCachePath(), JSON.stringify(payload, null, 2), 'utf8'); } catch (_) {}
    return payload;
  }

  // Per-model effort variants from models.dev (the same catalog opencode
  // consumes). ~3MB JSON; cached 24h with stale fallback, same as the model list.
  async function fetchModelEfforts() {
    const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`);
    const payload = { fetchedAt: new Date().toISOString(), efforts: parseModelEfforts(await res.json()) };
    try { fs.writeFileSync(effortsCachePath(), JSON.stringify(payload), 'utf8'); } catch (_) {}
    return payload;
  }

  router.get('/config/cli', (req, res) => {
    const local = loadLocalOverrides(projectRoot);
    const detected = detectClis();
    const globalRaw = loadHubConfig().cli;
    res.json({
      cli: config.cli,
      // use_global mode: config.cli IS the global block (config.js swapped it
      // at load). The project's own values stay in sources.local for when the
      // toggle switches off.
      use_global: config.cli.use_global === true,
      global_cli: hasGlobalCliDefaults(globalRaw) ? normalizeCliBlock(globalRaw) : null,
      sources: {
        // What each layer contributes — the hub shows local.json values as
        // "set here" and yaml-only values as inherited from config.yaml.
        local: local.cli || {},
        configYamlComment: 'Values may also be set via a cli: block in config.yaml; local.json wins.',
      },
      valid_clis: VALID_CLIS,
      enabled_clis: resolveEnabledClis(),
      detected_clis: Object.fromEntries(Object.entries(detected).map(([k, v]) => [k, !!v])),
    });
  });

  router.put('/config/cli', (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (body.default !== undefined) {
      if (!VALID_CLIS.includes(body.default)) {
        return res.status(400).json({ error: `default must be one of ${VALID_CLIS.join(', ')}` });
      }
      patch.default = body.default;
    }
    for (const key of ['developer_cli', 'reviewer_cli']) {
      if (body[key] !== undefined) {
        if (body[key] !== null && !VALID_CLIS.includes(body[key])) {
          return res.status(400).json({ error: `${key} must be one of ${VALID_CLIS.join(', ')} or null` });
        }
        patch[key] = body[key] || null;
      }
    }
    if (body.use_global !== undefined) {
      if (typeof body.use_global !== 'boolean') {
        return res.status(400).json({ error: 'use_global must be a boolean' });
      }
      patch.use_global = body.use_global;
    }
    for (const key of ['default_model', 'developer_model', 'reviewer_model']) {
      if (body[key] !== undefined) {
        if (body[key] !== null && typeof body[key] !== 'string') {
          return res.status(400).json({ error: `${key} must be a string (provider/model) or null` });
        }
        patch[key] = body[key] || null;
      }
    }
    for (const key of ['default_effort', 'developer_effort', 'reviewer_effort']) {
      if (body[key] !== undefined) {
        // null clears; otherwise must be a shell-safe effort token (it lands on
        // the opencode command line as --variant <value>)
        if (body[key] !== null && !isValidEffortToken(body[key])) {
          return res.status(400).json({ error: `${key} must be an effort token (e.g. low, high, max) or null` });
        }
        patch[key] = body[key] || null;
      }
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: 'No cli settings in body — expected default / use_global / developer_cli / reviewer_cli / default_model / developer_model / reviewer_model / default_effort / developer_effort / reviewer_effort' });
    }
    saveLocalOverrides(projectRoot, { cli: patch });
    try {
      reloadConfig(config);
    } catch (e) {
      return res.status(500).json({ error: `Saved but hot-reload failed (restart the project server): ${e.message}` });
    }
    const globalRaw = loadHubConfig().cli;
    res.json({
      cli: config.cli,
      use_global: config.cli.use_global === true,
      global_cli: hasGlobalCliDefaults(globalRaw) ? normalizeCliBlock(globalRaw) : null,
      local: loadLocalOverrides(projectRoot).cli || {},
    });
  });

  router.get('/opencode/models', (req, res) => {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    if (!refresh) {
      const cached = readModelsCache();
      if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < MODELS_CACHE_TTL_MS) {
        return res.json({ ...cached, cached: true });
      }
    }
    try {
      const payload = fetchOpencodeModels();
      return res.json({ ...payload, cached: false });
    } catch (e) {
      // Fall back to a stale cache rather than hard-failing the picker.
      const stale = readModelsCache();
      if (stale) return res.json({ ...stale, cached: true, stale: true, warning: `opencode models failed: ${e.message}` });
      return res.status(502).json({ error: `Failed to list opencode models: ${e.message}`, models: [] });
    }
  });

  // Per-model effort variant options for the effort dropdowns — same cache +
  // stale-fallback pattern as the model list.
  router.get('/opencode/model-efforts', async (req, res) => {
    const refresh = req.query.refresh === '1' || req.query.refresh === 'true';
    if (!refresh) {
      const cached = readEffortsCache();
      if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < MODELS_CACHE_TTL_MS) {
        return res.json({ ...cached, cached: true });
      }
    }
    try {
      const payload = await fetchModelEfforts();
      return res.json({ ...payload, cached: false });
    } catch (e) {
      const stale = readEffortsCache();
      if (stale) return res.json({ ...stale, cached: true, stale: true, warning: `models.dev fetch failed: ${e.message}` });
      return res.status(502).json({ error: `Failed to fetch model efforts: ${e.message}`, efforts: {} });
    }
  });

  return router;
}

module.exports = { createCliConfigRouter, parseModelEfforts };