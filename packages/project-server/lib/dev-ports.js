'use strict';

/**
 * Ports for the dev servers a workflow starts, and which of them is the
 * frontend and which the backend.
 *
 * Every project used to get its configured port + a fixed 100. Two projects
 * with the same default (5173) both landed on 5273, and the second to reach
 * QA killed whatever held 5273 before starting its own server: the first
 * project's dev server. Its agents' E2E_BASE_URL then pointed at the other
 * project's app, the phantom-404 failure the URL export was meant to remove.
 *
 * Now a workflow keeps the ports it chose for itself (so its later QA rounds
 * restart on the same ones), takes the next free port when its preferred one
 * is held by anything else, and kills only ports it recorded itself.
 *
 * A port can be free on the probe and still be about to be taken: another
 * project's server started a second ago and has not bound yet. A machine-wide
 * claims file closes that window. A claim only counts while it is young or its
 * port is listening, so a crashed run leaves nothing that needs cleaning up.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKTREE_PORT_OFFSET = 100;
const MAX_PROBES = 50;
/** Long enough for a dev server to bind after it is started. */
const CLAIM_FRESH_MS = 10 * 60 * 1000;

const DEFAULT_PORTS = { backend: 4000, frontend: 5173 };

/** The port a dev_commands entry would serve on outside a workflow, or null. */
function basePort(dev) {
  return dev.port || DEFAULT_PORTS[dev.name] || null;
}

/**
 * Which dev server is the frontend (E2E_BASE_URL) and which the backend
 * (BACKEND_URL), by name.
 *
 * Only `frontend` and `backend` counted before, so a project whose single
 * server is called `web` (fazon) exported nothing. In order:
 *   1. an explicit `role: frontend | backend` on the entry;
 *   2. an entry named `frontend` / `backend`;
 *   3. when no frontend is named, the only server with a port that is not the
 *      backend is the frontend. With two or more candidates there is no honest
 *      guess, so none is made; set `role` on one of them.
 *
 * @param {Array<{name: string, role?: string, port?: number}>} devCmds
 * @returns {{frontend: string|null, backend: string|null}}
 */
function devServerRoles(devCmds) {
  const cmds = (devCmds || []).filter((d) => d && d.name);
  const pick = (role) => {
    const explicit = cmds.find((d) => d.role === role);
    if (explicit) return explicit.name;
    const named = cmds.find((d) => d.name === role && !d.role);
    return named ? named.name : null;
  };
  const backend = pick('backend');
  let frontend = pick('frontend');
  if (!frontend) {
    const candidates = cmds.filter((d) => d.name !== backend && !d.role && basePort(d));
    if (candidates.length === 1) frontend = candidates[0].name;
  }
  return { frontend, backend };
}

/**
 * The URLs to give agents, from the ports this workflow started servers on.
 * Nothing for a role whose server the workflow did not start.
 *
 * The backend URL uses 127.0.0.1: Playwright's request API resolves localhost
 * to ::1, and a Node server bound to 127.0.0.1 refuses that.
 */
function devServerUrls(ports, devCmds) {
  const p = ports || {};
  const roles = devServerRoles(devCmds);
  return {
    frontend: roles.frontend && p[roles.frontend] ? `http://localhost:${p[roles.frontend]}` : null,
    backend: roles.backend && p[roles.backend] ? `http://127.0.0.1:${p[roles.backend]}` : null,
  };
}

/** Shell lines exporting those URLs; '' when the workflow started neither. */
function devUrlEnvLines(ports, devCmds) {
  const u = devServerUrls(ports, devCmds);
  return (u.frontend ? `export E2E_BASE_URL=${u.frontend}\n` : '')
    + (u.backend ? `export BACKEND_URL=${u.backend}\n` : '');
}

/**
 * Choose a port per dev server. Pure: every outside fact is a parameter.
 *
 * @param {object} o
 * @param {Array} o.devCmds          config.dev_commands
 * @param {object} [o.previous]      this workflow's ports from an earlier round
 * @param {(port: number) => boolean} o.isTaken  listening, or claimed by another run
 * @returns {{ports: object, moved: Array<{name, wanted, port}>}}
 */
function allocateDevPorts({ devCmds, previous = {}, isTaken }) {
  const ports = {};
  const moved = [];
  const chosen = new Set();
  for (const dev of devCmds || []) {
    const base = basePort(dev);
    if (!base) continue;
    const wanted = previous[dev.name] || base + WORKTREE_PORT_OFFSET;
    let port = wanted;
    let probes = 0;
    while ((chosen.has(port) || isTaken(port)) && probes < MAX_PROBES) {
      port += 1;
      probes += 1;
    }
    // Every port in range is busy: keep the wanted one and let the server's own
    // EADDRINUSE say so, rather than invent a port nothing will serve.
    if (probes === MAX_PROBES) port = wanted;
    chosen.add(port);
    ports[dev.name] = port;
    if (port !== wanted) moved.push({ name: dev.name, wanted, port });
  }
  return { ports, moved };
}

// ── machine-wide claims ──────────────────────────────────────────────────────

function claimsPath(home = os.homedir()) {
  return path.join(home, '.build-studio', 'dev-port-claims.json');
}

function readClaims(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { return {}; }
}

/**
 * Is `port` claimed by a different workflow? A claim counts while it is fresh
 * or its port is listening; an old claim on a silent port is a run that ended
 * or crashed, and is ignored.
 */
function claimedByOther(claims, port, owner, { now = Date.now(), isListening = () => false } = {}) {
  const c = claims[String(port)];
  if (!c || c.owner === owner) return false;
  return now - Date.parse(c.at) < CLAIM_FRESH_MS || isListening(port);
}

/** Record this workflow's ports, dropping its older claims and dead ones. */
function writeClaims(file, ports, owner, { now = Date.now(), isListening = () => false } = {}) {
  const claims = readClaims(file);
  for (const [port, c] of Object.entries(claims)) {
    const dead = now - Date.parse(c.at) >= CLAIM_FRESH_MS && !isListening(Number(port));
    if (c.owner === owner || dead) delete claims[port];
  }
  for (const port of Object.values(ports)) claims[String(port)] = { owner, at: new Date(now).toISOString() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(claims, null, 2) + '\n');
  } catch (e) {
    console.warn(`[dev-ports] could not write ${file}: ${e.message}`);
  }
}

/** Something is listening on `port` (lsof). */
function portListening(port) {
  const { spawnSync } = require('child_process');
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  return !!(r.stdout && r.stdout.trim());
}

module.exports = {
  WORKTREE_PORT_OFFSET, CLAIM_FRESH_MS,
  basePort, devServerRoles, devServerUrls, devUrlEnvLines, allocateDevPorts,
  claimsPath, readClaims, claimedByOther, writeClaims, portListening,
};
