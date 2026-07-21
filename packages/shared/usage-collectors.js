'use strict';

// Global usage collectors (FU-2 — docs/plans/usage-monitoring-and-opencode-telemetry.md).
// Server-side only: the hub's /api/usage route calls collectUsage(); credentials
// are read lazily per refresh and NEVER leave the process — results and the
// cache file contain usage numbers/timestamps only, never tokens.
//
// Every collector returns a normalized shape:
//   { status: 'ok', data: {...} }
//   { status: 'unavailable', reason }   — no credentials / provider absent
//   { status: 'auth_expired', reason }  — credentials rejected (401/403)
//   { status: 'error', reason }         — endpoint/shape failure (unofficial APIs shift)
// Reasons are safe static strings — HTTP status codes, never response bodies.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { BUILD_STUDIO_DIR } = require('./constants');

const CACHE_PATH = path.join(BUILD_STUDIO_DIR, 'usage-cache.json');
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10 * 1000;

const ok = (data) => ({ status: 'ok', data });
const unavailable = (reason) => ({ status: 'unavailable', reason });
const authExpired = (reason) => ({ status: 'auth_expired', reason });
const failure = (reason) => ({ status: 'error', reason });

// Utilization arrives as a 0-1 fraction on some APIs and 0-100 on others —
// normalize to percent (1dp).
function toPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  const pct = n <= 1 ? n * 100 : n;
  return Math.round(pct * 10) / 10;
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const epochToIso = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
};

async function fetchJson(url, { headers = {}, timeoutMs = FETCH_TIMEOUT_MS, fetchImpl } = {}) {
  const f = fetchImpl || globalThis.fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url, { headers, signal: ctrl.signal });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch (_) {}
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// ── Claude (unofficial oauth usage endpoint — same one Claude Code's /usage uses) ──

function readClaudeToken({ platform = process.platform, home = os.homedir(), execImpl = execFileSync } = {}) {
  try {
    let raw;
    if (platform === 'darwin') {
      raw = execImpl('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      });
    } else {
      raw = fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8');
    }
    const creds = JSON.parse(String(raw).trim());
    return creds?.claudeAiOauth?.accessToken || null;
  } catch (_) {
    return null;
  }
}

async function collectClaude(deps = {}) {
  const token = readClaudeToken(deps);
  if (!token) return unavailable('no Claude Code credentials');
  const { status, body } = await fetchJson('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      accept: 'application/json',
    },
    fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs,
  });
  if (status === 401 || status === 403) return authExpired('Claude OAuth token rejected — open claude once to refresh');
  if (status !== 200 || !body || typeof body !== 'object') return failure(`usage endpoint HTTP ${status}`);
  const data = {};
  if (body.five_hour && typeof body.five_hour === 'object') {
    data.fiveHour = { utilizationPct: toPct(body.five_hour.utilization), resetsAt: body.five_hour.resets_at || null };
  }
  if (body.seven_day && typeof body.seven_day === 'object') {
    data.sevenDay = { utilizationPct: toPct(body.seven_day.utilization), resetsAt: body.seven_day.resets_at || null };
  }
  if (body.extra_usage) data.extraUsage = body.extra_usage; // shape varies — pass through, UI reads defensively
  if (!Object.keys(data).length) return failure('usage payload had no recognizable windows');
  return ok(data);
}

// ── OpenRouter (official /key + /credits) ──

function readOpenRouterKey({ home = os.homedir(), env = process.env } = {}) {
  if (env.OPENROUTER_API_KEY) return env.OPENROUTER_API_KEY;
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(home, '.local', 'share', 'opencode', 'auth.json'), 'utf8'));
    return auth?.openrouter?.key || null;
  } catch (_) {
    return null;
  }
}

