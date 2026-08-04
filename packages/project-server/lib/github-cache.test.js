'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createCache } = require('./github-cache');

// A controllable clock, because the whole point of this module is age-based
// behaviour and sleeping through real TTLs would make the suite unusable.
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** A fetch whose resolution the test controls, so in-flight state is observable. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('the first get() returns loading and triggers exactly one fetch', async () => {
  const c = clock();
  let calls = 0;
  const cache = createCache({ fetch: async () => { calls++; return 'v1'; }, ttlFor: () => 1000, now: c.now });

  const first = cache.get();
  assert.deepEqual(
    [first.value, first.loading, first.stale],
    [null, true, true],
    'nothing cached yet — must not pretend to have a value'
  );
  await cache.refresh();
  assert.equal(cache.get().value, 'v1');
  assert.equal(calls, 1);
});

test('a fresh value is served without refetching', async () => {
  const c = clock();
  let calls = 0;
  const cache = createCache({ fetch: async () => { calls++; return calls; }, ttlFor: () => 1000, now: c.now });

  await cache.refresh();
  c.advance(999);
  for (let i = 0; i < 20; i++) cache.get();
  await Promise.resolve();
  assert.equal(calls, 1, '20 polls inside the TTL must cost one GitHub call');
  assert.equal(cache.get().stale, false);
});

test('crossing the TTL schedules a refresh but still answers immediately', async () => {
  const c = clock();
  let calls = 0;
  const cache = createCache({ fetch: async () => { calls++; return `v${calls}`; }, ttlFor: () => 1000, now: c.now });

  await cache.refresh();
  c.advance(1001);
  const r = cache.get();
  // The stale value is returned NOW — the caller is a 6-second UI poll and must
  // never wait on a `gh` subprocess.
  assert.equal(r.value, 'v1');
  assert.equal(r.stale, true);
  await cache.refresh();
  assert.equal(cache.get().value, 'v2');
});

test('single-flight: concurrent gets during a slow fetch schedule one call', async () => {
  const c = clock();
  const d = deferred();
  let calls = 0;
  const cache = createCache({ fetch: () => { calls++; return d.promise; }, ttlFor: () => 1000, now: c.now });

  const inFlight = cache.refresh();
  await Promise.resolve();   // fetch is invoked a microtask in, so a sync throw can't escape
  assert.equal(calls, 1);
  for (let i = 0; i < 12; i++) cache.get();
  await Promise.resolve();
  assert.equal(calls, 1, 'a slow gh call must not stack up behind repeated polls');
  d.resolve('done');
  await inFlight;
  assert.equal(cache.get().value, 'done');
});

test('a failed refresh keeps the last good value and reports the error with it', async () => {
  const c = clock();
  let fail = false;
  const cache = createCache({
    fetch: async () => { if (fail) throw new Error('gh: network unreachable'); return 'green'; },
    ttlFor: () => 1000,
    now: c.now,
  });

  await cache.refresh();
  fail = true;
  c.advance(1001);
  await cache.refresh();

  const r = cache.get();
  // Blanking a light that was green a moment ago is worse than showing it stale,
  // as long as the staleness is visible.
  assert.equal(r.value, 'green');
  assert.match(r.error, /network unreachable/);
});

test('errors are cached on their own TTL rather than retried every poll', async () => {
  const c = clock();
  let calls = 0;
  const cache = createCache({
    fetch: async () => { calls++; throw new Error('403 disabled'); },
    ttlFor: () => 1000,
    errorTtlMs: 60000,
    now: c.now,
  });

  await cache.refresh();
  assert.equal(calls, 1);

  // Well past the success TTL, but inside the error TTL: a repo that reliably
  // 403s (alerts disabled) must not be hammered on every 6-second poll.
  c.advance(30000);
  for (let i = 0; i < 10; i++) cache.get();
  await Promise.resolve();
  assert.equal(calls, 1);

  c.advance(31000);
  cache.get();
  await Promise.resolve();
  assert.equal(calls, 2, 'past the error TTL it should try again');
});

test('ttlFor sees the value, so a run in progress can refresh faster than an idle one', async () => {
  const c = clock();
  let value = { status: 'in_progress' };
  let calls = 0;
  const cache = createCache({
    fetch: async () => { calls++; return value; },
    ttlFor: (v) => (v && v.status === 'in_progress' ? 1000 : 100000),
    now: c.now,
  });

  await cache.refresh();
  c.advance(1500);
  assert.equal(cache.get().stale, true, 'an in-flight run goes stale quickly');
  await cache.refresh();

  value = { status: 'completed' };
  await cache.refresh();
  c.advance(1500);
  assert.equal(cache.get().stale, false, 'a finished run backs off');
});

test('a throwing ttlFor falls back to a sane TTL instead of taking the cache down', async () => {
  const c = clock();
  const cache = createCache({
    fetch: async () => 'v',
    ttlFor: () => { throw new Error('bad ttl'); },
    now: c.now,
  });
  await cache.refresh();
  assert.doesNotThrow(() => cache.get());
  assert.equal(cache.get().value, 'v');
});

test('refresh() never rejects, so fire-and-forget callers cannot crash the server', async () => {
  const cache = createCache({ fetch: async () => { throw new Error('boom'); }, ttlFor: () => 1000 });
  await assert.doesNotReject(() => cache.refresh());
  // And the fire-and-forget path inside get() is the one that actually runs in
  // production — an unhandled rejection there would kill the project-server.
  assert.doesNotThrow(() => cache.get());
});
