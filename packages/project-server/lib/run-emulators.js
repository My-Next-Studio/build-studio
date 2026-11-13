'use strict';

// Android emulators an agent boots outlive the run that booted it.
//
// An agent starts one with `emulator -avd … &` (or a project script that does),
// and the emulator detaches: when the run ends and its tmux session is closed,
// the emulator is reparented to launchd and keeps running with nobody to stop
// it. Each one holds ~6 GB of memory. On a 16 GB machine two of them pushed
// macOS into 12 GB of swap and filled the boot disk (deskrhythm, 2026-11-13):
// one had been offline for two days, the other was a read-only second boot
// started because the first still held the AVD lock, writing a 5 GB scratch
// disk into /tmp.
//
// Ownership is read from the environment, not guessed from timing or the AVD
// name. Every agent start script exports BUILD_STUDIO_RUN_ID, and an emulator
// inherits its launcher's environment, so an emulator carries the id of the run
// that started it. At run end only emulators carrying THIS run's id are
// stopped: one booted by hand, by another project, or by another run is left
// alone, even if it uses the same AVD.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const RUN_ID_VAR = 'BUILD_STUDIO_RUN_ID';
const PS_TIMEOUT_MS = 5000;
const KILL_GRACE_MS = 20_000;

/** The value agents of this run carry. The project root keeps two projects'
 *  runs apart when they start in the same second (run ids are timestamps). */
function runIdFor(wfId, projectRoot) {
  return `${wfId}@${projectRoot}`;
}

/** The emulator process itself, or the `emulator` launcher while it is still
 *  around. Helpers (crashpad_handler, netsimd) exit on their own once the
 *  emulator is gone; netsimd can be shared between emulators, so it is never
 *  signalled from here. */
function isEmulatorCommand(command) {
  const exe = path.basename(String(command).trim().split(/\s+/)[0] || '');
  return exe.startsWith('qemu-system-') || (exe === 'emulator' && /\s-avd\s/.test(command));
}

function defaultListProcesses() {
  const r = spawnSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8', timeout: PS_TIMEOUT_MS });
  return (r.stdout || '').split('\n').map((line) => {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    return m ? { pid: Number(m[1]), command: m[2] } : null;
  }).filter(Boolean);
}

/** Whether `pid` carries `NAME=value` in its environment. Linux has the exact
 *  list in /proc; macOS only prints it appended to the command line (`ps -E`),
 *  so there the match is on a space-delimited token. */
function defaultHasEnv(pid, name, value) {
  const token = `${name}=${value}`;
  try {
    return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').includes(token);
  } catch (_) { /* not Linux, or the process is gone */ }
  const r = spawnSync('ps', ['-E', '-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: PS_TIMEOUT_MS });
  const out = ` ${(r.stdout || '').trim()} `;
  return out.includes(` ${token} `);
}

/**
 * Stop every Android emulator started by the run `runId`. SIGTERM first, which
 * the emulator handles as a clean shutdown; SIGKILL after a grace period for
 * any that are still there AND still carry the id (a reused pid does not).
 *
 * Never throws: a run ending must not fail because of cleanup.
 *
 * @returns {number[]} the pids that were signalled
 */
function stopRunEmulators(runId, {
  listProcesses = defaultListProcesses,
  hasEnv = defaultHasEnv,
  kill = process.kill.bind(process),
  setTimer = (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
  graceMs = KILL_GRACE_MS,
  log = (msg) => console.log(msg),
} = {}) {
  if (!runId) return [];
  let owned;
  try {
    owned = listProcesses()
      .filter((p) => p.pid !== process.pid && isEmulatorCommand(p.command))
      .filter((p) => hasEnv(p.pid, RUN_ID_VAR, runId));
  } catch (_) {
    return [];
  }
  const signalled = [];
  for (const p of owned) {
    try { kill(p.pid, 'SIGTERM'); signalled.push(p.pid); } catch (_) { /* already gone */ }
  }
  if (signalled.length === 0) return [];
  log(`[workflow] stopping ${signalled.length} Android emulator(s) left by run ${runId}: pid ${signalled.join(', ')}`);
  setTimer(() => {
    for (const pid of signalled) {
      try {
        kill(pid, 0);
        if (hasEnv(pid, RUN_ID_VAR, runId)) kill(pid, 'SIGKILL');
      } catch (_) { /* exited cleanly */ }
    }
  }, graceMs);
  return signalled;
}

module.exports = { RUN_ID_VAR, runIdFor, isEmulatorCommand, stopRunEmulators, defaultHasEnv };
