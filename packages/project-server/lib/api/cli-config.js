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
  VALID_CLIS, resolveEnabledClis, detectClis,
  loadHubConfig, hasGlobalCliDefaults, normalizeCliBlock, validateCliPatch,
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
      // The Model page renders one row per group, in this order. Sent by the
      // server because the grouping is configuration, not a UI constant — a
      // project that regroups its steps gets different rows without a rebuild.
      step_groups: config.step_groups,
    });
  });

  router.put('/config/cli', (req, res) => {
    // Validation is shared with the installation-wide route in the hub — one
    // shape, one validator, so a value cannot be accepted here and rejected
    // there.
    const { patch, error } = validateCliPatch(req.body);
    if (error) return res.status(400).json({ error });
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