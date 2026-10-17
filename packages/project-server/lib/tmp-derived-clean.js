#!/usr/bin/env node
/**
 * tmp-derived-clean — concurrency-safe reaper for leaked Xcode DerivedData dirs
 * left behind by agent test builds.
 *
 * The dashboard's QA / Dev agents build with an isolated `-derivedDataPath` —
 * done deliberately to avoid corrupting an open Xcode IDE's build.db — but they
 * never delete these dirs afterward. They accumulate (~0.3–1.7 GB each, one+ per
 * PRD run × every fix round × every project) and fill the internal data volume.
 * macOS's own /tmp cleaner won't remove them (background scans keep bumping
 * their access time), and the XCTest *clone* reaper (xctest-clean.js) does not
 * cover them — so this is the recurring disk-pressure leak.
 *
 * TWO LOCATIONS, not one. Agents put these under /private/tmp (e.g.
 * `example-ios-dd-prd026`) AND inside the project itself, under `ios/build/`,
 * because a project's own build guidance tells them to isolate from the IDE and
 * says nothing about where. Scanning only /private/tmp missed an iOS project
 * holding 41 dirs / 21.8 GB in-tree (2026-08-17). `--scan-projects` reads the
 * Build Studio registry at run time and covers both.
 *
 * SAFETY INVARIANT — a DerivedData dir is reaped only when ALL of these hold:
 *   1. It IS a DerivedData root — contains BOTH `info.plist` AND a `Build`
 *      subdirectory. This signature won't match arbitrary /tmp content, nor a
 *      web project's `build/` output.
 *   2. No running `xcodebuild` references it via `-derivedDataPath` — an active
 *      build in ANY project keeps its dir (we parse the process table), so
 *      cleanup never disturbs a live run in another project. Relative paths are
 *      resolved against the BUILD PROCESS's cwd; see activeBuildDerivedPaths.
 *   3. Its last build is older than --guard-minutes (default 180), measured from
 *      the `Build` subdir's mtime (the last actual build) — NOT the top-level dir
 *      mtime, which Spotlight / backup scans bump and would otherwise make every
 *      dir look perpetually "fresh" and never reapable.
 *
 * A cross-process PID lock (in the OS temp dir) serialises concurrent runs (the
 * launchd sweep + any per-run hook) so they don't double-delete.
 *
 * Reaping a long-idle dir from a still-open (paused) workflow costs at most one
 * clean rebuild when that run next builds — never data loss; DerivedData is a
 * pure build cache. Worth it to bound disk.
 *
 * Usage:
 *   node tmp-derived-clean.js [--dry-run] [--guard-minutes N] [--json] [--quiet]
 *                             [--tmp-dir <path>]
 * Exit code is always 0 on a clean run (including "another cleanup is already
 * running" — that process owns the work).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { REGISTRY_PATH } = require('@build-studio/shared/constants');
const { execFileSync } = require('child_process');

const CHILD_ENV = {
  ...process.env,
  PATH: `/usr/bin:/bin:/usr/sbin:/sbin:${process.env.PATH || ''}`,
};

/** Build dirs a managed project keeps its isolated DerivedData in. */
const PROJECT_BUILD_SUBDIRS = ['ios/build', 'build'];

/**
 * Scan targets derived from the Build Studio project registry.
 *
 * Agents do not always build under /private/tmp. An iOS project observed 41
 * DerivedData dirs totalling 21.8 GB inside `<root>/ios/build` — one per agent
 * per fix/review round, none ever removed — because the reaper only ever looked
 * at /private/tmp (2026-08-17). Reading the registry at RUN time rather than
 * baking paths into the LaunchAgent means projects added later are swept
 * without reinstalling anything.
 */
