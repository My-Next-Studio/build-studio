'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const devPorts = require('./dev-ports');
const {
  devServerRoles, devServerUrls, devUrlEnvLines, allocateDevPorts,
  readClaims, claimedByOther, writeClaims, CLAIM_FRESH_MS,
} = devPorts;

const VALKOMNA = [
  { name: 'backend', cmd: 'npm run dev', port: 4000 },
  { name: 'frontend', cmd: 'npm run dev', port: 5173 },
  { name: 'admin (local)', cmd: 'npm run dev -- --port 5174' },
];
const FAZON = [{ name: 'web', cmd: 'npm run dev', port: 4321 }];

// ── roles ────────────────────────────────────────────────────────────────────

test('frontend and backend by name, as before', () => {
  assert.deepEqual(devServerRoles(VALKOMNA), { frontend: 'frontend', backend: 'backend' });
});

// fazon (2026-10-27): its one server is `web`, so it exported nothing.
test('a single server under any name is the frontend', () => {
  assert.deepEqual(devServerRoles(FAZON), { frontend: 'web', backend: null });
});

test('an explicit role wins over the name', () => {
  const cmds = [{ name: 'api', role: 'backend', port: 3000 }, { name: 'site', role: 'frontend', port: 3001 }, { name: 'frontend', port: 9 }];
  assert.deepEqual(devServerRoles(cmds), { frontend: 'site', backend: 'api' });
});

test('two unnamed candidates are not guessed between', () => {
  const cmds = [{ name: 'web', port: 3000 }, { name: 'docs', port: 3001 }];
  assert.equal(devServerRoles(cmds).frontend, null);
});

test('a server without a port is never the guessed frontend', () => {
  assert.deepEqual(devServerRoles([{ name: 'backend', port: 4000 }, { name: 'worker' }]), { frontend: null, backend: 'backend' });
});

// ── URLs and the exported lines ──────────────────────────────────────────────

test('urls come from the ports this workflow started, backend on 127.0.0.1', () => {
  assert.deepEqual(devServerUrls({ backend: 4100, frontend: 5273 }, VALKOMNA),
    { frontend: 'http://localhost:5273', backend: 'http://127.0.0.1:4100' });
  assert.equal(devUrlEnvLines({ web: 4421 }, FAZON), 'export E2E_BASE_URL=http://localhost:4421\n');
});

test('no started server, nothing exported', () => {
  assert.equal(devUrlEnvLines({}, VALKOMNA), '');
  assert.equal(devUrlEnvLines(undefined, VALKOMNA), '');
});

// ── allocation ───────────────────────────────────────────────────────────────

test('free ports: configured + 100, and a server with no port is left alone', () => {
  const r = allocateDevPorts({ devCmds: VALKOMNA, isTaken: () => false });
  assert.deepEqual(r.ports, { backend: 4100, frontend: 5273 });
  assert.deepEqual(r.moved, []);
});

// The collision: two projects on 5173 both took 5273, and the second to reach
// QA killed the first one's server.
test('a port held by something else moves to the next free one', () => {
  const r = allocateDevPorts({ devCmds: VALKOMNA, isTaken: (p) => p === 5273 || p === 5274 });
  assert.equal(r.ports.frontend, 5275);
  assert.deepEqual(r.moved, [{ name: 'frontend', wanted: 5273, port: 5275 }]);
});

test('a later round keeps the ports it chose', () => {
  const r = allocateDevPorts({ devCmds: VALKOMNA, previous: { backend: 4100, frontend: 5275 }, isTaken: () => false });
  assert.deepEqual(r.ports, { backend: 4100, frontend: 5275 });
});

test('two servers of one run never get the same port', () => {
  const cmds = [{ name: 'a', port: 3000 }, { name: 'b', port: 3000 }];
  const r = allocateDevPorts({ devCmds: cmds, isTaken: () => false });
  assert.deepEqual(r.ports, { a: 3100, b: 3101 });
});

