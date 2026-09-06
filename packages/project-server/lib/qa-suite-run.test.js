'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parallelArgs, buildXcodebuildArgs, displayCommand, parseTestCounts,
  failureExcerpt, resolveTimeoutMs, formatSuiteSection, startSuiteRun,
  DEFAULT_TIMEOUT_MINUTES,
} = require('./qa-suite-run');

// ── argv construction ────────────────────────────────────────────────────────

test('parallel testing maps the three configured shapes', () => {
  assert.deepEqual(parallelArgs(false), ['-parallel-testing-enabled', 'NO']);
  assert.deepEqual(parallelArgs(2), ['-parallel-testing-enabled', 'YES', '-parallel-testing-worker-count', '2']);
  assert.deepEqual(parallelArgs(undefined), ['-parallel-testing-enabled', 'YES']);
  assert.deepEqual(parallelArgs(true), ['-parallel-testing-enabled', 'YES']);
});

test('the argv is a list, so a destination with spaces needs no quoting', () => {
  const args = buildXcodebuildArgs({
    project: 'ios/Fazon.xcodeproj', scheme: 'Fazon',
    destination: 'platform=iOS Simulator,name=iPhone 16 Pro', parallelTesting: false,
  });
  // The value must arrive as ONE argv entry — this is the whole reason for
  // spawning without a shell.
  assert.equal(args[args.indexOf('-destination') + 1], 'platform=iOS Simulator,name=iPhone 16 Pro');
});

test('only-testing scopes are appended one flag per target', () => {
  const args = buildXcodebuildArgs({
    project: 'p.xcodeproj', scheme: 'S', destination: 'd',
    onlyTesting: ['STests', 'SUITests/TrendCardTests'],
  });
  assert.ok(args.includes('-only-testing:STests'));
  assert.ok(args.includes('-only-testing:SUITests/TrendCardTests'));
});

test('empty scope entries are dropped rather than emitting a bare flag', () => {
  const args = buildXcodebuildArgs({ project: 'p', scheme: 'S', destination: 'd', onlyTesting: ['', null] });
  assert.ok(!args.some(a => a === '-only-testing:' || a === '-only-testing:null'));
});

test('a missing required field fails loudly instead of building a broken command', () => {
  assert.throws(() => buildXcodebuildArgs({ scheme: 'S', destination: 'd' }), /project is required/);
  assert.throws(() => buildXcodebuildArgs({ project: 'p', destination: 'd' }), /scheme is required/);
  assert.throws(() => buildXcodebuildArgs({ project: 'p', scheme: 'S' }), /destination is required/);
});

test('displayCommand quotes only what needs it', () => {
  const s = displayCommand(['test', '-destination', 'platform=iOS Simulator,name=iPhone 16']);
  assert.match(s, /^xcodebuild test -destination "platform=iOS Simulator,name=iPhone 16"$/);
});

// ── log parsing ──────────────────────────────────────────────────────────────

const TWO_TARGETS = [
  "Test Case '-[FazonTests TrendTests testEMA]' passed (0.031 seconds).",
  "Test Case '-[FazonTests TrendTests testWindow]' failed (0.512 seconds).",
  'Executed 2 tests, with 1 failure (0 unexpected) in 0.543 (0.601) seconds',
  "Test Case '-[FazonUITests CardTests testTap]' passed (4.100 seconds).",
  'Executed 1 test, with 0 failures (0 unexpected) in 4.100 (4.200) seconds',
  '** TEST FAILED **',
].join('\n');

test('per-target summaries are summed, not overwritten', () => {
  // A unit target and a UI target each print their own line. Reading only the
  // last one under-reports the run by however many tests ran first.
  const c = parseTestCounts(TWO_TARGETS);
  assert.equal(c.executed, 3);
  assert.equal(c.failures, 1);
});

test('per-case tallies are tracked separately from the summary', () => {
  const c = parseTestCounts(TWO_TARGETS);
  assert.equal(c.casesPassed, 2);
  assert.equal(c.casesFailed, 1);
});

test('the verdict comes from the banner and is null when there is none', () => {
  assert.equal(parseTestCounts(TWO_TARGETS).succeeded, false);
  assert.equal(parseTestCounts('** TEST SUCCEEDED **').succeeded, true);
  // A killed run has counts but no banner. Inventing a verdict here is how a
  // timed-out suite would get reported as a pass.
  assert.equal(parseTestCounts("Test Case '-[T t]' passed (0.1 seconds).").succeeded, null);
});

test('a build failure is a failed verdict, not an absent one', () => {
  assert.equal(parseTestCounts('** TEST BUILD FAILED **').succeeded, false);
});

