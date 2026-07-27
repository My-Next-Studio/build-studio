'use strict';

/**
 * Single source of truth for WHERE demo recordings live.
 *
 * The recorder (desktop main process, demoRecorder.js) writes recordings and the
 * hub API (recordings.ts) lists/reads them — they MUST resolve the same folder or
 * recordings vanish from the UI. This module is the one place that decides.
 *
 * Precedence (first hit wins):
 *   1. DEMO_RECORDINGS_DIR env var — ops/CI override, unchanged from before.
 *   2. `demoRecordingsDir` in ~/.build-studio/config.json — the user setting.
 *   3. Common parent of all registered projects + /demo-recordings — the
 *      historical auto-heuristic (kept so existing installs don't move).
 *   4. ~/Movies/build-studio-demos — fallback when the common parent is
 *      uselessly shallow (projects spread across volumes).
 */

const os = require('os');
const path = require('path');
const registry = require('./registry');
const { expandTilde } = require('./paths');
const { loadHubConfig, saveHubConfig } = require('./cli');

/** Longest common directory prefix of a set of absolute paths (or null). */
function commonParent(paths) {
  const list = (paths || []).filter(Boolean);
  if (!list.length) return null;
  const split = list.map((p) => path.resolve(p).split(path.sep));
  const first = split[0];
  const out = [];
  for (let i = 0; i < first.length; i++) {
    const seg = first[i];
    if (split.every((s) => s[i] === seg)) out.push(seg); else break;
  }
  return out.join(path.sep) || null;
}

/** The user-configured recordings dir (absolute, ~-expanded), or null if unset. */
function getConfiguredDir() {
  try {
    const v = loadHubConfig().demoRecordingsDir;
    if (typeof v === 'string' && v.trim()) return path.resolve(expandTilde(v.trim()));
  } catch (_) { /* no/broken config → treated as unset */ }
  return null;
}

/**
 * Persist the configured recordings dir. Pass a path to set it, or null/'' to
 * clear it (falling back to the heuristic). Stores the raw string the user
 * typed (so `~/…` stays portable); returns the stored value.
 */
function setConfiguredDir(dir) {
  const v = (typeof dir === 'string' && dir.trim()) ? dir.trim() : null;
  saveHubConfig({ demoRecordingsDir: v });
  return v;
}

/** Resolve the active recordings base dir per the precedence above. */
function resolveDemoRecordingsDir() {
  if (process.env.DEMO_RECORDINGS_DIR) return process.env.DEMO_RECORDINGS_DIR;
  const configured = getConfiguredDir();
  if (configured) return configured;
  try {
    const projects = registry.list().map((p) => p.path).filter(Boolean);
    const parent = commonParent(projects);
    // Guard against a uselessly-shallow common root (e.g. '/' or '/Volumes').
    if (parent && parent.split(path.sep).filter(Boolean).length >= 2) {
      return path.join(parent, 'demo-recordings');
    }
  } catch (_) { /* registry not resolvable — fall through */ }
  return path.join(os.homedir(), 'Movies', 'build-studio-demos');
}

/**
 * Same resolution, but also reports which tier won ('env' | 'config' |
 * 'projects' | 'default') and the raw configured value — so the UI can explain
 * the current folder and whether an env var is overriding the setting.
 */
function resolveDemoRecordingsInfo() {
  const dir = resolveDemoRecordingsDir();
  let configuredRaw = null;
  try {
    const v = loadHubConfig().demoRecordingsDir;
    if (typeof v === 'string' && v.trim()) configuredRaw = v.trim();
  } catch (_) { /* unset */ }

  let source = 'default';
  if (process.env.DEMO_RECORDINGS_DIR) source = 'env';
  else if (configuredRaw) source = 'config';
  else {
    try {
      const projects = registry.list().map((p) => p.path).filter(Boolean);
      const parent = commonParent(projects);
      if (parent && parent.split(path.sep).filter(Boolean).length >= 2) source = 'projects';
    } catch (_) { /* default */ }
  }
  return { dir, source, configured: configuredRaw, envOverride: !!process.env.DEMO_RECORDINGS_DIR };
}

module.exports = {
  commonParent,
  getConfiguredDir,
  setConfiguredDir,
  resolveDemoRecordingsDir,
  resolveDemoRecordingsInfo,
};
