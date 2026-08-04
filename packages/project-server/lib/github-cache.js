'use strict';

/**
 * A read-through cache that ALWAYS answers instantly and refreshes behind you.
 *
 * The problem this exists to solve: the hub polls `/api/global-status` every 6
 * seconds (`global-status-bar.tsx`), and both monitoring plans want CI state and
 * dependency alerts to ride along with it. But every one of those values costs a
 * `gh` subprocess. Wiring them straight through would mean ~10 GitHub API calls
 * per second across nine projects, against the same credential the push button
 * and the CI-investigate agent depend on — the fastest possible way to get the
 * whole installation rate-limited.
 *
 * So the UI cadence and the GitHub cadence are decoupled here rather than
 * negotiated. `get()` is a memory read that never awaits and never throws; when
 * the value has aged past its TTL it schedules a refresh and returns the stale
 * value in the meantime. Poll it every 6 seconds or every 6 minutes — GitHub
 * sees at most one request per TTL either way.
 *
 * Three properties worth stating because callers depend on them:
 *
 * - **Single-flight.** A slow refresh cannot stack. Twelve `get()` calls during
 *   one in-flight `gh` invocation schedule zero additional work.
 * - **A failed refresh keeps the last good value.** A transient network blip
 *   must not blank a CI light that was green a moment ago; `error` is reported
 *   alongside the stale value so the UI can show both.
 * - **Errors are cached too**, on their own TTL. Otherwise a repository that
 *   reliably 403s (dependency alerts are disabled on most of them) would be
 *   retried on every single poll forever.
 */

/**
 * @param {object}   opts
 * @param {() => Promise<any>} opts.fetch     the expensive call
 * @param {(value:any) => number} opts.ttlFor  how long THIS value stays fresh —
 *        lets a run that is still in progress refresh quickly while a repo that
 *        has been idle for hours backs off
 * @param {number}   [opts.errorTtlMs]  how long to sit on a failure
 * @param {() => number} [opts.now]     injectable clock (tests)
 */
function createCache({ fetch, ttlFor, errorTtlMs = 120000, now = Date.now }) {
  let entry = null;      // { value, error, fetchedAt }
  let inFlight = null;

  function ttlOf(e) {
    if (e.error) return errorTtlMs;
    try {
      const t = ttlFor(e.value);
      return Number.isFinite(t) && t > 0 ? t : 60000;
    } catch (_) {
      return 60000;
    }
  }

  function isStale() {
    return !entry || (now() - entry.fetchedAt) >= ttlOf(entry);
  }

  /**
   * Refresh now, regardless of age. Never rejects — callers fire and forget, so
   * a rejection here would surface as an unhandled promise rejection and, in a
   * project-server, take the process with it.
   */
  function refresh() {
    if (inFlight) return inFlight;
    inFlight = Promise.resolve()
      .then(() => fetch())
      .then(
        (value) => { entry = { value, error: null, fetchedAt: now() }; },
        (e) => {
          // Keep the previous value: a stale green light beats no light, as
          // long as `error` travels with it.
          entry = {
            value: entry ? entry.value : null,
            error: (e && e.message) || String(e),
            fetchedAt: now(),
          };
        }
      )
      .then(() => { inFlight = null; });
    return inFlight;
  }

  /** Instant, synchronous, never throws. Schedules a refresh when stale. */
  function get() {
    const stale = isStale();
    if (stale) refresh();
    if (!entry) return { value: null, error: null, fetchedAt: null, stale: true, loading: true };
    return {
      value: entry.value,
      error: entry.error,
      fetchedAt: entry.fetchedAt,
      stale,
      loading: !!inFlight,
    };
  }

  /** The cached entry without triggering anything — for tests and diagnostics. */
  function peek() {
    return entry;
  }

  return { get, refresh, peek };
}

module.exports = { createCache };