test('a log with no summary reports null counts rather than zero', () => {
  // Zero is a claim ("nothing ran"); null is the truth ("we did not see it").
  // The approval gate treats 0 tests as a broken environment, so the
  // difference decides whether a run gets flagged or silently passes.
  const c = parseTestCounts('some unrelated build chatter');
  assert.equal(c.executed, null);
  assert.equal(c.failures, null);
});

test('failureExcerpt keeps the failing lines and drops the noise', () => {
  const log = ['compiling Foo.swift', ...TWO_TARGETS.split('\n'), 'linking'].join('\n');
  const ex = failureExcerpt(log);
  assert.match(ex, /testWindow.*failed/);
  assert.match(ex, /\*\* TEST FAILED \*\*/);
  assert.doesNotMatch(ex, /compiling Foo\.swift/);
});

// ── timeout resolution ───────────────────────────────────────────────────────

test('timeout falls back to the default and rejects nonsense', () => {
  assert.equal(resolveTimeoutMs(undefined), DEFAULT_TIMEOUT_MINUTES * 60000);
  assert.equal(resolveTimeoutMs({ suite_timeout_minutes: 0 }), DEFAULT_TIMEOUT_MINUTES * 60000);
  assert.equal(resolveTimeoutMs({ suite_timeout_minutes: -5 }), DEFAULT_TIMEOUT_MINUTES * 60000);
  assert.equal(resolveTimeoutMs({ suite_timeout_minutes: 'soon' }), DEFAULT_TIMEOUT_MINUTES * 60000);
  assert.equal(resolveTimeoutMs({ suite_timeout_minutes: 10 }), 600000);
});

// ── the agent-facing section ─────────────────────────────────────────────────

const OK_RUN = {
  status: 'completed', command: 'xcodebuild test -scheme S', logPath: '/tmp/qa.log',
  durationMs: 550000, timeoutMs: 2700000,
  counts: { executed: 3, failures: 1, casesPassed: 2, casesFailed: 1, succeeded: false },
  failureExcerpt: "Test Case '-[T testWindow]' failed (0.5 seconds).",
};

test('the section tells the agent not to re-run, in the heading', () => {
  const s = formatSuiteSection(OK_RUN);
  // The agent arrives carrying a skill file that says "run the test suite", so
  // this has to win on the first line it reads.
  const firstLine = s.split('\n').find(l => l.trim());
  assert.match(firstLine, /ALREADY BEEN RUN — DO NOT RUN IT AGAIN/);
});

test('the section carries counts the approval gate can parse', () => {
  const s = formatSuiteSection(OK_RUN);
  assert.match(s, /Executed 3 tests, with 1 failures/);
  assert.match(s, /2 passed, 1 failed/);
  assert.match(s, /\/tmp\/qa\.log/);
});

test('a timeout is reported as a gate failure, never as a result', () => {
  const s = formatSuiteSection({ ...OK_RUN, status: 'timeout', counts: { casesPassed: 40, casesFailed: 0 } });
  assert.match(s, /Gate could not run/);
  assert.match(s, /45-minute limit/);
  // Must not hand back a pass/fail the run never produced.
  assert.doesNotMatch(s, /TEST SUCCEEDED/);
});

test('an absent banner is stated, not inferred', () => {
  const s = formatSuiteSection({ ...OK_RUN, counts: { ...OK_RUN.counts, succeeded: null } });
  assert.match(s, /no SUCCEEDED\/FAILED banner/);
});

test('when the server could not run it, the agent is told to run it itself', () => {
  // The fallback has to be the OLD behaviour, not a dead end: a QA step that
  // silently skips its suite is worse than one that polls.
  const s = formatSuiteSection({ status: 'unavailable', error: 'another xcodebuild test is already running' });
  assert.match(s, /could not/);
  assert.match(s, /another xcodebuild test is already running/);
  assert.match(s, /Run it yourself/);
});

// ── spawning ─────────────────────────────────────────────────────────────────

test('a spawn failure rejects instead of hanging the step', async () => {
  const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qa-suite-')), 'run.log');
  const run = startSuiteRun({ cwd: os.tmpdir(), args: ['test'], logPath, timeoutMs: 5000, env: { PATH: '/nonexistent' } });
  await assert.rejects(run.promise);
});

// ── end-to-end against a stub xcodebuild ─────────────────────────────────────
// Exercises the real spawn → stream → tee → parse path. The parsing tests above
// feed strings straight in; this is the only place that proves the chunked
// stdout path tallies the same way (a `Test Case` line split across two chunks
// would be miscounted, and only a real stream can show that).

function stubDir(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-stub-'));
  const bin = path.join(dir, 'xcodebuild');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return dir;
}

