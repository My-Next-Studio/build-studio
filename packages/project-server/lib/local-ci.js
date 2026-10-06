'use strict';

/**
 * Run a project's CI on this machine before a push (owner request 2026-10-06).
 *
 * A push to `main` can cost up to an hour of GitHub Actions per attempt, and a
 * failure was only found there (eleven red runs in one day on one project).
 * A project that has a local runner executing the same steps as CI declares it:
 *
 *   deployment:
 *     local_ci:
 *       cmd: npm run ci:local          # run in cwd
 *       cwd: web
 *       status: web/.ci-local/status.json
 *
 * Build Studio starts it, shows its progress, and says next to Push whether the
 * last result still describes HEAD. That is all. Push is never gated by it: the
 * owner chooses before each push whether to run it.
 *
 * THE STATUS FILE belongs to the runner, which writes it with write-then-rename:
 *
 *   { state: running|passed|failed|cancelled, full, commit, dirty, pid,
 *     startedAt, updatedAt, finishedAt, current: { index, total, label },
 *     steps: [{ label, status: pending|running|passed|failed, seconds }] }
 *
 * THE RUN RECORD belongs to Build Studio (in tmp/.logs, ignored): which process
 * group it started, when, where it logs, and whether a cancel was asked for.
 * The runner can be started from a terminal too, so the status file alone is
 * the truth about results; the record only adds what the runner cannot know.
 *
 * This module is the reading and judging; lib/api/local-ci.js does the I/O.
 */

const fs = require('fs');
const path = require('path');
const { assertInside } = require('./path-guard');

const RUN_RECORD = 'local-ci-run.json';
const LOG_FILE = 'local-ci.log';

/**
 * The project's local CI settings, resolved, or null when it has none.
 * `cwd` and `status` must stay inside the project.
 */
function localCiConfig(config) {
  const lc = config && config.deployment && config.deployment.local_ci;
  if (!lc || typeof lc !== 'object') return null;
  if (typeof lc.cmd !== 'string' || !lc.cmd.trim()) return null;
  if (typeof lc.status !== 'string' || !lc.status.trim()) return null;
  const root = config.projectRoot;
  try {
    return {
      cmd: lc.cmd.trim(),
      cwd: assertInside(lc.cwd || '.', root),
      statusFile: assertInside(lc.status, root),
    };
  } catch (_) {
    return null;
  }
}

/** The runner's status file, parsed, or null when absent or unreadable. */
function readStatus(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s === 'object' ? s : null;
  } catch (_) {
    return null;
  }
}

function readRunRecord(logsPath) {
  try { return JSON.parse(fs.readFileSync(path.join(logsPath, RUN_RECORD), 'utf8')); } catch (_) { return null; }
}

function writeRunRecord(logsPath, record) {
  fs.mkdirSync(logsPath, { recursive: true });
  const file = path.join(logsPath, RUN_RECORD);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(record, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

/** Is this pid (or, negative, this process group) alive? */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid === 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? t : null; };

/**
 * What state is the local CI in, all things considered?
 *
 *   idle         never run
 *   starting     Build Studio started it; the runner has not written yet
 *   running      the runner is working
 *   passed / failed / cancelled   as the runner recorded it
 *   interrupted  the status says running but its process is gone — the
 *                machine or Build Studio went down mid-run
 *
 * Two corrections the runner cannot make itself:
 *  - A cancel Build Studio sent reads as `cancelled` even if the runner wrote
 *    `failed`. Cancelling stops the process GROUP, so the step in progress dies,
 *    and a runner that runs steps synchronously sees a failed step, not a signal.
 *  - A run Build Studio started that died before writing any status (a typo in
 *    `cmd`, a missing dependency) reads as `failed`, with its log, rather than
 *    showing whatever the previous run left behind.
 *
 * @param {{status: object|null, run: object|null, statusAlive: boolean, runAlive: boolean}} p
 */
function interpret({ status, run, statusAlive, runAlive }) {
  const runStarted = run ? ms(run.startedAt) : null;
  // The status file is from THIS run when it was started at or after it (a
  // second of skew allowed: the runner stamps its own start a moment later).
  const statusIsCurrent = !!status && (runStarted === null || (ms(status.startedAt) || 0) >= runStarted - 1000);
  const v = (state, extra = {}) => ({ state, statusIsCurrent, ...extra });

  if (run && runAlive && !statusIsCurrent) return v('starting', { ours: true });

  if (run && !runAlive && run.cancelRequestedAt && (!statusIsCurrent || ['running', 'failed', 'cancelled'].includes(status.state))) {
    return v('cancelled', { ours: true, byBuildStudio: true });
  }
  if (run && !runAlive && !statusIsCurrent) {
    return v('failed', { ours: true, failedStep: null, beforeStatus: true, exitCode: run.exitCode ?? null });
  }
  if (!status) return v('idle', { ours: false });

  const ours = !!(run && statusIsCurrent);
  if (status.state === 'running') {
    // Our process group outlives the runner's pid by a moment; either alive is
    // still a run in progress.
    if (statusAlive || (ours && runAlive)) return v('running', { ours });
    return v('interrupted', { ours });
  }
  if (status.state === 'failed') {
    const step = (status.steps || []).find((s) => s && s.status === 'failed');
    return v('failed', { ours, failedStep: step ? step.label : (status.current && status.current.label) || null });
  }
  if (status.state === 'passed' || status.state === 'cancelled') return v(status.state, { ours });
  return v('idle', { ours });
}

/**
 * The badge beside Push: does the last result describe what is about to be
 * pushed? Information only — Push stays enabled whatever it says.
 *
 * @returns {{tone: 'ok'|'neutral'|'warn', label: string}}
 */
function freshness({ status, verdict, head }) {
  const short = (sha) => String(sha || '').slice(0, 7);
  switch (verdict.state) {
    case 'idle': return { tone: 'neutral', label: 'Local CI not run' };
    case 'starting': return { tone: 'neutral', label: 'Local CI starting…' };
    case 'running': {
      const c = status && status.current;
      return { tone: 'neutral', label: c ? `Local CI running — step ${c.index} of ${c.total}` : 'Local CI running' };
    }
    case 'failed': return { tone: 'warn', label: verdict.failedStep ? `Local CI failed at ${verdict.failedStep}` : 'Local CI failed' };
    case 'cancelled': return { tone: 'neutral', label: 'Local CI cancelled' };
    case 'interrupted': return { tone: 'warn', label: 'Local CI interrupted' };
    case 'passed': {
      if (!head || status.commit !== head) return { tone: 'neutral', label: `Local CI not run for HEAD (last ✔ ${short(status.commit)})` };
      if (status.dirty) return { tone: 'warn', label: `Local CI ran on a dirty tree (${short(status.commit)})` };
      if (!status.full) return { tone: 'neutral', label: `Local CI partial run for ${short(status.commit)}` };
      return { tone: 'ok', label: `Local CI ✔ for ${short(status.commit)}` };
    }
    default: return { tone: 'neutral', label: 'Local CI not run' };
  }
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

module.exports = {
  RUN_RECORD, LOG_FILE,
  localCiConfig, readStatus, readRunRecord, writeRunRecord, isAlive, interpret, freshness, logTail,
};