function registryScanDirs(registryPath) {
  const dirs = [];
  let reg;
  try { reg = JSON.parse(fs.readFileSync(registryPath, 'utf8')); } catch (_) { return dirs; }
  for (const entry of Object.values((reg && reg.projects) || {})) {
    const root = entry && entry.path;
    if (!root) continue;
    for (const sub of PROJECT_BUILD_SUBDIRS) {
      const dir = path.join(root, sub);
      if (fs.existsSync(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

function parseArgs(argv) {
  const opts = {
    dryRun: false,
    guardMinutes: 180,
    json: false,
    quiet: false,
    dirs: [],
    scanProjects: false,
    registry: REGISTRY_PATH,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--scan-projects') opts.scanProjects = true;
    else if (a === '--guard-minutes') opts.guardMinutes = Number(argv[++i]);
    else if (a === '--registry') opts.registry = argv[++i];
    // --tmp-dir is the pre-multi-dir spelling, kept so existing LaunchAgents
    // and any fork's wrapper keep working unchanged.
    else if (a === '--tmp-dir' || a === '--dir') opts.dirs.push(argv[++i]);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  if (!Number.isFinite(opts.guardMinutes) || opts.guardMinutes < 0) opts.guardMinutes = 180;
  if (opts.dirs.length === 0) opts.dirs.push('/private/tmp');
  if (opts.scanProjects) opts.dirs.push(...registryScanDirs(opts.registry));
  // A path listed twice (explicitly and via the registry) must not be scanned
  // twice — the second pass would re-`du` dirs the first already removed.
  opts.dirs = [...new Set(opts.dirs)];
  return opts;
}

function printHelp() {
  process.stdout.write(
    'tmp-derived-clean — reap leaked Xcode DerivedData dirs\n' +
    '  --dry-run            report what would be deleted, delete nothing\n' +
    '  --guard-minutes N    skip dirs whose last build is within N minutes (default 180)\n' +
    '  --json               emit a JSON summary\n' +
    '  --quiet              suppress the human summary on no-op passes\n' +
    '  --dir <path>         directory to scan, repeatable (default /private/tmp)\n' +
    '  --tmp-dir <path>     alias of --dir, kept for compatibility\n' +
    '  --scan-projects      also scan ios/build and build/ of every registered project\n' +
    '  --registry <path>    project registry (default ~/.build-studio/registry.json)\n'
  );
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

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
        try { fs.unlinkSync(lockPath); } catch (_) {}
        continue;
      }
      sleepSync(250);
    }
  }
  return null;
}

function realpathOrSelf(p) {
  try { return fs.realpathSync(p); } catch (_) { return p; }
}

/** Working directory of a running process, or null. */
function processCwd(pid) {
  try {
    const out = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      env: CHILD_ENV, encoding: 'utf8', timeout: 10000,
    });
    const m = out.match(/^n(.+)$/m);
    return m ? m[1] : null;
  } catch (_) { return null; }
}

/**
 * DerivedData paths of every running xcodebuild (any project).
 *
 * **Relative paths are the subtle case.** Agents routinely run
 * `cd <project>/ios; xcodebuild … -derivedDataPath build/DerivedDataX`, so the
 * value on the command line is relative to THAT process's cwd — not to the
 * reaper's. Resolving it here with a bare `realpath` produced a path under the
 * reaper's own directory, which matches nothing, so the "never touch a live
 * build" invariant silently did not hold: a real run was observed protected
 * only by the freshness guard, with the active-build count reporting zero
 * (2026-08-17).
 *
 * Relative values are therefore resolved against the build process's own cwd.
 * If that cannot be read (process exited mid-scan, lsof unavailable), the
 * BASENAME is guarded instead — deliberately over-protective: keeping an
 * unrelated dir of the same name costs disk until the next sweep, whereas
 * deleting a live build's DerivedData corrupts a running test run.
 *
 * @returns {{paths:Set<string>, basenames:Set<string>}}
 */
function activeBuildDerivedPaths() {
  const paths = new Set();
  const basenames = new Set();
  let out = '';
  try {
    out = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,command='], {
      env: CHILD_ENV, encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024,
    });
  } catch (_) { return { paths, basenames }; }
  for (const line of out.split('\n')) {
    if (!/xcodebuild\b/.test(line)) continue;
    const m = line.match(/-derivedDataPath(?:=|\s+)(\S+)/);
    if (!m) continue;
    const raw = m[1];
    if (path.isAbsolute(raw)) { paths.add(realpathOrSelf(raw)); continue; }
    const pidMatch = line.trim().match(/^(\d+)\s/);
    const cwd = pidMatch ? processCwd(pidMatch[1]) : null;
    if (cwd) paths.add(realpathOrSelf(path.resolve(cwd, raw)));
    else basenames.add(path.basename(raw));
  }
  return { paths, basenames };
}

