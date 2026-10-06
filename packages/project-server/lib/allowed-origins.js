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

/**
 * Hostnames a request may be addressed to.
 *
 * DNS rebinding: a page at attacker.example re-points its own name at
 * 127.0.0.1, and its requests to attacker.example:<port> then reach this
 * server as SAME-ORIGIN. A same-origin GET carries no Origin header, so the
 * origin check passed it as a non-browser client and the page could read
 * everything this API serves (security review, 2026-10-06). The one thing the
 * attacker cannot change is the Host header: it is the name the browser
 * resolved, theirs. So the name must be one of ours.
 *
 * Hostname only, not port: a project-server moves to the next free port when
 * its configured one is taken, and the attacker controls the name, not the
 * port. Loopback under every spelling, plus the hosts of any origin deliberately
 * allowed (BUILD_STUDIO_ALLOWED_ORIGINS) and a specific listen host
 * (BUILD_STUDIO_LISTEN_HOST), so a setup widened on purpose keeps working.
 */
function allowedHostnames(allowedOrigins = [], listenHost = process.env.BUILD_STUDIO_LISTEN_HOST) {
  const names = new Set(['localhost', '127.0.0.1', '::1']);
  for (const o of allowedOrigins) {
    try { names.add(new URL(o).hostname.replace(/^\[|\]$/g, '').toLowerCase()); } catch (_) { /* not a URL */ }
  }
  if (listenHost && listenHost !== '0.0.0.0' && listenHost !== '::') names.add(String(listenHost).toLowerCase());
  return names;
}

/**
 * The hostname part of a Host header: `localhost:3005` → `localhost`,
 * `[::1]:3005` → `::1`. A missing header is a non-browser client (HTTP/1.0,
 * a raw socket) — browsers always send one — and is allowed, as a missing
 * Origin is.
 */
function isAllowedHost(hostHeader, names) {
  if (hostHeader === undefined || hostHeader === null || hostHeader === '') return true;
  const h = String(hostHeader).trim().toLowerCase();
  const name = h.startsWith('[') ? h.slice(1, h.indexOf(']')) : h.replace(/:\d+$/, '');
  return names.has(name);
}

/**
 * The CORS and origin policy for every route: refuse a request addressed to a
 * foreign hostname, echo an allow-listed origin, never '*', and refuse
 * state-changing requests from any other origin.
 */
function corsMiddleware(allowedOrigins) {
  const hostnames = allowedHostnames(allowedOrigins);
  return (req, res, next) => {
    // First, and for every method: a rebound page's reads are the exposure.
    if (!isAllowedHost(req.headers.host, hostnames)) {
      return res.status(403).json({ error: 'Forbidden host' });
    }
    const origin = req.headers.origin;
    // Vary: Origin unconditionally — the response body is identical either way,
    // but the ACAO header is not, and a cache that missed that could hand a
    // hub-stamped header to some other origin.
    res.setHeader('Vary', 'Origin');
    if (isAllowedOrigin(origin, allowedOrigins)) {
      // Only set ACAO when there IS an origin to echo. A no-origin caller is a
      // non-browser client that neither needs nor reads the header.
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    // A disallowed origin still gets 204 on the preflight, just without the
    // headers that would let it proceed — the browser fails the actual request.
    // Answering 403 here would leak "this port is a project-server" to any page
    // that probes it; a bare 204 is indistinguishable from an endpoint that
    // simply does not do CORS.
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    // CORS alone does not stop writes. It stops a foreign page READING a
    // response, and it stops JSON bodies, which need a preflight. A plain-text
    // form post needs neither, reaches the route with an empty body, and runs.
    // A route that needs no input then acts on it: POST /draft/create-story
    // started an agent session from any open web page (security review,
    // 2026-10-06), and /draft/end ended one. So any request that can change
    // state is refused from a disallowed origin. Browsers always send Origin
    // on a cross-origin POST, simple or not. Non-browser callers (curl,
    // agents, the overseer) send none and are unaffected; see isAllowedOrigin.
    if (req.method !== 'GET' && req.method !== 'HEAD' && !isAllowedOrigin(origin, allowedOrigins)) {
      return res.status(403).json({ error: 'Forbidden origin' });
    }
    next();
  };
}

module.exports = {
  DEFAULT_HUB_PORT,
  defaultAllowedOrigins,
  parseAllowedOrigins,
  isAllowedOrigin,
  allowedHostnames,
  isAllowedHost,
  corsMiddleware,
};
