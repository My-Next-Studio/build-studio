#!/usr/bin/env node
/**
 * xctest-clean — concurrency-safe reaper for leaked XCTest clone simulators.
 *
 * `xcodebuild test -parallel-testing-enabled YES` clones the destination
 * simulator into the GLOBAL device set at ~/Library/Developer/XCTestDevices.
 * That set is shared by every project on the machine, so a blind
 * `rm -rf ~/Library/Developer/XCTestDevices/*` would destroy clones that a
 * DIFFERENT project's test run is actively using. Cancelled / force-killed
 * runs orphan their clones, which then accumulate (the directory grew to 66 GB
 * on this machine before this script existed).
 *
 * SAFETY INVARIANT — a clone is reaped only when BOTH hold:
 *   1. state === "Shutdown"  — an active run (in ANY project) keeps its clones
 *      Booted, so they are skipped regardless of which project owns them.
 *   2. its directory has not been modified within --guard-minutes (default 10)
 *      — protects the brief window where a freshly cloned sim exists but has
 *      not booted yet.
 * This is what makes cleanup in one project safe while another project tests.
 * We deliberately NEVER `simctl shutdown all` and NEVER touch Booted clones:
 * we cannot tell an orphaned-Booted clone from an in-use one across projects,
 * so we leave Booted clones alone. (In practice CoreSimulator transitions
 * orphaned clones to Shutdown once their parent xcodebuild dies, so this still
 * reaps every real leak — just on the next pass.)
 *
 * A cross-process PID lock (in the OS temp dir) serialises concurrent runs
 * (the per-run hook in ops-uitests.js, the launchd sweep, and any agent that
 * calls this script) so they don't fight over the same `simctl delete`.
 *
 * Usage:
 *   node xctest-clean.js [--dry-run] [--guard-minutes N] [--json] [--quiet]
 *                        [--set <path>]
 * Exit code is always 0 on a clean run (including "another cleanup is already
 * running" — that process owns the work).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const XCRUN = '/usr/bin/xcrun';
// launchd hands processes a minimal PATH; make sure the tools we shell out to
// resolve regardless of who invokes us.
const CHILD_ENV = {
  ...process.env,
  PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
};

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    guardMinutes: 10,
    json: false,
    quiet: false,
    setPath: path.join(os.homedir(), 'Library', 'Developer', 'XCTestDevices'),
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--guard-minutes') opts.guardMinutes = Number(argv[++i]);
    else if (a === '--set') opts.setPath = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  if (!Number.isFinite(opts.guardMinutes) || opts.guardMinutes < 0) opts.guardMinutes = 10;
  return opts;
}

function printHelp() {
  process.stdout.write(
    'xctest-clean — reap leaked XCTest clone simulators (Shutdown + idle only)\n' +
    '  --dry-run            report what would be deleted, delete nothing\n' +
    '  --guard-minutes N    skip clones modified within the last N minutes (default 10)\n' +
    '  --json               emit a JSON summary\n' +
    '  --quiet              suppress the human summary\n' +
    '  --set <path>         device set (default ~/Library/Developer/XCTestDevices)\n'
  );
}

function sleepSync(ms) {
  // Dependency-free synchronous sleep — used only while waiting on the lock.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

/**
 * Cross-process exclusive lock via O_EXCL create. Returns a release() fn, or
 * null if another live process holds the lock (caller should bow out).
 */
function acquireLock(lockPath) {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { fs.unlinkSync(lockPath); } catch (_) {}
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder = null;
      try { holder = parseInt(fs.readFileSync(lockPath, 'utf8').trim(), 10); } catch (_) {}
      if (!holder || !isAlive(holder)) {
        // Stale lock from a crashed run — steal it.
        try { fs.unlinkSync(lockPath); } catch (_) {}
        continue;
      }
      sleepSync(250);
    }
  }
  return null;
}

function listCloneDevices(setPath) {
  // `simctl --set <path> list devices --json` returns { devices: { <runtime>: [ {udid,state,name,...} ] } }
  let out;
  try {
    out = execFileSync(XCRUN, ['simctl', '--set', setPath, 'list', 'devices', '--json'], {
      env: CHILD_ENV, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024,
    });
  } catch (e) {
    // No runtimes / empty set / simctl hiccup — treat as "nothing to list".
    return [];
  }
  let parsed;
  try { parsed = JSON.parse(out); } catch (_) { return []; }
  const devices = [];
  for (const runtime of Object.keys(parsed.devices || {})) {
    for (const d of parsed.devices[runtime] || []) {
      if (d && d.udid) devices.push({ udid: d.udid, state: d.state, name: d.name });
    }
  }
  return devices;
}

