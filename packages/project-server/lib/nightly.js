'use strict';

/**
 * A project's scheduled test run — Operations → Nightly (owner request
 * 2026-11-18).
 *
 * Some suites are too slow for a merge gate (a full Playwright suite at ~30
 * minutes). They run on a schedule on this machine instead, and Build Studio is
 * the scheduler: the owner turns it on per project and picks the time in the
 * tab. The project supplies the runner and declares it:
 *
 *   nightly:
 *     cmd: npm run e2e:nightly           # required: runs one full pass
 *     status_dir: tmp/nightly-e2e        # required: where the runner writes, inside the project
 *     cwd: .                             # optional, for cmd
 *     branch: main                       # optional (default main): the branch it tests
 *     label: E2E                         # optional, the tab's heading
 *     at: "03:30"                        # optional: the time offered when it is first turned on
 *
 * Whether it is on, and at what local time, is per machine: the tab writes
 * `nightly: { enabled, at }` to .build-studio/local.json, which wins over
 * `nightly.at` in config.yaml.
 *
 * WHEN A SCHEDULED RUN STARTS. Once per day, at the first scheduler tick after
 * the chosen time — or later that day when Build Studio was not running then.
 * It waits rather than starts while:
 *   - a run is already going;
 *   - a workflow in this project has an agent or a merge at work (the suite
 *     shares the checkout, its database and dev server);
 *   - the checkout is not on `branch` (it would test another branch's code).
 * It is skipped for the day when `branch` is where the last completed run left
 * it: the same code gave its answer already. A run that could not be carried
 * out (setup error) does not count as that answer.
 *
 * THE STATUS DIRECTORY belongs to the runner:
 *
 *   <status_dir>/runs/<ISO time, ':' and '.' as '-'>/summary.json
 *                                                   run.log (optional)
 *   <status_dir>/run.lock                           the runner's pid while it runs
 *
 * summary.json: { startedAt, finishedAt, head, headAtEnd, branch,
 *   dirtyWorkingTree, passed, failed, flaky, skipped, durationSec,
 *   failures: [string], flakes: [string], error?: string }
 * `head` is a commit sha, abbreviated or full. `error` is set when the run
 * could not be carried out (setup failed); the counts are then absent. A run
 * directory with no summary.json is a run in progress, or one that died.
 *
 * This module is the reading and judging; lib/api/nightly.js does the I/O and
 * the ticking.
 */

const fs = require('fs');
const path = require('path');
const { assertInside } = require('./path-guard');

const RUN_RECORD = 'nightly-run.json';
const SCHEDULER_FILE = 'nightly-scheduler.json';
const LOG_FILE = 'nightly.log';
/** A run Build Studio started reads as starting for this long before the runner shows up. */
const START_GRACE_MS = 90 * 1000;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const isTime = (v) => typeof v === 'string' && TIME_RE.test(v);

/**
 * The project's nightly settings, resolved, or null when it declares none.
 * @param {object} config  the project config
 * @param {object} [local] .build-studio/local.json, parsed
 */
function nightlyConfig(config, local = {}) {
  const n = config && config.nightly;
  if (!n || typeof n !== 'object') return null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  if (!str(n.cmd) || !str(n.status_dir)) return null;
  const root = config.projectRoot;
  const mine = (local && typeof local.nightly === 'object' && local.nightly) || {};
  try {
    return {
      label: str(n.label) || 'Nightly',
      cmd: str(n.cmd),
      cwd: assertInside(str(n.cwd) || '.', root),
      statusDir: assertInside(str(n.status_dir), root),
      branch: str(n.branch) || 'main',
      enabled: mine.enabled === true,
      at: isTime(mine.at) ? mine.at : isTime(n.at) ? n.at : '03:30',
    };
  } catch (_) {
    return null;
  }
}

/** `2026-11-19T02-30-04-105Z` → `2026-11-19T02:30:04.105Z`, or null. */
function runIdToIso(id) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(id || '');
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
}

/**
 * passed | flaky | failed | error | empty — the one word for a finished run.
 * `empty` is a run in which no test ran (a filter that matched nothing, a
 * suite that found no files): not a pass, and not an answer about the code.
 */
