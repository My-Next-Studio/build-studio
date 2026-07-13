/**
 * Operations → UITests tab backend.
 *
 * Endpoints:
 *   POST   /api/ops/uitests/run                — start a full xcodebuild test run
 *   GET    /api/ops/uitests/runs               — list recent runs (last 5) + active one
 *   GET    /api/ops/uitests/runs/:id           — run detail
 *   GET    /api/ops/uitests/runs/:id/log       — tail of run log (?lines=N)
 *   POST   /api/ops/uitests/runs/:id/cancel    — kill in-flight xcodebuild
 *
 * Storage: each run gets a JSON metadata file + a log file under
 * tmp/uitests-runs/. Only the latest 5 runs are kept; older ones are
 * pruned at run-start.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const MAX_RUNS = 5;

// Path to the concurrency-safe XCTest clone reaper (one dir up: lib/xctest-clean.js).
const CLEANUP_SCRIPT = path.join(__dirname, '..', 'xctest-clean.js');

// Fire-and-forget the clone reaper. It only deletes Shutdown + idle clones, so
// it is safe to call while THIS run (or another project's run) is mid-flight —
// active clones are Booted and therefore skipped. Detached + unref so it never
// blocks the Express event loop or holds the request open.
function reapLeakedClones() {
  try {
    const child = spawn(process.execPath, [CLEANUP_SCRIPT, '--quiet'], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
  } catch (e) {
    console.error('[ops/uitests] clone reaper spawn failed:', e.message);
  }
}

function createOpsUITestsRouter(config) {
  const router = express.Router();
  const runsDir = path.join(config.tmpPath, 'uitests-runs');
  fs.mkdirSync(runsDir, { recursive: true });

  function metaPath(id) { return path.join(runsDir, `${id}.json`); }
  function logPath(id) { return path.join(runsDir, `${id}.log`); }

  function listRunsSorted() {
    if (!fs.existsSync(runsDir)) return [];
    return fs.readdirSync(runsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try { return JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')); } catch (_) { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
  }

  function pruneOldRuns() {
    const runs = listRunsSorted();
    // Keep MAX_RUNS most recent NON-running entries; an in-flight run never gets pruned.
    const nonRunning = runs.filter(r => r.status !== 'running');
    for (const r of nonRunning.slice(MAX_RUNS - 1)) {
      try { fs.unlinkSync(metaPath(r.id)); } catch (_) {}
      try { fs.unlinkSync(logPath(r.id)); } catch (_) {}
    }
  }

  function findActiveRun() {
    const runs = listRunsSorted();
    return runs.find(r => r.status === 'running') || null;
  }

  function saveMeta(meta) {
    fs.writeFileSync(metaPath(meta.id), JSON.stringify(meta, null, 2));
  }

  // Parse xcodebuild output for pass/fail counts. Looks for the native
  // "Executed N tests, with M failures" line and takes the latest match
  // (xcodebuild prints one per suite plus a final aggregate).
  function parseCounts(logText) {
    const re = /Executed\s+(\d+)\s+tests?,\s+with\s+(\d+)\s+failures?(?:\s+\((\d+)\s+unexpected\))?/gi;
    let last = null; let m;
    while ((m = re.exec(logText)) !== null) {
      last = { total: parseInt(m[1]), failed: parseInt(m[2]) };
    }
    if (!last) return { passed: null, failed: null, skipped: null };
    const skippedMatches = logText.match(/Test (?:case|suite)[^\n]+skipped/gi);
    const skipped = skippedMatches ? skippedMatches.length : 0;
    return { passed: last.total - last.failed, failed: last.failed, skipped };
  }

  function isProcessAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (_) { return false; }
  }

  // If a run says status=running but its PID is gone (e.g. server restarted
  // while xcodebuild was mid-flight), reclassify as errored on the next listing.
  function reconcileStaleRuns() {
    const runs = listRunsSorted();
    let foundStale = false;
    for (const r of runs) {
      if (r.status === 'running' && !isProcessAlive(r.pid)) {
        foundStale = true;
        r.status = 'errored';
        r.completedAt = r.completedAt || new Date().toISOString();
        if (r.startedAt && r.completedAt) {
          r.durationSeconds = Math.round((new Date(r.completedAt).getTime() - new Date(r.startedAt).getTime()) / 1000);
        }
        try {
          const log = fs.existsSync(logPath(r.id)) ? fs.readFileSync(logPath(r.id), 'utf8') : '';
          const counts = parseCounts(log);
          Object.assign(r, counts);
        } catch (_) {}
        saveMeta(r);
      }
    }
    // A run died without its exit handler firing (e.g. server restarted while
    // xcodebuild was mid-flight) — its clones were orphaned. Reap them.
    if (foundStale) reapLeakedClones();
  }

  // ─── POST /api/ops/uitests/run ─────────────────────────────────────────────
  router.post('/ops/uitests/run', (req, res) => {
    reconcileStaleRuns();
    const existing = findActiveRun();
    if (existing) {
      return res.status(409).json({ error: `Run ${existing.id.slice(0, 8)} is already in flight. Cancel it first or wait for completion.`, run: existing });
    }
    pruneOldRuns();
    // Pre-run: reap leaked clones from prior runs before we add more. Keeps the
    // shared XCTestDevices set bounded right at the moment we're about to grow it.
    reapLeakedClones();

    if (!config.simulator || !config.simulator.destination) {
      return res.status(400).json({ error: 'No simulator destination configured. Set simulator.destination in .build-studio/config.yaml.' });
    }

    const scheme = (req.body && req.body.scheme) || config.xcode_scheme || config.name;
    const xcprojRel = config.xcode_project_path || `ios/${scheme}.xcodeproj`;
    const destination = config.simulator.destination;

    const id = crypto.randomBytes(8).toString('hex');
    const startedAt = new Date().toISOString();
    const log = logPath(id);
    fs.writeFileSync(log, `# UITests run ${id}\n# scheme=${scheme} destination=${destination}\n# started=${startedAt}\n\n`);

    // Concurrency caps — xcodebuild has TWO independent parallelism dials, both of
    // which can saturate the machine on their own. Both are configurable via
    // .build-studio/config.yaml:
    //
    //   xcode_build_jobs: N        → -jobs N. Caps concurrent SWIFT COMPILE tasks
    //                                during the build phase. Default is ~core-count
    //                                which saturated this laptop at load=109 on a
    //                                10-core machine (2026-05-26 — typing in other
    //                                apps was useless during the ~90s compile burst).
    //                                Set this even if you don't care about parallel
    //                                testing — compile is where the real CPU spike is.
    //
    //   xcode_parallel_workers: N  → -parallel-testing-worker-count N. Caps concurrent
    //                                simulator clones during the TEST phase. Each
    //                                clone runs a full SpringBoard + app.
    //                                Set to 0 or false to disable parallel testing.
    //
    // Unset = let xcodebuild decide (its defaults are aggressive on multi-core).
    const buildJobsCfg = config.xcode_build_jobs;
    const workersCfg = config.xcode_parallel_workers;
    const args = [
      'test',
      '-project', xcprojRel,
      '-scheme', scheme,
      '-destination', destination,
    ];
    if (typeof buildJobsCfg === 'number' && buildJobsCfg > 0) {
      args.push('-jobs', String(buildJobsCfg));
    }
    if (workersCfg === 0 || workersCfg === false) {
      args.push('-parallel-testing-enabled', 'NO');
    } else {
      args.push('-parallel-testing-enabled', 'YES');
      if (typeof workersCfg === 'number' && workersCfg > 0) {
        args.push('-parallel-testing-worker-count', String(workersCfg));
      }
    }

    // Optional `nice` wrapper — keeps the machine interactive during the Swift
    // compile burst. xcodebuild's `-jobs N` flag is ignored by the modern build
    // system (verified 2026-05-26: load peaked at 113 on a 10-core machine even
    // with `-jobs 4` passed), so the only reliable knob is process priority.
    // nice doesn't slow the build when the machine is idle; it only yields when
    // there's competing interactive work.
    //
    // Configurable via `xcode_nice_level` in .build-studio/config.yaml.
    // Set 0/unset to disable. macOS nice range is -20 (highest priority) to
    // 20 (lowest); positive values lower priority. 15 is a strong "background"
    // value that still uses all idle CPU.
    const niceLevel = config.xcode_nice_level;
    const useNice = typeof niceLevel === 'number' && niceLevel > 0;
    const child = useNice
      ? spawn('nice', ['-n', String(niceLevel), 'xcodebuild', ...args], {
          cwd: config.projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        })
      : spawn('xcodebuild', args, {
          cwd: config.projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
        });

    const meta = {
      id, startedAt, completedAt: null,
      status: 'running',
      passed: null, failed: null, skipped: null, durationSeconds: null,
      logPath: log,
      pid: child.pid,
      scheme, destination,
    };
    saveMeta(meta);

    const logStream = fs.createWriteStream(log, { flags: 'a' });
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);

    child.on('exit', (code, signal) => {
      try {
        const fullLog = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
        const counts = parseCounts(fullLog);
        const completedAt = new Date().toISOString();
        const status = signal === 'SIGKILL' || signal === 'SIGTERM'
          ? 'cancelled'
          : code === 0
            ? 'passed'
            : counts.failed && counts.failed > 0
              ? 'failed'
              : 'errored';
        const updated = {
          ...meta,
          status,
          completedAt,
          durationSeconds: Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000),
          ...counts,
        };
        saveMeta(updated);
      } catch (e) {
        console.error('[ops/uitests] exit handler failed:', e.message);
      }
      // Post-run teardown (runs on pass/fail AND on cancel/kill — this exit
      // handler fires for every termination of the xcodebuild process group).
      // Clones from this run age past the guard window and get reaped here or
      // by a later sweep; older leaks are reclaimed immediately.
      reapLeakedClones();
    });

    child.unref();

    res.json({ run: meta });
  });

  router.get('/ops/uitests/runs', (req, res) => {
    reconcileStaleRuns();
    const runs = listRunsSorted();
    const active = runs.find(r => r.status === 'running') || null;
    res.json({ runs: runs.slice(0, MAX_RUNS), active });
  });

  router.get('/ops/uitests/runs/:id', (req, res) => {
    reconcileStaleRuns();
    const id = req.params.id;
    if (!fs.existsSync(metaPath(id))) return res.status(404).json({ error: 'Run not found' });
    try { res.json({ run: JSON.parse(fs.readFileSync(metaPath(id), 'utf8')) }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/ops/uitests/runs/:id/log', (req, res) => {
    const id = req.params.id;
    const lines = Math.min(Math.max(parseInt(String(req.query.lines || '200')) || 200, 10), 5000);
    const log = logPath(id);
    if (!fs.existsSync(log)) return res.json({ tail: '' });
    try {
      // Read only the tail of the file via a positioned read. xcodebuild parallel-testing
      // logs grow to hundreds of MB during a full UITest run; reading + splitting the
      // entire file synchronously on every poll (every 3-4s from the UI) pegs the Node
      // event loop and froze the dashboard process during the first real run (2026-05-26).
      // 96 KB is enough for ~200 lines of xcodebuild output (typically 200-500 chars/line).
      const stat = fs.statSync(log);
      const READ_BYTES = 96 * 1024;
      const start = Math.max(0, stat.size - READ_BYTES);
      const fd = fs.openSync(log, 'r');
      const buf = Buffer.alloc(stat.size - start);
      try { fs.readSync(fd, buf, 0, buf.length, start); }
      finally { fs.closeSync(fd); }
      const text = buf.toString('utf8');
      const arr = text.split('\n');
      // If we started mid-file, drop the first (probably-partial) line so we don't
      // emit a half-truncated log entry at the top of the tail.
      const trimmed = start > 0 ? arr.slice(1) : arr;
      res.json({
        tail: trimmed.slice(-lines).join('\n'),
        totalBytes: stat.size,
        truncated: start > 0,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/ops/uitests/runs/:id/cancel', (req, res) => {
    const id = req.params.id;
    if (!fs.existsSync(metaPath(id))) return res.status(404).json({ error: 'Run not found' });
    const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
    if (meta.status !== 'running') return res.status(400).json({ error: `Run is ${meta.status}, not running` });
    if (!meta.pid) return res.status(400).json({ error: 'Run has no PID recorded' });
    try {
      try { process.kill(-meta.pid, 'SIGTERM'); } catch (_) { process.kill(meta.pid, 'SIGTERM'); }
      setTimeout(() => {
        if (isProcessAlive(meta.pid)) {
          try { process.kill(-meta.pid, 'SIGKILL'); } catch (_) { try { process.kill(meta.pid, 'SIGKILL'); } catch (_) {} }
        }
      }, 3000);
      meta.status = 'cancelled';
      meta.completedAt = new Date().toISOString();
      meta.durationSeconds = Math.round((new Date(meta.completedAt).getTime() - new Date(meta.startedAt).getTime()) / 1000);
      saveMeta(meta);
      res.json({ run: meta });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

module.exports = { createOpsUITestsRouter };
