'use strict';

/**
 * Run the iOS test suite server-side, so the QA agent never has to babysit it.
 *
 * WHY THIS EXISTS
 *
 * qa_validation used to render an `xcodebuild test` command into the agent's
 * prompt and ask the agent to run it. Because a foreground run blocks the Bash
 * tool (and, past 15 minutes of log silence, trips the idle-stall watchdog),
 * the prompt also told the agent to background the run and tail the log
 * "every few minutes". In practice "every few minutes" became every ~13
 * seconds, and each poll is a full API request that re-reads the whole
 * conversation from cache.
 *
 * Measured across every QA run we can still see (2026-08-26):
 *
 *   fazon FAZ-286   148 requests,  90 polling,  61% of the step's cache reads
 *   deskrhythm #1    39 requests,  17 polling,  47%
 *   deskrhythm #2    47 requests,  16 polling,  37%
 *
 * On FAZ-286 that was 10.8M cache-read tokens spent watching a counter, in a
 * step that was itself 60% of the whole execution run. Non-iOS projects never
 * had the problem: the polling instructions are gated on a configured
 * simulator, and vitest/playwright runs finish inside one foreground call.
 *
 * The cost is turn COUNT, not context size — context sat flat around 90K while
 * 148 requests each paid to re-read it. Nothing the agent learned from poll 40
 * differed from poll 39. So the run moves here: one child process, no tokens,
 * and the agent starts with the answer instead of waiting for it.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not replace the QA agent. Visual smoke, test-data cleanup, failure
 * triage and the gate-parseable report all stay with the agent — only the
 * blocking wait is hoisted.
 */

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** A suite that has not finished in this long is not going to. */
const DEFAULT_TIMEOUT_MINUTES = 45;
/** How long SIGTERM gets to work before SIGKILL. */
const KILL_GRACE_MS = 10 * 1000;
/** Progress is recomputed from the stream, not by re-reading the log. */
const PROGRESS_INTERVAL_MS = 15 * 1000;

/**
 * Parallel-testing flags for a project's `simulator.parallel_testing`.
 *
 * Cloning halves wallclock, but on some iOS-26 simulator cohorts the clones
 * crash on boot (FBSOpenApplicationServiceError cascade) and make XCUITests
 * flaky, so a project can dial it down: `false` → serial, a number → capped
 * workers, unset/true → full parallel.
 */
function parallelArgs(parallelTesting) {
  if (parallelTesting === false) return ['-parallel-testing-enabled', 'NO'];
  if (typeof parallelTesting === 'number') {
    return ['-parallel-testing-enabled', 'YES', '-parallel-testing-worker-count', String(parallelTesting)];
  }
  return ['-parallel-testing-enabled', 'YES'];
}

/**
 * The argv for the run. Built as an ARRAY and spawned without a shell — the
 * agent-facing version of this command was a shell string, which is where
 * `-resultBundlePath` and quoting mistakes used to creep in.
 */
function buildXcodebuildArgs({ project, scheme, destination, parallelTesting, onlyTesting = [] }) {
  if (!project) throw new Error('buildXcodebuildArgs: project is required');
  if (!scheme) throw new Error('buildXcodebuildArgs: scheme is required');
  if (!destination) throw new Error('buildXcodebuildArgs: destination is required');
  // Reject prompt placeholders before they reach xcodebuild.
  //
  // The prompt text this replaced carries `<Scheme>` deliberately — it means
  // "substitute your project's scheme", and an agent reading it does. The
  // server does not, and an unsubstituted one produced
  // `-only-testing:<Scheme>Tests`: xcodebuild aborted during target resolution
  // in 683ms having run nothing, and the failure surfaced a whole step later as
  // a gate that could not run. Fail here instead, where the caller falls back
  // to the agent-run path (2026-08-29).
  for (const [name, value] of [['project', project], ['scheme', scheme], ['destination', destination]]) {
    if (/<[^>]+>/.test(String(value))) {
      throw new Error(`buildXcodebuildArgs: ${name} still contains a placeholder (${value})`);
    }
  }
  const args = ['test', '-project', project, '-scheme', scheme, '-destination', destination];
  args.push(...parallelArgs(parallelTesting));
  for (const t of onlyTesting) {
    if (!t) continue;
    // A scope target is built from the scheme too (`<Scheme>Tests`), so it
    // carries the same placeholder risk and the same silent failure.
    if (/<[^>]+>/.test(String(t))) {
      throw new Error(`buildXcodebuildArgs: only-testing target still contains a placeholder (${t})`);
    }
    args.push(`-only-testing:${t}`);
  }
  return args;
}

