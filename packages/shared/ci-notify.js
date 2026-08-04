'use strict';

/**
 * Deciding when a CI state change is worth interrupting someone for.
 *
 * Kept separate from the Electron main process so the interesting part — which
 * changes are events and which are merely facts — is testable without a window.
 *
 * The governing rule is that **notifications are for transitions, never for
 * conditions.** A red CI run is a condition: it stays true until someone fixes
 * it, and it is already represented by the red pulse on the tab. Notifying on
 * the condition would mean re-announcing the same failure on every poll, or
 * firing a burst of stale alarms every time the app launches. Notifying on the
 * transition tells you the one thing the pulse cannot: that it *just* changed.
 *
 * That is also why a project observed for the first time is seeded silently.
 * Learning about a project's CI at startup is not news that it broke — it may
 * have been red for a week — and an app that greets you with six notifications
 * every launch is an app whose notifications you turn off.
 */

/**
 * @param {Record<string,string|null>} prev  project → last seen conclusion
 * @param {Record<string,string|null>} next  project → current conclusion
 * @returns {{project:string, kind:'failed'|'recovered', title:string, body:string, url:string|null}[]}
 */
function diffCiStates(prev, next) {
  const out = [];
  for (const [project, cur] of Object.entries(next || {})) {
    const conclusion = cur && cur.conclusion !== undefined ? cur.conclusion : cur;
    const before = prev ? prev[project] : undefined;

    // Never seen this project before — record it, say nothing.
    if (before === undefined) continue;
    if (before === conclusion) continue;

    if (conclusion === 'failure') {
      out.push({
        project,
        kind: 'failed',
        title: `${project} — CI failed`,
        body: (cur && cur.title) ? String(cur.title).slice(0, 120) : 'the latest push run failed',
        url: (cur && cur.url) || null,
      });
    } else if (before === 'failure' && conclusion === 'success') {
      // The other moment worth knowing about: without it you have to go and
      // look to learn that a fix landed.
      out.push({
        project,
        kind: 'recovered',
        title: `${project} — CI recovered`,
        body: 'back to green',
        url: (cur && cur.url) || null,
      });
    }
    // Everything else — success→null, failure→cancelled, a run going
    // in-progress — is churn, not news.
  }
  return out;
}

/**
 * Fold a /api/global-status payload into the project → conclusion map.
 *
 * A project whose server is stopped, or that has no `deployment.repo`, is
 * omitted rather than recorded as null — otherwise stopping a project would
 * read as a state change and, on restart, as a recovery.
 */
function ciStatesFromStatuses(statuses) {
  const out = {};
  for (const s of statuses || []) {
    if (!s || !s.running || !s.ci) continue;
    out[s.name] = { conclusion: s.ci.conclusion ?? null, title: s.ci.title || null, url: s.ci.url || null };
  }
  return out;
}

/** Only the conclusions, for storing as the next poll's baseline. */
function conclusionsOf(states) {
  const out = {};
  for (const [k, v] of Object.entries(states || {})) out[k] = v && v.conclusion !== undefined ? v.conclusion : v;
  return out;
}

module.exports = { diffCiStates, ciStatesFromStatuses, conclusionsOf };