test('a full run is streamed to the log and parsed', async () => {
  const dir = stubDir(`#!/bin/sh
echo "Test Case '-[T testA]' passed (0.10 seconds)."
echo "Test Case '-[T testB]' failed (0.20 seconds)."
echo "Executed 2 tests, with 1 failure (0 unexpected) in 0.3 (0.4) seconds"
echo "** TEST FAILED **"
exit 65
`);
  const logPath = path.join(dir, 'run.log');
  const run = startSuiteRun({
    cwd: dir, args: ['test'], logPath, timeoutMs: 30000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  const r = await run.promise;
  assert.equal(r.status, 'completed');
  assert.equal(r.exitCode, 65, 'a red suite is a normal outcome, not a spawn error');
  assert.equal(r.counts.executed, 2);
  assert.equal(r.counts.failures, 1);
  assert.equal(r.counts.casesPassed, 1);
  assert.equal(r.counts.casesFailed, 1);
  assert.equal(r.counts.succeeded, false);
  // The log is the artifact the agent is pointed at — it must actually exist.
  assert.match(fs.readFileSync(logPath, 'utf8'), /\*\* TEST FAILED \*\*/);
});

test('a run past its timeout is killed and reported as a timeout', async () => {
  const dir = stubDir(`#!/bin/sh
echo "Test Case '-[T testA]' passed (0.10 seconds)."
sleep 60
`);
  const logPath = path.join(dir, 'run.log');
  const run = startSuiteRun({
    cwd: dir, args: ['test'], logPath, timeoutMs: 700,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  const r = await run.promise;
  assert.equal(r.status, 'timeout');
  // Progress survives the kill; the verdict must not be invented.
  assert.equal(r.counts.casesPassed, 1);
  assert.equal(r.counts.succeeded, null);
});

test('cancel() stops a run in flight', async () => {
  const dir = stubDir('#!/bin/sh\nsleep 60\n');
  const run = startSuiteRun({
    cwd: dir, args: ['test'], logPath: path.join(dir, 'run.log'), timeoutMs: 60000,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  run.cancel();
  const r = await run.promise;
  assert.equal(r.status, 'completed'); // not a timeout — we asked it to stop
  assert.ok(r.signal || r.exitCode !== 0);
});

// ── target discovery ─────────────────────────────────────────────────────────

const { discoverProjectAndScheme } = require('./qa-suite-run');

function projectTree(names, dir = 'ios') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-proj-'));
  fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const n of names) fs.mkdirSync(path.join(root, dir, n));
  return root;
}

test('configured scheme and project are used verbatim, with no lookup', () => {
  // No xcodebuild call should be needed — this must work on a machine with no
  // Xcode at all, which is every CI runner and every non-mac contributor.
  const r = discoverProjectAndScheme({
    projectRoot: '/nonexistent',
    simulator: { scheme: 'S', project: 'ios/S.xcodeproj' },
  });
  assert.deepEqual(r, { project: 'ios/S.xcodeproj', scheme: 'S' });
});

test('a project with no .xcodeproj declines rather than guessing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-proj-'));
  assert.match(discoverProjectAndScheme({ projectRoot: root, simulator: {} }).error, /no \.xcodeproj found/);
});

test('two .xcodeproj files are ambiguous, not a coin flip', () => {
  const root = projectTree(['A.xcodeproj', 'B.xcodeproj']);
  assert.match(discoverProjectAndScheme({ projectRoot: root, simulator: {} }).error, /2 \.xcodeproj files/);
});

test('a lone .xcodeproj is found under ios/', () => {
  const root = projectTree(['Only.xcodeproj']);
  // Scheme lookup will fail here (not a real project) — the point is that the
  // PROJECT resolved and the failure names the actionable config key.
  const r = discoverProjectAndScheme({ projectRoot: root, simulator: { scheme: 'Only' } });
  assert.equal(r.project, 'ios/Only.xcodeproj');
});

// ── placeholder rejection ────────────────────────────────────────────────────
//
// The prompt text carries `<Scheme>` on purpose — it means "substitute your
// project's scheme", and an agent reading it does. The server does not. fazon
// sets no simulator.scheme, so a second, legacy resolution produced
// `-only-testing:<Scheme>Tests`; xcodebuild aborted during target resolution in
// 683ms with exit 70, ran nothing, and it surfaced a step later as a gate that
// could not run. These assert the argv builder refuses rather than spawns.

test('a placeholder scheme is refused, not spawned', () => {
  assert.throws(
    () => buildXcodebuildArgs({ project: 'ios/P.xcodeproj', scheme: '<Scheme>', destination: 'd' }),
    /scheme still contains a placeholder/,
  );
});

test('a placeholder in the derived only-testing target is refused too', () => {
  // The exact shape that shipped: project and scheme resolved correctly, and
  // only the scope target — derived from a DIFFERENT resolution of the scheme —
  // still carried the placeholder.
  assert.throws(
    () => buildXcodebuildArgs({
      project: 'ios/Fazon.xcodeproj', scheme: 'Fazon', destination: 'd',
      onlyTesting: ['<Scheme>Tests', 'FazonUITests/DebugLogRingCrossLaunchTests'],
    }),
    /only-testing target still contains a placeholder/,
  );
});

test('a placeholder project or destination is refused', () => {
  assert.throws(() => buildXcodebuildArgs({ project: 'ios/<Scheme>.xcodeproj', scheme: 'S', destination: 'd' }), /project still contains/);
  assert.throws(() => buildXcodebuildArgs({ project: 'p', scheme: 'S', destination: '<destination>' }), /destination still contains/);
});

test('real values that merely contain angle-free punctuation still build', () => {
  // Guard the guard: the check must not reject legitimate destinations.
  const args = buildXcodebuildArgs({
    project: 'ios/Fazon.xcodeproj', scheme: 'Fazon',
    destination: 'platform=iOS Simulator,id=4D61978E-9034-408E-8EC3-0E865D0BD2DD',
    onlyTesting: ['FazonTests', 'FazonUITests/DebugLogRingCrossLaunchTests'],
  });
  assert.ok(args.includes('-only-testing:FazonTests'));
  assert.ok(args.includes('-only-testing:FazonUITests/DebugLogRingCrossLaunchTests'));
});

// ── a suite that failed without running anything ─────────────────────────────
//
// Live case (2026-09-05): a pinned simulator in a stale CoreSimulator state —
// `Failed to prepare device … Invalid connectionUUID` — failed in 38s with exit
// 65, a `** TEST FAILED **` banner and not one test executed. The agent was told
// "0 passed, 0 failed" and "TEST FAILED", which reads as a code failure. It
// reported the gate correctly anyway, by its own diligence rather than because
// the report said so.

const { ranNoTests } = require('./qa-suite-run');

const NEVER_RAN = { executed: null, failures: null, casesPassed: 0, casesFailed: 0, succeeded: false };

test('a failed run with nothing executed is recognised', () => {
  assert.equal(ranNoTests(NEVER_RAN), true);
});

test('a genuinely red suite is NOT treated as "never ran"', () => {
  // The distinction the whole thing turns on: this one goes to the fix loop.
  assert.equal(ranNoTests({ executed: 2, failures: 1, casesPassed: 1, casesFailed: 1, succeeded: false }), false);
  assert.equal(ranNoTests({ executed: null, failures: null, casesPassed: 0, casesFailed: 3, succeeded: false }), false);
});

test('a passing suite and an unfinished one are not "never ran"', () => {
  assert.equal(ranNoTests({ executed: 5, failures: 0, casesPassed: 5, casesFailed: 0, succeeded: true }), false);
  // A timeout kill: no verdict banner. Already reported as a gate failure.
  assert.equal(ranNoTests({ executed: null, failures: null, casesPassed: 40, casesFailed: 0, succeeded: null }), false);
  assert.equal(ranNoTests(null), false);
});

test('the section says nothing ran, and refuses to pick the cause', () => {
  // A build break also executes nothing and IS the devs' problem, so naming the
  // cause here would guess. The honest report is "nothing ran, here is what
  // xcodebuild said" plus where each kind should go.
  const s = formatSuiteSection({
    ...OK_RUN, counts: NEVER_RAN,
    failureExcerpt: 'Testing failed:\n\tDeskRhythm encountered an error (Failed to prepare device …)',
  });
  assert.match(s, /WITHOUT running a single test/);
  assert.match(s, /Gate could not run/);          // the environment route
  assert.match(s, /build broke/i);                 // the devs route
  assert.match(s, /Failed to prepare device/);     // xcodebuild's own reason
  assert.doesNotMatch(s, /Per-case tally/, 'a tally of zero is not a result');
});

test('failureExcerpt keeps the "Testing failed" reason, which every other pattern missed', () => {
  const log = [
    'CopySwiftLibs /Users/x/DerivedData/…',
    'Testing failed:',
    "\tDeskRhythm encountered an error (Failed to prepare device 'iPhone 17 Pro' for impending launch.)",
    '** TEST FAILED **',
  ].join('\n');
  const ex = failureExcerpt(log);
  assert.match(ex, /Testing failed:/);
  assert.match(ex, /Failed to prepare device/);
  assert.doesNotMatch(ex, /CopySwiftLibs/);
});