function outcome(summary) {
  if (!summary) return null;
  if (summary.error) return 'error';
  if (summary.failed > 0) return 'failed';
  if (summary.flaky > 0) return 'flaky';
  if (!(summary.passed > 0)) return 'empty';
  return 'passed';
}

/**
 * The runs on disk, newest first. A directory without a summary is kept, with
 * `summary: null`: the run in progress, or one that never finished.
 */
function readRuns(statusDir) {
  const runsDir = path.join(statusDir, 'runs');
  let names;
  try { names = fs.readdirSync(runsDir); } catch (_) { return []; }
  return names
    .filter((n) => runIdToIso(n))
    .sort()
    .reverse()
    .map((id) => {
      let summary = null;
      try { summary = JSON.parse(fs.readFileSync(path.join(runsDir, id, 'summary.json'), 'utf8')); } catch (_) { /* in progress or died */ }
      if (!summary || typeof summary !== 'object') summary = null;
      return { id, startedAt: (summary && summary.startedAt) || runIdToIso(id), summary, outcome: outcome(summary) };
    });
}

/** Is this pid (or, negative, this process group) alive? */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid === 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** The runner's lock: { pid, alive } or null when there is none. */
function readLock(statusDir) {
  let raw;
  try { raw = fs.readFileSync(path.join(statusDir, 'run.lock'), 'utf8'); } catch (_) { return null; }
  const pid = Number(String(raw).trim());
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, alive: isAlive(pid) };
}

/**
 * A test's identity across runs. The line number moves whenever the spec file
 * is edited above it, so it is dropped: `feed.spec.ts:428 › chromium › x` and
 * `feed.spec.ts:431 › chromium › x` are the same test.
 */
function testKey(name) {
  return String(name).replace(/^([^\s:›]+):\d+(:\d+)?/, '$1');
}

/**
 * Tests that went red or flaky in more than one of the given runs, the most
 * frequent first. One bad night is noise; the same test twice is a pattern.
 */
function recurring(runs) {
  const byKey = new Map();
  const finished = runs.filter((r) => ['passed', 'flaky', 'failed'].includes(r.outcome));
  for (const r of finished) {
    const seen = new Set();
    const note = (name, kind) => {
      const key = testKey(name);
      if (seen.has(`${key}\0${kind}`)) return;
      seen.add(`${key}\0${kind}`);
      const e = byKey.get(key) || { test: name, failed: 0, flaky: 0, lastSeen: r.startedAt };
      e[kind] += 1;
      byKey.set(key, e);
    };
    for (const n of r.summary.failures || []) note(n, 'failed');
    for (const n of r.summary.flakes || []) note(n, 'flaky');
  }
  return [...byKey.values()]
    .filter((e) => e.failed + e.flaky >= 2)
    .map((e) => ({ ...e, runs: finished.length }))
    .sort((a, b) => (b.failed + b.flaky) - (a.failed + a.flaky) || b.failed - a.failed || a.test.localeCompare(b.test));
}

/**
 * What is happening now?
 *
 *   running    the runner holds its lock, or the process Build Studio started is alive
 *   starting   Build Studio started it moments ago; the runner has not shown up
 *   idle       neither
 */
function currentState({ lock, record, recordAlive, newestRun, now }) {
  const inProgress = newestRun && !newestRun.summary ? newestRun : null;
  if ((lock && lock.alive) || recordAlive) {
    return { state: 'running', startedAt: inProgress ? inProgress.startedAt : (record && record.startedAt) || null, pid: lock && lock.alive ? lock.pid : null };
  }
  const requested = record ? Date.parse(record.startedAt || '') : NaN;
  if (Number.isFinite(requested) && now - requested < START_GRACE_MS) {
    // Started and already finished is not starting.
    const newestStart = newestRun ? Date.parse(newestRun.startedAt || '') : NaN;
    if (!(Number.isFinite(newestStart) && newestStart >= requested - 1000)) {
      return { state: 'starting', startedAt: record.startedAt, pid: null };
    }
  }
  return { state: 'idle', startedAt: null, pid: null };
}

/** The most recent moment, at or before `now`, that the local clock read `at`. */
function latestSlot(now, at) {
  const [h, m] = at.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}

