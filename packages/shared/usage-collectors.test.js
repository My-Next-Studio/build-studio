'use strict';

// Unit tests for the global usage collectors (FU-2). Fixtures mirror the
// provider payloads verified live on 2026-07-20 (see the plan doc); all
// credential reads and fetches are injected — no network, no keychain, no disk.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  collectUsage,
  collectClaude,
  collectCodex,
  collectOpenRouter,
  resetCacheForTests,
} = require('./usage-collectors');

// ── fixtures ──

const CLAUDE_USAGE = {
  five_hour: { utilization: 0.42, resets_at: '2026-07-20T22:00:00.000Z' },
  seven_day: { utilization: 97.3, resets_at: '2026-07-24T00:00:00.000Z' },
  extra_usage: { is_enabled: true },
};

const OPENROUTER_KEY = {
  data: {
    usage: 12.34, limit: 50, limit_remaining: 37.66, is_free_tier: false,
    usage_daily: 1.11, usage_weekly: 5.22, usage_monthly: 9.33,
  },
};
const OPENROUTER_CREDITS = { data: { total_credits: 100, total_usage: 12.34 } };

const CODEX_USAGE = {
  plan_type: 'plus',
  rate_limit: { primary_window: { used_percent: 63, reset_at: 1785000000 } },
  additional_rate_limits: [
    { limit_name: 'gpt-5.2-codex', used_percent: 12, reset_at: 1785000000 },
  ],
};

// ── injected impls ──

function makeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [match, resp] of Object.entries(routes)) {
      if (url.includes(match)) {
        return { status: resp.status, text: async () => JSON.stringify(resp.body) };
      }
    }
    return { status: 404, text: async () => '{}' };
  };
  fn.calls = calls;
  return fn;
}

const claudeDeps = (fetchImpl) => ({
  platform: 'darwin',
  execImpl: () => JSON.stringify({ claudeAiOauth: { accessToken: 'test-token' } }),
  fetchImpl,
});

function makeHome({ openrouterKey = null, codexAuth = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));
  if (openrouterKey) {
    fs.mkdirSync(path.join(home, '.local', 'share', 'opencode'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'share', 'opencode', 'auth.json'), JSON.stringify({ openrouter: { key: openrouterKey } }));
  }
  if (codexAuth) {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), JSON.stringify(codexAuth));
  }
  return home;
}

// ── Claude ──

test('claude: parses windows, normalizes fraction and percent utilization', async () => {
  const r = await collectClaude(claudeDeps(makeFetch({ 'api/oauth/usage': { status: 200, body: CLAUDE_USAGE } })));
  assert.equal(r.status, 'ok');
  assert.equal(r.data.fiveHour.utilizationPct, 42);       // 0.42 fraction → 42%
  assert.equal(r.data.sevenDay.utilizationPct, 97.3);     // already percent
  assert.equal(r.data.fiveHour.resetsAt, '2026-07-20T22:00:00.000Z');
  assert.ok(r.data.extraUsage);
});

test('claude: missing keychain entry → unavailable, no fetch', async () => {
  const fetchImpl = makeFetch({});
  const r = await collectClaude({ platform: 'darwin', execImpl: () => { throw new Error('not found'); }, fetchImpl });
  assert.equal(r.status, 'unavailable');
  assert.equal(fetchImpl.calls.length, 0);
});

test('claude: 401 → auth_expired', async () => {
  const r = await collectClaude(claudeDeps(makeFetch({ 'api/oauth/usage': { status: 401, body: {} } })));
  assert.equal(r.status, 'auth_expired');
});

// ── OpenRouter ──

test('openrouter: combines /key and /credits into one card shape', async () => {
  const home = makeHome({ openrouterKey: 'sk-or-test' });
  const r = await collectOpenRouter({
    home, env: {},
    fetchImpl: makeFetch({
      '/api/v1/key': { status: 200, body: OPENROUTER_KEY },
      '/api/v1/credits': { status: 200, body: OPENROUTER_CREDITS },
    }),
  });
  assert.equal(r.status, 'ok');
  assert.equal(r.data.limit, 50);
  assert.equal(r.data.limitRemaining, 37.66);
  assert.equal(r.data.usageDaily, 1.11);
  assert.equal(r.data.usageMonthly, 9.33);
  assert.equal(r.data.creditsRemaining, 87.66); // 100 − 12.34
  assert.equal(r.data.isFreeTier, false);
});