function dirSizeKB(dir) {
  try {
    const out = execFileSync('du', ['-sk', dir], { env: CHILD_ENV, encoding: 'utf8', timeout: 30000 });
    return parseInt(out.trim().split(/\s+/)[0], 10) || 0;
  } catch (_) { return 0; }
}

function deleteRegistered(setPath, udid) {
  // simctl delete unregisters from the set's device_set.plist AND removes the
  // data dir — cleaner than rm -rf, which would leave a dangling plist entry.
  execFileSync(XCRUN, ['simctl', '--set', setPath, 'delete', udid], {
    env: CHILD_ENV, encoding: 'utf8', timeout: 120000,
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = {
    setPath: opts.setPath,
    dryRun: opts.dryRun,
    guardMinutes: opts.guardMinutes,
    reaped: [],        // { udid, name, kb, kind: 'clone'|'orphan' }
    skippedBooted: 0,
    skippedFresh: 0,
    reclaimedKB: 0,
    lockBusy: false,
  };

  if (!fs.existsSync(opts.setPath)) {
    return finish(opts, result); // nothing to do
  }

  const release = acquireLock(path.join(os.tmpdir(), 'xctest-clean.lock'));
  if (!release) {
    result.lockBusy = true;
    return finish(opts, result);
  }

  try {
    const cutoffMs = Date.now() - opts.guardMinutes * 60 * 1000;
    const devices = listCloneDevices(opts.setPath);
    const registered = new Set(devices.map(d => d.udid));

    // 1) Registered clones: reap only Shutdown + idle.
    for (const d of devices) {
      if (d.state !== 'Shutdown') { result.skippedBooted++; continue; }
      const dir = path.join(opts.setPath, d.udid);
      let mtime = 0;
      try { mtime = fs.statSync(dir).mtimeMs; } catch (_) { mtime = 0; }
      if (mtime && mtime > cutoffMs) { result.skippedFresh++; continue; }
      const kb = dirSizeKB(dir);
      if (!opts.dryRun) {
        try { deleteRegistered(opts.setPath, d.udid); }
        catch (e) { logErr(opts, `delete ${d.udid} failed: ${e.message}`); continue; }
      }
      result.reaped.push({ udid: d.udid, name: d.name || '', kb, kind: 'clone' });
      result.reclaimedKB += kb;
    }

    // 2) Orphan dirs: UUID-named dirs in the set that simctl does NOT know about
    //    (failed clone creations). Guard them by mtime too.
    let entries = [];
    try { entries = fs.readdirSync(opts.setPath, { withFileTypes: true }); } catch (_) {}
    const UUID_RE = /^[0-9A-Fa-f-]{36}$/;
    for (const ent of entries) {
      if (!ent.isDirectory() || !UUID_RE.test(ent.name)) continue;
      if (registered.has(ent.name)) continue;
      const dir = path.join(opts.setPath, ent.name);
      let mtime = 0;
      try { mtime = fs.statSync(dir).mtimeMs; } catch (_) { mtime = 0; }
      if (mtime && mtime > cutoffMs) { result.skippedFresh++; continue; }
      const kb = dirSizeKB(dir);
      if (!opts.dryRun) {
        try { fs.rmSync(dir, { recursive: true, force: true }); }
        catch (e) { logErr(opts, `rm orphan ${ent.name} failed: ${e.message}`); continue; }
      }
      result.reaped.push({ udid: ent.name, name: '(orphan dir)', kb, kind: 'orphan' });
      result.reclaimedKB += kb;
    }
  } finally {
    release();
  }

  return finish(opts, result);
}

function logErr(opts, msg) {
  if (!opts.quiet) process.stderr.write(`[xctest-clean] ${msg}\n`);
}

function finish(opts, result) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = 0;
    return result;
  }
  // In --quiet mode (the LaunchAgent sweep), stay silent on no-op passes so the
  // log isn't spammed every interval — but still record runs that actually
  // reclaimed something.
  const didReap = result.reaped.length > 0;
  if (!opts.quiet || didReap) {
    if (result.lockBusy) {
      if (!opts.quiet) process.stdout.write('[xctest-clean] another cleanup is already running — skipped.\n');
    } else {
      const mb = (result.reclaimedKB / 1024).toFixed(1);
      const verb = opts.dryRun ? 'would reap' : 'reaped';
      const stamp = opts.quiet ? `${new Date().toISOString()} ` : '';
      process.stdout.write(
        `${stamp}[xctest-clean] ${verb} ${result.reaped.length} clone(s), ~${mb} MB; ` +
        `kept ${result.skippedBooted} booted, ${result.skippedFresh} recently-active.\n`
      );
    }
  }
  process.exitCode = 0;
  return result;
}

if (require.main === module) {
  main();
}

module.exports = { main };