/** A dir is an Xcode DerivedData root iff it has both info.plist and Build/. */
function isDerivedDataRoot(dir) {
  try {
    if (!fs.existsSync(path.join(dir, 'info.plist'))) return false;
    return fs.statSync(path.join(dir, 'Build')).isDirectory();
  } catch (_) { return false; }
}

/**
 * Last-build time — the `Build` subdir's mtime (updated by real builds, not by
 * top-level dir scans). Falls back to info.plist, then the dir itself.
 */
function lastBuildMtime(dir) {
  for (const inner of ['Build', 'info.plist']) {
    try { return fs.statSync(path.join(dir, inner)).mtimeMs; } catch (_) {}
  }
  try { return fs.statSync(dir).mtimeMs; } catch (_) { return 0; }
}

function dirSizeKB(dir) {
  try {
    const out = execFileSync('/usr/bin/du', ['-sk', dir], { env: CHILD_ENV, encoding: 'utf8', timeout: 30000 });
    return parseInt(out.trim().split(/\s+/)[0], 10) || 0;
  } catch (_) { return 0; }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const result = {
    dirs: opts.dirs,
    dryRun: opts.dryRun,
    guardMinutes: opts.guardMinutes,
    reaped: [],          // { dir, kb }
    skippedActive: 0,    // referenced by a running xcodebuild
    skippedFresh: 0,     // built within the guard window
    reclaimedKB: 0,
    lockBusy: false,
  };

  const scanDirs = opts.dirs.filter((d) => fs.existsSync(d));
  if (scanDirs.length === 0) {
    return finish(opts, result);
  }

  const release = acquireLock(path.join(os.tmpdir(), 'tmp-derived-clean.lock'));
  if (!release) {
    result.lockBusy = true;
    return finish(opts, result);
  }

  try {
    const cutoffMs = Date.now() - opts.guardMinutes * 60 * 1000;
    // Read the process table ONCE for the whole sweep. Re-reading per directory
    // would let a build that starts mid-sweep be missed by an earlier scan.
    const { paths: activePaths, basenames: activeNames } = activeBuildDerivedPaths();

    for (const scanDir of scanDirs) {
      let entries = [];
      try { entries = fs.readdirSync(scanDir, { withFileTypes: true }); } catch (_) {}

      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const dir = path.join(scanDir, ent.name);
        if (!isDerivedDataRoot(dir)) continue;

        // (2) An active build owns this dir — never touch a live run's DerivedData.
        //     The basename check covers a build whose cwd could not be read.
        if (activePaths.has(realpathOrSelf(dir)) || activeNames.has(ent.name)) {
          result.skippedActive++;
          continue;
        }

        // (3) Built recently — leave it (likely an in-flight or just-finished run).
        const mtime = lastBuildMtime(dir);
        if (mtime && mtime > cutoffMs) { result.skippedFresh++; continue; }

        const kb = dirSizeKB(dir);
        if (!opts.dryRun) {
          try { fs.rmSync(dir, { recursive: true, force: true }); }
          catch (e) { logErr(opts, `rm ${dir} failed: ${e.message}`); continue; }
        }
        result.reaped.push({ dir, kb });
        result.reclaimedKB += kb;
      }
    }
  } finally {
    release();
  }

  return finish(opts, result);
}

function logErr(opts, msg) {
  if (!opts.quiet) process.stderr.write(`[tmp-derived-clean] ${msg}\n`);
}

function finish(opts, result) {
  if (opts.json) {
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = 0;
    return result;
  }
  const didReap = result.reaped.length > 0;
  if (!opts.quiet || didReap) {
    if (result.lockBusy) {
      if (!opts.quiet) process.stdout.write('[tmp-derived-clean] another cleanup is already running — skipped.\n');
    } else {
      const mb = (result.reclaimedKB / 1024).toFixed(1);
      const verb = opts.dryRun ? 'would reap' : 'reaped';
      const stamp = opts.quiet ? `${new Date().toISOString()} ` : '';
      process.stdout.write(
        `${stamp}[tmp-derived-clean] ${verb} ${result.reaped.length} DerivedData dir(s), ~${mb} MB; ` +
        `kept ${result.skippedActive} active-build, ${result.skippedFresh} recently-built.\n`
      );
    }
  }
  process.exitCode = 0;
  return result;
}

if (require.main === module) {
  main();
}

module.exports = { main, parseArgs, registryScanDirs, isDerivedDataRoot };