test('openrouter: no key anywhere → unavailable', async () => {
  const r = await collectOpenRouter({ home: makeHome(), env: {}, fetchImpl: makeFetch({}) });
  assert.equal(r.status, 'unavailable');
});

// ── Codex ──

test('codex: parses plan, primary window, additional limits; epoch reset → ISO', async () => {
  const home = makeHome({ codexAuth: { tokens: { access_token: 'at', account_id: 'acct' } } });
  const r = await collectCodex({ home, fetchImpl: makeFetch({ 'wham/usage': { status: 200, body: CODEX_USAGE } }) });
  assert.equal(r.status, 'ok');
  assert.equal(r.data.planType, 'plus');
  assert.equal(r.data.primary.usedPercent, 63);
  assert.equal(r.data.primary.resetAt, new Date(1785000000 * 1000).toISOString());
  assert.equal(r.data.additional.length, 1);
  assert.equal(r.data.additional[0].name, 'gpt-5.2-codex');
});

test('codex: 401 → auth_expired with refresh hint', async () => {
  const home = makeHome({ codexAuth: { tokens: { access_token: 'at', account_id: 'acct' } } });
  const r = await collectCodex({ home, fetchImpl: makeFetch({ 'wham/usage': { status: 401, body: {} } }) });
  assert.equal(r.status, 'auth_expired');
  assert.match(r.reason, /open codex once to refresh/);
});

test('codex: missing auth.json → unavailable', async () => {
  const r = await collectCodex({ home: makeHome(), fetchImpl: makeFetch({}) });
  assert.equal(r.status, 'unavailable');
});

// ── orchestrator + cache ──

test('collectUsage: parallel collection, per-provider failure isolation, cache honored', async () => {
  resetCacheForTests();
  const home = makeHome({
    openrouterKey: 'sk-or-test',
    codexAuth: { tokens: { access_token: 'at', account_id: 'acct' } },
  });
  const fetchImpl = makeFetch({
    'api/oauth/usage': { status: 200, body: CLAUDE_USAGE },
    '/api/v1/key': { status: 200, body: OPENROUTER_KEY },
    '/api/v1/credits': { status: 200, body: OPENROUTER_CREDITS },
    'wham/usage': { status: 500, body: {} }, // codex down — must not break the others
  });
  const cachePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-cache-')), 'cache.json');
  const deps = {
    platform: 'darwin',
    execImpl: () => JSON.stringify({ claudeAiOauth: { accessToken: 't' } }),
    home, env: {},
    fetchImpl,
  };

  const first = await collectUsage({ cachePath, deps, now: 1_000_000 });
  assert.equal(first.cached, false);
  assert.equal(first.claude.status, 'ok');
  assert.equal(first.openrouter.status, 'ok');
  assert.equal(first.codex.status, 'error'); // isolated failure
  assert.equal(first.fetchedAt, new Date(1_000_000).toISOString());
  const callsAfterFirst = fetchImpl.calls.length;
  assert.ok(callsAfterFirst >= 4); // claude 1 + openrouter 2 + codex 1

  // Within TTL → memory cache, zero new fetches
  const second = await collectUsage({ cachePath, deps, now: 1_000_000 + 60_000 });
  assert.equal(second.cached, true);
  assert.equal(fetchImpl.calls.length, callsAfterFirst);

  // After TTL → refetch
  const third = await collectUsage({ cachePath, deps, now: 1_000_000 + 10 * 60_000 });
  assert.equal(third.cached, false);
  assert.ok(fetchImpl.calls.length > callsAfterFirst);
});

test('collectUsage: cache file (not just memory) short-circuits a cold process', async () => {
  resetCacheForTests();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-cache-'));
  const cachePath = path.join(dir, 'cache.json');
  const result = { fetchedAt: new Date(500).toISOString(), claude: { status: 'unavailable' }, codex: { status: 'unavailable' }, openrouter: { status: 'unavailable' } };
  fs.writeFileSync(cachePath, JSON.stringify({ at: 500, result }));
  const fetchImpl = makeFetch({});
  const r = await collectUsage({ cachePath, deps: { fetchImpl }, now: 1000 });
  assert.equal(r.cached, true);
  assert.equal(r.fetchedAt, result.fetchedAt);
  assert.equal(fetchImpl.calls.length, 0);
});
