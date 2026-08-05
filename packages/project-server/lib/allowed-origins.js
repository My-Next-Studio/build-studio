// Which browser origins may talk to this project-server.
//
// WHY this exists, given the server binds to 127.0.0.1:
//
// Loopback stops other *machines*. It does not stop other *tabs*. Every page
// you visit can reach http://localhost:3001 from your own browser, and this API
// has no authentication of any kind — it reads project files, writes them,
// drives git, and starts and kills agent sessions. Sending
// `Access-Control-Allow-Origin: *` (which this server did until now) is what
// turns "any local process" into "any website you happen to open", because the
// wildcard is what lets the attacking page *read the response*. Paired with
// `Allow-Headers: Content-Type` it also cleared the preflight for JSON bodies,
// so writes went through too, not just reads.
//
// The hub is the only browser client, and almost all of its traffic is proxied
// server-side by Next (same-origin, no CORS involved). The sole genuine
// cross-origin request is the EventSource on /api/sse opened directly against
// each project-server port — see hub/lib/use-home-status.ts. So an allowlist of
// exactly the hub origin costs us nothing and closes the hole.
const DEFAULT_HUB_PORT = 18080;

/**
 * Origins allowed by default: the hub, under both spellings of loopback.
 * Electron always loads the hub as http://localhost:18080, but a browser
 * pointed at 127.0.0.1 is the same app and should keep working.
 */
function defaultAllowedOrigins(hubPort = DEFAULT_HUB_PORT) {
  return [`http://localhost:${hubPort}`, `http://127.0.0.1:${hubPort}`];
}

/**
 * Parses BUILD_STUDIO_ALLOWED_ORIGINS (comma-separated) into an allowlist,
 * falling back to the hub defaults when unset or blank. Mirrors the
 * BUILD_STUDIO_LISTEN_HOST convention: the safe thing happens by default and
 * widening it is a deliberate, visible act.
 */
function parseAllowedOrigins(value, hubPort = DEFAULT_HUB_PORT) {
  if (!value || typeof value !== 'string') return defaultAllowedOrigins(hubPort);
  const list = value.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length > 0 ? list : defaultAllowedOrigins(hubPort);
}

/**
 * True when `origin` may read responses from this server.
 *
 * A missing origin is allowed on purpose. Browsers always send Origin on
 * cross-origin fetches and on every WebSocket handshake, so "no origin" means a
 * non-browser client — curl, the Electron main process's health poll, the
 * overseer's loopback call to /workflow/advance. Those were never the exposure
 * being closed here, and rejecting them would break the app while stopping
 * nobody: an attacker who can set arbitrary headers is not working through a
 * browser and is not subject to CORS in the first place.
 *
 * `'null'` is NOT a missing origin — it is what a sandboxed iframe or a
 * file:// page sends, and it is an origin an attacker can arrange. Rejected.
 */
function isAllowedOrigin(origin, allowlist) {
  if (origin === undefined || origin === null || origin === '') return true;
  return allowlist.includes(origin);
}

module.exports = {
  DEFAULT_HUB_PORT,
  defaultAllowedOrigins,
  parseAllowedOrigins,
  isAllowedOrigin,
};