/** Human-readable form of the argv, for the prompt and for error messages. */
function displayCommand(args) {
  return ['xcodebuild', ...args.map(a => (/[\s"']/.test(a) ? JSON.stringify(a) : a))].join(' ');
}

/**
 * Test counts from xcodebuild stdout.
 *
 * Two independent sources, kept separate on purpose. `Executed N tests, with M
 * failures` is xcodebuild's own summary and is emitted once PER TEST TARGET, so
 * a unit target plus a UI target produce two lines that must be summed. The
 * per-case `Test Case '...' passed` lines are the finer-grained tally, and they
 * are what progress reporting counts while the run is still going.
 *
 * `succeeded` comes from the `** TEST SUCCEEDED **` / `** TEST FAILED **`
 * banner, and is null when neither appeared — a run killed on timeout has
 * counts but no verdict, and reporting a verdict we did not see would be worse
 * than reporting none.
 */
function parseTestCounts(text) {
  const s = String(text || '');
  let executed = 0;
  let failures = 0;
  let sawSummary = false;
  const summaryRe = /Executed (\d+) tests?, with (\d+) failure/g;
  let m;
  while ((m = summaryRe.exec(s)) !== null) {
    sawSummary = true;
    executed += parseInt(m[1], 10);
    failures += parseInt(m[2], 10);
  }
  const casesPassed = (s.match(/^Test Case .*' passed \(/gm) || []).length;
  const casesFailed = (s.match(/^Test Case .*' failed \(/gm) || []).length;
  const succeeded = /\*\* TEST SUCCEEDED \*\*/.test(s)
    ? true
    : (/\*\* TEST (FAILED|BUILD FAILED) \*\*/.test(s) ? false : null);
  return {
    executed: sawSummary ? executed : null,
    failures: sawSummary ? failures : null,
    casesPassed,
    casesFailed,
    succeeded,
  };
}

/** Lines worth putting in front of the agent when something went wrong. */
function failureExcerpt(text, maxLines = 60) {
  const lines = String(text || '').split('\n');
  const interesting = lines.filter(l =>
    /^Test Case .*' failed \(/.test(l)
    || /error:/i.test(l)
    || /\*\* TEST (FAILED|BUILD FAILED) \*\*/.test(l)
    || /Executed \d+ tests?, with \d+ failure/.test(l)
    // xcodebuild's own summary of WHY, which it prints as `Testing failed:`
    // followed by an indented reason. For a run that never reached a test —
    // a device that would not prepare, a runtime that would not boot — that
    // reason line is the only actionable content in the whole log, and every
    // other pattern here misses it.
    || /^Testing failed:/.test(l)
    || /^\s+\S.*\b(encountered an error|Failed to prepare device|Unable to boot|Simulator device)\b/.test(l));
  return interesting.slice(-maxLines).join('\n');
}

/**
 * Did the suite fail WITHOUT running anything?
 *
 * A red suite and a suite that never started both end in `** TEST FAILED **`,
 * and both report zero passing cases — but they mean opposite things. One is a
 * defect for the devs; the other is an environment fault nobody can fix by
 * changing code, and routing it to the fix loop wastes a full round.
 *
 * The distinguishing fact is that no test was EXECUTED: no per-target summary,
 * and not a single case either way. Seen live when a pinned simulator was in a
 * stale CoreSimulator state — `Failed to prepare device … Invalid connectionUUID`
 * — which failed in 38 seconds with a verdict banner and no tests.
 *
 * This deliberately does not try to name the cause. A build break also executes
 * nothing and IS the devs' problem, so the honest report is "nothing ran, here
 * is what xcodebuild said" rather than a guess about which kind it was.
 */
function ranNoTests(counts) {
  if (!counts) return false;
  return counts.succeeded === false
    && (counts.executed === null || counts.executed === undefined)
    && !counts.casesPassed
    && !counts.casesFailed;
}

/**
 * Which .xcodeproj and which scheme, when the project has not said.
 *
 * `simulator.scheme` / `simulator.project` are optional and frequently unset —
 * the agent-run path told the agent to "find it with xcodebuild -list", so
 * plenty of working projects never needed them. The server has to do the same
 * lookup, and has to be stricter about it: an agent that picks the wrong scheme
 * notices and retries, a server just runs the wrong tests.
 *
 * The trap is real. fazon's project carries TWO schemes — `Copy of Fazon` and
 * `Fazon` — and they sort with the copy first, so "take the first scheme" picks
 * the abandoned duplicate. The rule is therefore: the scheme NAMED AFTER THE
 * PROJECT wins; failing that, a lone scheme wins; anything else is ambiguous
 * and we decline rather than guess, falling back to letting the agent run it.
 *
 * @returns {{project:string, scheme:string}|{error:string}}
 */
function discoverProjectAndScheme({ projectRoot, simulator }) {
  const sim = simulator || {};
  let project = sim.project || null;
  if (!project) {
    for (const dir of ['ios', '.']) {
      const abs = path.join(projectRoot, dir);
      let entries = [];
      try { entries = fs.readdirSync(abs); } catch (_) { continue; }
      const found = entries.filter(f => f.endsWith('.xcodeproj')).sort();
      if (found.length === 1) { project = dir === '.' ? found[0] : path.join(dir, found[0]); break; }
      if (found.length > 1) return { error: `${found.length} .xcodeproj files in ${dir}/ — set simulator.project` };
    }
  }
  if (!project) return { error: 'no .xcodeproj found — set simulator.project' };
  if (sim.scheme) return { project, scheme: sim.scheme };

  let listed;
  try {
    // stderr carries unrelated Xcode chatter (DVTDeviceOperation warnings), so
    // parse from the first brace rather than trusting the whole stream.
    const raw = execFileSync('xcodebuild', ['-list', '-json', '-project', project],
      { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000 });
    listed = JSON.parse(raw.slice(raw.indexOf('{')));
  } catch (e) {
    return { error: `xcodebuild -list failed (${e.message}) — set simulator.scheme` };
  }
  const info = listed.project || listed.workspace || {};
  const schemes = Array.isArray(info.schemes) ? info.schemes : [];
  if (schemes.length === 0) return { error: `no schemes in ${project} — set simulator.scheme` };
  const named = schemes.find(s => s === info.name);
  if (named) return { project, scheme: named };
  if (schemes.length === 1) return { project, scheme: schemes[0] };
  return { error: `${schemes.length} schemes and none named "${info.name}" — set simulator.scheme` };
}

/**
 * Every run this process started, so a shutdown can take them with it.
 *
 * The runs are spawned into their own process GROUP (see startSuiteRun), which
 * makes them survivable by default — that is the point for killing, and a
 * liability at exit. Without this, quitting the app would leave an xcodebuild
 * holding the simulator with nothing left that knows how to wait for it.
 */
const activeRuns = new Set();

/**
 * Signal a whole process group.
 *
 * `child.kill()` signals only xcodebuild itself, and xcodebuild is a
 * supervisor: it spawns the build, the simulator runner and the test host.
 * Signalling the leader alone leaves those running and the stdio pipes open, so
 * the run neither stops nor reports — a timeout would hang instead of firing
 * (caught by the timeout test, which took the full 60s before this).
 */
function killGroup(pid, signal) {
  if (!pid) return;
  try {
    process.kill(-pid, signal); // negative pid = the group
  } catch (_) {
    try { process.kill(pid, signal); } catch (_) { /* already gone */ }
  }
}

/** Stop every suite this process started. Called on server shutdown. */
function killAllActive() {
  for (const pid of activeRuns) killGroup(pid, 'SIGTERM');
  activeRuns.clear();
}

function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Is another xcodebuild test already in flight anywhere on this machine?
 *
 * The simulator handles one test session at a time; a second run queues behind
 * the first, doubles wallclock and leaves zombie clones. When one is running we
 * decline to start rather than queue, and the caller falls back to letting the
 * agent handle it with the pre-existing "one xcodebuild at a time" guidance.
 */
function xcodebuildInFlight() {
  try {
    const out = execFileSync('pgrep', ['-f', 'xcodebuild.*test'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map(s => s.trim()).filter(Boolean).length > 0;
  } catch (_) {
    return false; // pgrep exits non-zero when nothing matched
  }
}

/**
 * Spawn the suite, stream it to `logPath`, and resolve when it ends.
 *
 * Resolves rather than rejects on a failing suite: a red suite is a normal,
 * reportable outcome, not an error in running it. It rejects only when the
 * process could not be started at all.
 *
 * @returns {{pid:number|null, promise:Promise<object>, cancel:function}}
 */
function startSuiteRun({ cwd, args, logPath, timeoutMs, env, onProgress }) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const out = fs.createWriteStream(logPath, { flags: 'w' });
  const startedAt = Date.now();

  let child;
  try {
    // detached: its own process group, so a timeout or a cancel can take the
    // whole tree down rather than just the supervisor. The cost is that the run
    // outlives this process, which is what activeRuns/killAllActive is for.
    child = spawn('xcodebuild', args, { cwd, env: env || process.env, detached: true });
  } catch (e) {
    out.end();
    return { pid: null, promise: Promise.reject(e), cancel: () => {} };
  }
  if (child.pid) activeRuns.add(child.pid);

  // Counts are tallied off the STREAM. Re-reading a multi-megabyte log every
  // 15s to answer "how far along is it" would just move the waste from tokens
  // to disk.
  let tail = '';
  let casesPassed = 0;
  let casesFailed = 0;
  const absorb = (buf) => {
    const chunk = buf.toString('utf8');
    out.write(chunk);
    casesPassed += (chunk.match(/Test Case .*' passed \(/g) || []).length;
    casesFailed += (chunk.match(/Test Case .*' failed \(/g) || []).length;
    tail = (tail + chunk).slice(-200000); // enough for the summary + failures
  };
  child.stdout.on('data', absorb);
  child.stderr.on('data', absorb);

  const progressTimer = onProgress && setInterval(() => {
    try {
      onProgress({ casesPassed, casesFailed, elapsedMs: Date.now() - startedAt });
    } catch (_) { /* progress is advisory — never let it kill the run */ }
  }, PROGRESS_INTERVAL_MS);

  let timedOut = false;
  let killTimer = null;
  const timeoutTimer = timeoutMs > 0 && setTimeout(() => {
    timedOut = true;
    killGroup(child.pid, 'SIGTERM');
    killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS);
  }, timeoutMs);

  const promise = new Promise((resolve, reject) => {
    child.on('error', (e) => {
      if (progressTimer) clearInterval(progressTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (child.pid) activeRuns.delete(child.pid);
      out.end();
      reject(e);
    });
    child.on('close', (code, signal) => {
      if (progressTimer) clearInterval(progressTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (child.pid) activeRuns.delete(child.pid);
      // Resolve only once the log is actually ON DISK. `end()` is asynchronous,
      // so resolving beside it hands the caller a logPath whose tail — the
      // `** TEST FAILED **` banner and the final summary, i.e. the two lines
      // most worth reading — may not be written yet. The caller's very next act
      // is to put that path in front of an agent.
      out.end(() => finish(code, signal));
    });
    const finish = (code, signal) => {
      const counts = parseTestCounts(tail);
      resolve({
        status: timedOut ? 'timeout' : 'completed',
        exitCode: code,
        signal: signal || null,
        durationMs: Date.now() - startedAt,
        logPath,
        counts: { ...counts, casesPassed, casesFailed },
        failureExcerpt: failureExcerpt(tail),
      });
    };
  });

  return {
    pid: child.pid || null,
    promise,
    cancel: () => killGroup(child.pid, 'SIGTERM'),
  };
}

/** Minutes → ms, with the project's override and a floor of one minute. */
function resolveTimeoutMs(qaConfig) {
  const raw = qaConfig && qaConfig.suite_timeout_minutes;
  const minutes = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MINUTES;
  return Math.max(1, minutes) * 60 * 1000;
}

/**
 * The block handed to the QA agent in place of "go run this yourself".
 *
 * Written to be read by an agent whose skill file still tells it to run a test
 * suite: it has to be unambiguous that the run already happened, and it has to
 * carry enough detail that the agent can report counts without opening the log
 * at all in the common case.
 */
function formatSuiteSection(run) {
  const lines = ['\n\n## THE TEST SUITE HAS ALREADY BEEN RUN — DO NOT RUN IT AGAIN'];

  if (run.status === 'unavailable') {
    lines.push(
      '',
      `The workflow tried to run the suite for you and could not: ${run.error}`,
      '',
      'Run it yourself using the iOS guidance below, and report the result as usual.',
    );
    return lines.join('\n');
  }

  lines.push(
    '',
    `The workflow ran the suite before starting you. Command:`,
    '',
    '```',
    run.command,
    '```',
    '',
    `Full log: \`${run.logPath}\` (already on disk — grep it, do not re-run).`,
    `Duration: ${Math.round((run.durationMs || 0) / 1000)}s.`,
    '',
  );

  const c = run.counts || {};
  if (run.status === 'timeout') {
    lines.push(
      `**The run was killed after hitting the ${Math.round(run.timeoutMs / 60000)}-minute limit.** It did not finish, so there is no verdict.`,
      `Progress at the kill: ${c.casesPassed || 0} test cases passed, ${c.casesFailed || 0} failed.`,
      '',
      'Report this on a `**Gate could not run:**` line with the command and the timeout — a suite that could not finish is an environment outcome, not a defect a developer can fix.',
    );
    return lines.join('\n');
  }

  if (ranNoTests(c)) {
    lines.push(
      '**The suite failed WITHOUT running a single test.** No target reported a summary and no test',
      'case passed or failed, so this is not a red suite — nothing was executed.',
      '',
      'Two things look like this, and they go to different places:',
      '',
      '- **The build broke** (compile error, missing symbol) — a real defect. Report it as a normal',
      '  failure so it reaches the fix loop.',
      '- **The environment failed** (simulator would not prepare or boot, toolchain, device state) —',
      '  no developer can fix it by changing code. Report it on a `**Gate could not run:**` line.',
      '',
      'Read the lines below and the log to decide which. Do NOT report a test count either way —',
      'there is no result to report.',
    );
    if (run.failureExcerpt) {
      lines.push('', '### What xcodebuild said', '', '```', run.failureExcerpt.slice(0, 6000), '```');
    }
    return lines.join('\n');
  }

  if (c.executed !== null && c.executed !== undefined) {
    lines.push(`**Executed ${c.executed} tests, with ${c.failures} failures.**`);
  }
  lines.push(`Per-case tally: ${c.casesPassed || 0} passed, ${c.casesFailed || 0} failed.`);
  lines.push(
    '',
    run.counts.succeeded === true
      ? 'xcodebuild reported `** TEST SUCCEEDED **`.'
      : run.counts.succeeded === false
        ? 'xcodebuild reported `** TEST FAILED **`.'
        : 'xcodebuild printed no SUCCEEDED/FAILED banner — say so rather than inferring one.',
  );

  if (run.failureExcerpt) {
    lines.push('', '### Failure lines from the log', '', '```', run.failureExcerpt.slice(0, 6000), '```');
  }

  lines.push(
    '',
    'Use these counts in your report — they satisfy the approval gate. Open the log only for detail you actually need',
    '(a specific failure, a stack trace). Re-running the suite duplicates 20-40 minutes of work and is never required.',
  );
  return lines.join('\n');
}

module.exports = {
  DEFAULT_TIMEOUT_MINUTES,
  PROGRESS_INTERVAL_MS,
  parallelArgs,
  discoverProjectAndScheme,
  buildXcodebuildArgs,
  displayCommand,
  parseTestCounts,
  failureExcerpt,
  ranNoTests,
  isPidAlive,
  killGroup,
  killAllActive,
  xcodebuildInFlight,
  startSuiteRun,
  resolveTimeoutMs,
  formatSuiteSection,
};
