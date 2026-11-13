'use strict';

// A run stops the Android emulators it started, and only those.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const { RUN_ID_VAR, runIdFor, isEmulatorCommand, stopRunEmulators, defaultHasEnv } = require('./run-emulators');

const QEMU = '/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64-headless -avd dr_api36_target -no-window';

function harness(procs, envs) {
  const sent = [];
  let timer = null;
  const alive = new Set(procs.map((p) => p.pid));
  const opts = {
    listProcesses: () => procs,
    hasEnv: (pid, name, value) => name === RUN_ID_VAR && envs[pid] === value,
    kill: (pid, sig) => {
      if (!alive.has(pid)) { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; }
      if (sig !== 0) sent.push([pid, sig]);
    },
    setTimer: (fn) => { timer = fn; },
    log: () => {},
  };
  return { opts, sent, alive, fireTimer: () => timer && timer() };
}

test('stops only the emulators carrying this run id', () => {
  const run = runIdFor('execution-1', '/p/a');
  const { opts, sent } = harness([
    { pid: 10, command: QEMU },                       // this run's
    { pid: 11, command: QEMU },                       // another run's, same AVD
    { pid: 12, command: QEMU },                       // booted by hand: no id
    { pid: 13, command: '/usr/bin/java -Xmx2g GradleDaemon' }, // this run's, not an emulator
  ], { 10: run, 11: runIdFor('execution-1', '/p/b'), 13: run });
  assert.deepEqual(stopRunEmulators(run, opts), [10]);
  assert.deepEqual(sent, [[10, 'SIGTERM']]);
});

test('escalates to SIGKILL only for an emulator still there and still this run\'s', () => {
  const run = runIdFor('execution-2', '/p/a');
  const envs = { 20: run, 21: run, 22: run };
  const { opts, sent, alive, fireTimer } = harness(
    [{ pid: 20, command: QEMU }, { pid: 21, command: QEMU }, { pid: 22, command: QEMU }],
    envs,
  );
  stopRunEmulators(run, opts);
  alive.delete(20);                       // exited on SIGTERM
  envs[22] = undefined;                   // 22's pid now belongs to something else
  fireTimer();
  assert.deepEqual(sent.filter(([, s]) => s === 'SIGKILL'), [[21, 'SIGKILL']]);
});

test('no run id, no kill', () => {
  const { opts, sent } = harness([{ pid: 30, command: QEMU }], { 30: undefined });
  assert.deepEqual(stopRunEmulators(undefined, opts), []);
  assert.deepEqual(sent, []);
});

test('a failing process listing does not throw', () => {
  assert.deepEqual(stopRunEmulators('r', { listProcesses: () => { throw new Error('ps timed out'); } }), []);
});

test('recognises the emulator, not its helpers or bystanders', () => {
  assert.equal(isEmulatorCommand(QEMU), true);
  assert.equal(isEmulatorCommand('/sdk/emulator/emulator -avd dr_api33_min -no-snapshot-save'), true);
  assert.equal(isEmulatorCommand('/sdk/emulator/netsimd --host-dns=192.168.2.1'), false);
  assert.equal(isEmulatorCommand('/sdk/emulator/crashpad_handler --monitor-pid=1'), false);
  assert.equal(isEmulatorCommand('/sdk/platform-tools/adb -s emulator-5560 emu kill'), false);
});

test('reads the run id from a real process environment, whole value only', async (t) => {
  const run = runIdFor('execution-3', '/p/a');
  // A node child, not /bin/sleep: macOS hides the environment of its own
  // protected binaries from `ps -E`. The emulator is a third-party binary too.
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { env: { ...process.env, [RUN_ID_VAR]: run }, stdio: 'ignore' });
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} });
  await new Promise((resolve) => child.once('spawn', resolve));
  assert.equal(defaultHasEnv(child.pid, RUN_ID_VAR, run), true);
  assert.equal(defaultHasEnv(child.pid, RUN_ID_VAR, run.slice(0, -1)), false, 'a prefix of the value is not a match');
  assert.equal(defaultHasEnv(child.pid, RUN_ID_VAR, runIdFor('execution-3', '/p/b')), false);
});