test('with every port busy it keeps the wanted one rather than inventing one', () => {
  const r = allocateDevPorts({ devCmds: FAZON, isTaken: () => true });
  assert.equal(r.ports.web, 4421);
});

// ── claims ───────────────────────────────────────────────────────────────────

test('a fresh claim by another run blocks; its own, or a stale silent one, does not', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  const fresh = new Date(now - 60 * 1000).toISOString();
  const stale = new Date(now - CLAIM_FRESH_MS - 1).toISOString();
  const claims = { 5273: { owner: 'fazon/wf1', at: fresh }, 5274: { owner: 'run-studio/wf2', at: stale } };
  assert.equal(claimedByOther(claims, 5273, 'valkomna/wf3', { now }), true);
  assert.equal(claimedByOther(claims, 5273, 'fazon/wf1', { now }), false);
  assert.equal(claimedByOther(claims, 5274, 'valkomna/wf3', { now }), false);
  assert.equal(claimedByOther(claims, 5274, 'valkomna/wf3', { now, isListening: () => true }), true, 'a listening port still counts');
  assert.equal(claimedByOther(claims, 9999, 'valkomna/wf3', { now }), false);
});

test('writing claims replaces this run\'s old ones and drops dead ones', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-ports-')), 'claims.json');
  const now = Date.parse('2026-10-27T12:00:00Z');
  const stale = new Date(now - CLAIM_FRESH_MS - 1).toISOString();
  fs.writeFileSync(file, JSON.stringify({
    5273: { owner: 'valkomna/wf3', at: stale },
    4421: { owner: 'fazon/wf1', at: stale },
    4100: { owner: 'fazon/wf1', at: new Date(now).toISOString() },
  }));
  writeClaims(file, { frontend: 5275 }, 'valkomna/wf3', { now });
  const after = readClaims(file);
  assert.deepEqual(Object.keys(after).sort(), ['4100', '5275']);
  assert.equal(after[5275].owner, 'valkomna/wf3');
});

test('an unreadable claims file reads as empty', () => {
  assert.deepEqual(readClaims(path.join(os.tmpdir(), 'no-such-dir-x', 'claims.json')), {});
});

// ── wiring in workflow.js ────────────────────────────────────────────────────

const SRC = fs.readFileSync(path.join(__dirname, 'api', 'workflow.js'), 'utf8');

test('every script that starts the CLI exports the dev server URLs', () => {
  assert.match(SRC, /\$\{simEnvLine\}\$\{devUrlEnvLine\}\$\{runIdEnvLine\}\$\{suiteEnvLine\}\$\{goalArmLine\}\$\{cliInvocation\}/, 'first launch');
  assert.match(SRC, /\$\{simEnvLine\}\$\{devUrlEnvLine\}\$\{runIdEnvLine\}\$\{suiteEnvLine\}claude --resume /, 'claude resume after a crash or lost session');
  assert.match(SRC, /\$\{simEnvLine\}\$\{devUrlEnvLine\}\$\{runIdEnvLine\}\$\{suiteEnvLine\}codex exec resume/, 'codex resume after a limit');
});

test('workflow.js no longer kills a port it did not record', () => {
  assert.doesNotMatch(SRC, /WORKTREE_PORT_OFFSET/);
  assert.match(SRC, /const ownPort = previous\[dev\.name\] \|\| null;/);
  assert.match(SRC, /devPorts\.allocateDevPorts\(/);
});

test('the QA prompt and the agents\' environment name the same servers', () => {
  assert.match(SRC, /devPorts\.devServerUrls\(ports, config\.dev_commands\)/);
  assert.match(SRC, /devPorts\.devUrlEnvLines\(wf\.devServerPorts, config\.dev_commands\)/);
});

test('vite dev servers still fail loudly on a taken port', () => {
  assert.match(SRC, /-- --port \$\{wtPort\} --strictPort/);
});