async function collectOpenRouter(deps = {}) {
  const key = readOpenRouterKey(deps);
  if (!key) return unavailable('no OpenRouter key (opencode auth.json / OPENROUTER_API_KEY)');
  const headers = { authorization: `Bearer ${key}`, accept: 'application/json' };
  const opts = { headers, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs };
  const [keyRes, creditsRes] = await Promise.all([
    fetchJson('https://openrouter.ai/api/v1/key', opts),
    fetchJson('https://openrouter.ai/api/v1/credits', opts),
  ]);
  if (keyRes.status === 401 || keyRes.status === 403 || creditsRes.status === 401 || creditsRes.status === 403) {
    return authExpired('OpenRouter key rejected');
  }
  if (keyRes.status !== 200 && creditsRes.status !== 200) {
    return failure(`key HTTP ${keyRes.status}, credits HTTP ${creditsRes.status}`);
  }
  const kd = keyRes.body?.data || {};
  const cd = creditsRes.body?.data || {};
  const data = {
    usageDaily: num(kd.usage_daily),
    usageWeekly: num(kd.usage_weekly),
    usageMonthly: num(kd.usage_monthly),
    usageTotal: num(kd.usage),
    limit: num(kd.limit),
    limitRemaining: num(kd.limit_remaining),
    isFreeTier: kd.is_free_tier === true,
  };
  const totalCredits = num(cd.total_credits);
  const totalUsage = num(cd.total_usage);
  if (totalCredits !== null && totalUsage !== null) {
    data.creditsTotal = totalCredits;
    data.creditsRemaining = Math.round((totalCredits - totalUsage) * 100) / 100;
  }
  return ok(data);
}

// ── Codex (unofficial ChatGPT backend usage endpoint) ──

function readCodexAuth({ home = os.homedir() } = {}) {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(home, '.codex', 'auth.json'), 'utf8'));
    return { accessToken: auth?.tokens?.access_token || null, accountId: auth?.tokens?.account_id || null };
  } catch (_) {
    return { accessToken: null, accountId: null };
  }
}

async function collectCodex(deps = {}) {
  const { accessToken, accountId } = readCodexAuth(deps);
  if (!accessToken) return unavailable('no codex auth token');
  const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/json' };
  if (accountId) headers['chatgpt-account-id'] = accountId;
  const { status, body } = await fetchJson('https://chatgpt.com/backend-api/wham/usage', {
    headers, fetchImpl: deps.fetchImpl, timeoutMs: deps.timeoutMs,
  });
  if (status === 401 || status === 403) return authExpired('codex access token expired — open codex once to refresh');
  if (status !== 200 || !body || typeof body !== 'object') return failure(`usage endpoint HTTP ${status}`);
  const pw = body.rate_limit?.primary_window || {};
  const data = {
    planType: body.plan_type || null,
    primary: { usedPercent: toPct(pw.used_percent), resetAt: epochToIso(pw.reset_at) },
  };
  const addl = Array.isArray(body.additional_rate_limits) ? body.additional_rate_limits : [];
  data.additional = addl.slice(0, 6).map((l) => ({
    name: l.limit_name || l.name || null,
    usedPercent: toPct(l.used_percent),
    resetAt: epochToIso(l.reset_at),
  })).filter((l) => l.name || l.usedPercent !== null);
  return ok(data);
}

// ── Orchestrator: parallel collection + 5-min cache (memory + disk) ──

let memCache = null; // { at, result }

function readCacheFile(cachePath, ttlMs, now) {
  try {
    const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (raw && Number.isFinite(raw.at) && now - raw.at < ttlMs && raw.result) return raw;
  } catch (_) {}
  return null;
}

async function collectUsage({ cachePath = CACHE_PATH, ttlMs = CACHE_TTL_MS, now = Date.now(), deps = {} } = {}) {
  if (memCache && now - memCache.at < ttlMs) return { ...memCache.result, cached: true };
  const fileHit = readCacheFile(cachePath, ttlMs, now);
  if (fileHit) {
    memCache = { at: fileHit.at, result: fileHit.result };
    return { ...fileHit.result, cached: true };
  }

  const safe = (p) => p.catch((e) => failure('collector failed'));
  const [claude, codex, openrouter] = await Promise.all([
    safe(collectClaude(deps)),
    safe(collectCodex(deps)),
    safe(collectOpenRouter(deps)),
  ]);
  const result = { fetchedAt: new Date(now).toISOString(), claude, codex, openrouter };
  memCache = { at: now, result };
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify({ at: now, result }, null, 2), 'utf8');
  } catch (_) {}
  return { ...result, cached: false };
}

// Test hook — drop the in-memory cache between cases.
function resetCacheForTests() { memCache = null; }

module.exports = {
  collectUsage,
  collectClaude,
  collectCodex,
  collectOpenRouter,
  resetCacheForTests,
  CACHE_PATH,
  CACHE_TTL_MS,
};