/** The next moment the local clock reads `at`, after `now`. */
function nextSlot(now, at) {
  const d = new Date(latestSlot(now, at));
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** The last completed run on `branch` that gave an answer: tests ran (not a setup error, not empty). */
function lastAnswer(runs, branch) {
  return runs.find((r) => ['passed', 'flaky', 'failed'].includes(r.outcome) && r.summary.head && (!r.summary.branch || r.summary.branch === branch)) || null;
}

/** Does a short or full sha `a` name the same commit as full sha `b`? */
function sameCommit(a, b) {
  const x = String(a || '').trim().toLowerCase();
  const y = String(b || '').trim().toLowerCase();
  if (x.length < 7 || y.length < 7) return false;
  return x.startsWith(y) || y.startsWith(x);
}

/**
 * The scheduler's decision for one tick.
 *
 * @returns {{action: 'none'|'wait'|'skip'|'start', reason?: string, slot?: number}}
 *   none   nothing is due (off, or today's slot is already dealt with)
 *   wait   due, but not now — try again next tick
 *   skip   due, and deliberately not run; the slot is dealt with
 *   start  run it
 */
function decide({ settings, schedulerState, now, current, workflowBusy, checkoutBranch, branchHead, runs }) {
  if (!settings || !settings.enabled) return { action: 'none' };
  const slot = latestSlot(now, settings.at);
  const handled = schedulerState && Number.isFinite(schedulerState.handledSlot) ? schedulerState.handledSlot : null;
  // Never run on the strength of a slot from before the schedule existed: the
  // caller seeds handledSlot when it is turned on or its time changes.
  if (handled === null || handled >= slot) return { action: 'none' };

  if (current.state !== 'idle') return { action: 'skip', slot, reason: 'a run was already in progress' };
  if (workflowBusy) return { action: 'wait', slot, reason: `waiting: ${workflowBusy}` };
  if (checkoutBranch !== settings.branch) {
    return { action: 'wait', slot, reason: `waiting: the checkout is on ${checkoutBranch || 'a detached HEAD'}, not ${settings.branch}` };
  }
  const last = lastAnswer(runs, settings.branch);
  if (last && branchHead && sameCommit(last.summary.head, branchHead)) {
    return { action: 'skip', slot, reason: `${settings.branch} unchanged since the last run (${String(last.summary.head).slice(0, 7)})` };
  }
  return { action: 'start', slot };
}

/**
 * The failure alert for Monitor, or null. Like a scheduled CI workflow's: the
 * condition is "this job is red", so it is keyed on the job and clears itself
 * when a run comes back without failures. Flaky tests alone raise none — they
 * are listed in the tab.
 */
function failureAlert(runs, { project, label }) {
  const finished = runs.filter((r) => r.summary);
  const latest = finished[0];
  if (!latest || !['failed', 'error'].includes(latest.outcome)) return null;
  let streak = 0;
  for (const r of finished) {
    if (!['failed', 'error'].includes(r.outcome)) break;
    streak++;
  }
  const s = latest.summary;
  return {
    source: 'nightly',
    kind: 'nightly-failure',
    project,
    id: `nightly:${project}`,
    severity: streak >= 2 ? 'high' : 'moderate',
    title: `${label} run ${latest.outcome === 'error' ? 'could not run' : 'failed'}`,
    detail: (latest.outcome === 'error' ? s.error : `${s.failed} failed, ${s.passed ?? 0} passed`)
      + (streak >= 2 ? ` — ${streak} runs in a row` : ''),
    open: { fn: 'operations', tab: 'tests', label: 'Tests' },
    since: s.finishedAt || latest.startedAt,
  };
}

/** The last `lines` lines of a log, reading at most the final 64 KB. */
function logTail(file, lines = 60) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    // eslint-disable-next-line no-control-regex
    const text = buf.toString('utf8').replace(/\x1b\[[0-9;]*m/g, '');
    return text.split('\n').slice(-lines).join('\n').replace(/\s+$/, '');
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) { /* ignore */ }
  }
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

module.exports = {
  RUN_RECORD, SCHEDULER_FILE, LOG_FILE, START_GRACE_MS,
  isTime, nightlyConfig, runIdToIso, outcome, readRuns, isAlive, readLock, testKey, recurring,
  currentState, latestSlot, nextSlot, lastAnswer, sameCommit, decide, failureAlert,
  logTail, readJson, writeJson,
};
