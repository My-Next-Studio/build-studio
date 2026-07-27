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
//                               line); ?refresh=1 re-fetches.
// GET  /api/opencode/model-efforts → per-model effort variants from models.dev
//                               (reasoning_options[type=effort].values).
// Both catalog routes are thin slices of the shared getCatalog, sharing one
// project-scoped cache file (.build-studio/cli-catalog-cache.json) with its
// TTL, schema-guard and stale-fallback behavior. The hub's own Agents/Model
// tab reads the installation-wide /api/cli-catalog instead; these remain for
// per-project callers.
const express = require('express');
const path = require('path');
const { loadLocalOverrides, saveLocalOverrides, reloadConfig } = require('../config');
const {
  VALID_CLIS, resolveEnabledClis, detectClis, isValidEffortToken,
  loadHubConfig, hasGlobalCliDefaults, normalizeCliBlock,
} = require('@build-studio/shared/cli');
const { getCatalog } = require('@build-studio/shared/opencode-catalog');

function createCliConfigRouter(config) {
  const router = express.Router();
  const projectRoot = config.projectRoot;

  // Both catalog routes below are backed by the SHARED getCatalog, just with a
  // project-scoped cache file. They used to hand-roll their own fetch + TTL +
  // stale-fallback logic across two cache files, which duplicated the shared
  // module and carried its own copy of every bug fixed there — including the
  // one where a cache written before a field existed still satisfied the TTL
  // and served that field as undefined for a full day after an upgrade.
  function catalogCachePath() {
    return path.join(projectRoot, '.build-studio', 'cli-catalog-cache.json');
  }
  function wantsRefresh(req) {
    return req.query.refresh === '1' || req.query.refresh === 'true';
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

  router.get('/opencode/models', async (req, res) => {
    try {
      const cat = await getCatalog({ cachePath: catalogCachePath(), refresh: wantsRefresh(req) });
      return res.json({
        fetchedAt: cat.fetchedAt,
        models: cat.models || [],
        cached: cat.cached,
        ...(cat.stale ? { stale: true, warning: cat.warning } : {}),
      });
    } catch (e) {
      return res.status(502).json({ error: `Failed to list opencode models: ${e.message}`, models: [] });
    }
  });

  // Per-model effort variant options for the effort dropdowns — same catalog,
  // same cache file, different slice of it.
  router.get('/opencode/model-efforts', async (req, res) => {
    try {
      const cat = await getCatalog({ cachePath: catalogCachePath(), refresh: wantsRefresh(req) });
      return res.json({
        fetchedAt: cat.fetchedAt,
        efforts: cat.efforts || {},
        cached: cat.cached,
        ...(cat.stale ? { stale: true, warning: cat.warning } : {}),
      });
    } catch (e) {
      return res.status(502).json({ error: `Failed to fetch model efforts: ${e.message}`, efforts: {} });
    }
  });

  return router;
}

module.exports = { createCliConfigRouter };