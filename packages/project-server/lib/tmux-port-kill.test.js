'use strict';

// Stopping a dev server must stop the dev server, not whoever is talking to it.
// `lsof -ti :PORT` lists clients too, and the project-server is one whenever it
// has a kept-alive socket to the dev server — so the old kill could SIGTERM the
// project-server itself, which exits on SIGTERM without logging anything.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { killPortListeners } = require('./tmux');

const hasLsof = spawnSync('lsof', ['-v']).error?.code !== 'ENOENT';

test('the listener is killed and a process merely connected to the port is not', { skip: !hasLsof && 'lsof is not installed' }, async (t) => {
  // A dev server stand-in in its own process, reporting the port it bound.
  const child = spawn(process.execPath, ['-e', `
    const s = require('net').createServer((c) => c.on('error', () => {}));
    s.listen(0, '127.0.0.1', () => console.log(s.address().port));
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} });
  const port = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(Number(String(d).trim()))));

  // This test process now holds a client socket to that port — exactly what the
  // project-server holds after an HTTP request to the dev server.
  const client = net.connect(port, '127.0.0.1');
  client.on('error', () => {});
  await new Promise((resolve) => client.once('connect', resolve));
  t.after(() => client.destroy());
  const clientSeen = spawnSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' }).stdout.split('\n').map(Number);
  assert.ok(clientSeen.includes(process.pid), 'precondition: a bare `lsof -ti :PORT` lists the client');

  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal)));
  const killed = killPortListeners(port);

  assert.deepEqual(killed, [child.pid], 'only the listener was signalled');
  assert.equal(await exited, 'SIGTERM');
});

test('never signals its own process, even if lsof names it', () => {
  const sent = [];
  const killed = killPortListeners(5280, { lsof: () => [111, 222], selfPid: 222, kill: (pid, sig) => sent.push([pid, sig]) });
  assert.deepEqual(sent, [[111, 'SIGTERM']]);
  assert.deepEqual(killed, [111]);
});

test('no port, no kill', () => {
  let called = false;
  assert.deepEqual(killPortListeners(null, { lsof: () => { called = true; return [1]; } }), []);
  assert.equal(called, false);
});
