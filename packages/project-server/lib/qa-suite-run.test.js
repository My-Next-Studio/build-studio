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
  caseActivity,
  resolveStallMs,
  resolveLogCapBytes,
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

// ── simulator pre-flight ─────────────────────────────────────────────────────
//
// xcodebuild boots a simulator itself in the normal case, so this was never
// needed while the AGENT ran the suite and carried the hygiene rules in its role
// file. Hoisting the run to the server moved the work and left the hygiene
// behind: on 2026-09-05 the pinned device sat Shutdown while a different one was
// Booted, and the run died in 38s with `Failed to prepare device … Invalid
// connectionUUID`.

const { parseDestination, simulatorState, preflightSimulator, checkSimulatorAvailable } = require('./qa-suite-run');

const DEVICES = (state = 'Shutdown', available = true) => JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      { udid: 'AAAA1111-2222-3333-4444-555566667777', name: 'iPhone 17 Pro', state, isAvailable: available },
      { udid: 'BBBB1111-2222-3333-4444-555566667777', name: 'iPhone 17 Pro Max', state: 'Booted', isAvailable: true },
    ],
  },
})

/** Records what was invoked, so the test can assert what was NOT. */
function fakeRun(devicesJson, { bootFails = false, bootstatusFails = false } = {}) {
  const calls = []
  const fn = (cmd, args) => {
    calls.push(args.join(' '))
    if (args[1] === 'list') return devicesJson
    if (args[1] === 'boot' && bootFails) throw new Error('Unable to boot device in current state: Creating')
    if (args[1] === 'bootstatus' && bootstatusFails) throw new Error('timed out')
    return ''
  }
  fn.calls = calls
  return fn
}

test('the destination is parsed by id or by name', () => {
  assert.deepEqual(parseDestination('platform=iOS Simulator,id=77c35be1-d546-4067-b503-5624352678e0'),
    { udid: '77C35BE1-D546-4067-B503-5624352678E0', name: null })
  assert.deepEqual(parseDestination('platform=iOS Simulator,name=iPhone 16 Pro'), { udid: null, name: 'iPhone 16 Pro' })
})

test('a destination naming no simulator is left to xcodebuild', async () => {
  // A real device, or a generic platform. Guessing would be worse than passing.
  const r = await preflightSimulator('generic/platform=iOS', { run: fakeRun(DEVICES()) })
  assert.equal(r.ok, true)
  assert.equal(r.action, 'skipped-unparseable')
})

test('a shutdown device is booted, and the boot is waited for', async () => {
  // Boot is asynchronous — without bootstatus the suite still reaches a
  // half-started device, which is the failure being prevented.
  const run = fakeRun(DEVICES('Shutdown'))
  const r = await preflightSimulator('platform=iOS Simulator,id=AAAA1111-2222-3333-4444-555566667777', { run })
  assert.equal(r.ok, true)
  assert.equal(r.action, 'booted')
  assert.ok(run.calls.some(c => c.startsWith('simctl boot AAAA1111')))
  assert.ok(run.calls.some(c => c.includes('bootstatus')), 'must wait for the boot to finish')
})

test('an already-booted device is left completely alone', async () => {
  // Rebooting a healthy simulator is its own outage.
  const run = fakeRun(DEVICES('Booted'))
  const r = await preflightSimulator('platform=iOS Simulator,id=AAAA1111-2222-3333-4444-555566667777', { run })
  assert.equal(r.action, 'already-booted')
  assert.ok(!run.calls.some(c => c.includes('boot ')), 'must not re-boot')
})

test('it NEVER touches another project’s devices', async () => {
  // The device set is shared machine-wide. `shutdown all` / `erase` are
  // forbidden here for the same reason the role docs forbid them to agents —
  // they would kill another project's in-flight run.
  const run = fakeRun(DEVICES('Shutdown'))
  await preflightSimulator('platform=iOS Simulator,id=AAAA1111-2222-3333-4444-555566667777', { run })
  const dangerous = run.calls.filter(c => /shutdown all|erase|delete/.test(c))
  assert.deepEqual(dangerous, [], `must not run: ${dangerous.join('; ')}`)
  assert.ok(!run.calls.some(c => c.includes('BBBB1111')), 'must not touch the other booted device')
})

test('a device that is not in the list is refused, not guessed at', async () => {
  const r = await preflightSimulator('platform=iOS Simulator,id=DEAD0000-0000-0000-0000-000000000000', { run: fakeRun(DEVICES()) })
  assert.equal(r.ok, false)
  assert.match(r.reason, /device list/)
})

test('an unavailable device names the likely cause', async () => {
  const r = await preflightSimulator('platform=iOS Simulator,id=AAAA1111-2222-3333-4444-555566667777', { run: fakeRun(DEVICES('Shutdown', false)) })
  assert.equal(r.ok, false)
  assert.match(r.reason, /runtime/)
})

test('a boot that never completes is reported, not run through', async () => {
  // Starting xcodebuild anyway converts a clear message into a confusing one 38
  // seconds later — which is exactly what happened before this existed.
  const r = await preflightSimulator('platform=iOS Simulator,id=AAAA1111-2222-3333-4444-555566667777',
    { run: fakeRun(DEVICES('Shutdown'), { bootstatusFails: true }), bootTimeoutMs: 100 })
  assert.equal(r.ok, false)
  assert.match(r.reason, /did not finish booting/)
})

test('a benign already-booted race during boot is not treated as failure', async () => {
  const run = fakeRun(DEVICES('Shutdown'))
  const racing = (cmd, args) => {
    if (args[1] === 'boot') throw new Error('Unable to boot device in current state: Booted')
    return run(cmd, args)
  }
  const r = await preflightSimulator('platform=iOS Simulator,id=AAAA1111-2222-3333-4444-555566667777', { run: racing })
  assert.equal(r.ok, true)
})

test('simulatorState returns null rather than throwing when simctl is absent', () => {
  const boom = () => { throw new Error('xcrun: command not found') }
  assert.equal(simulatorState({ udid: 'AAAA' }, boom), null)
})

// ── checkSimulatorAvailable — the cheap half, called at execution start ──────
//
// Preflight ran only inside the QA suite, at the far end of a run. On
// 2026-09-06 an Xcode update removed the iOS 26.2 runtime, which deletes every
// device on it; the pinned UDID stopped resolving and a task_execution burned
// three hours before anything looked. These cover the start-time gate.

test('a deleted device is reported missing, and says why', () => {
  // The runtime-removal case: the UDID is simply gone from the list.
  const r = checkSimulatorAvailable('platform=iOS Simulator,id=DEAD1111-2222-3333-4444-555566667777',
    { run: fakeRun(DEVICES()) })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no simulator matching DEAD1111/)
  assert.match(r.reason, /runtime an Xcode update removed/,
    'the message must point at the actual cause, not just the symptom')
})

test('a device whose runtime is uninstalled is reported unavailable', () => {
  const r = checkSimulatorAvailable('platform=iOS Simulator,id=AAAA1111-2222-3333-4444-555566667777',
    { run: fakeRun(DEVICES('Shutdown', false)) })
  assert.equal(r.ok, false)
  assert.match(r.reason, /unavailable/)
})

test('it never boots — that is preflight’s job, not the start gate’s', () => {
  // This runs synchronously on an HTTP start request. A boot can take minutes.
  const run = fakeRun(DEVICES('Shutdown'))
  const r = checkSimulatorAvailable('platform=iOS Simulator,id=AAAA1111-2222-3333-4444-555566667777', { run })
  assert.equal(r.ok, true)
  assert.equal(r.action, 'available')
  assert.ok(!run.calls.some(c => c.includes('boot')), `must not boot: ${run.calls.join('; ')}`)
})

test('an unparseable destination is passed through, not blocked', () => {
  // Non-iOS projects and real devices must never be gated by this.
  const r = checkSimulatorAvailable('generic/platform=iOS', { run: fakeRun(DEVICES()) })
  assert.equal(r.ok, true)
  assert.equal(r.action, 'skipped-unparseable')
})

test('preflight still reports the missing device it now delegates', async () => {
  // The split must not swallow the failure preflight used to detect itself.
  const r = await preflightSimulator('platform=iOS Simulator,id=DEAD1111-2222-3333-4444-555566667777',
    { run: fakeRun(DEVICES()) })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no simulator matching DEAD1111/)
})

// ── stall detection ──────────────────────────────────────────────────────────
//
// A hung test stops COMPLETING CASES long before the suite timeout expires.
// Measured 2026-09-08: one test hung 90s in, the run was killed at the 45-minute
// limit reporting "no verdict", and the 178 already-passed cases were reported as
// progress right up to the kill — so nothing looked wrong for 44 minutes.

test('caseActivity recognises real xcodebuild case lines', () => {
  const started = caseActivity(
    "Test Case '-[DeskRhythmTests.EntitlementServiceStoreKitTests testAnnual]' started.\n");
  assert.equal(started.any, true);
  assert.equal(started.startedName, '-[DeskRhythmTests.EntitlementServiceStoreKitTests testAnnual]');

  const passed = caseActivity("Test Case '-[T testA]' passed (0.010 seconds).\n");
  assert.equal(passed.passed, 1);
  assert.equal(passed.any, true);

  const failed = caseActivity("Test Case '-[T testB]' failed (0.140 seconds).\n");
  assert.equal(failed.failed, 1);
  assert.equal(failed.any, true);
});

// The false NEGATIVE is the dangerous direction — it would kill a healthy suite.
// A chunk of the runaway log that triggered this work must read as NO activity.
test('caseActivity treats a log storm with no case transitions as no activity', () => {
  const spam = Array(500).fill(
    '2026-09-09 01:29:53.160421+0200 DeskRhythm[24309:4582460] '
    + '[entitlement-resolution] reason=no_history origin=bootstrap').join('\n');
  const act = caseActivity(spam);
  assert.equal(act.any, false, 'log volume alone is not progress');
  assert.equal(act.passed, 0);
  assert.equal(act.failed, 0);
});

test('the last started case in a chunk is the one reported — it is the one that hung', () => {
  const act = caseActivity(
    "Test Case '-[T testA]' started.\nTest Case '-[T testA]' passed (0.01 seconds).\n"
    + "Test Case '-[T testHang]' started.\n");
  assert.equal(act.startedName, '-[T testHang]');
});

test('a run that stops completing cases is killed as stalled and names the hung test', async () => {
  const dir = stubDir(`#!/bin/sh
echo "Test Case '-[T testA]' passed (0.10 seconds)."
echo "Test Case '-[T testHang]' started."
sleep 60
`);
  const logPath = path.join(dir, 'run.log');
  const run = startSuiteRun({
    cwd: dir, args: ['test'], logPath, timeoutMs: 60000, stallMs: 900,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  const r = await run.promise;
  assert.equal(r.status, 'stalled', 'a hang is reported as a stall, not a timeout');
  assert.equal(r.lastCase, '-[T testHang]', 'the culprit is named');
  assert.equal(r.counts.casesPassed, 1, 'progress before the hang survives');
  assert.ok(r.durationMs < 30000, 'it does not wait out the full timeout');
});

// The guard against the dangerous direction: a slow-but-progressing suite must
// survive a stall window shorter than its total runtime.
test('a slow suite that keeps completing cases is NOT stalled', async () => {
  const dir = stubDir(`#!/bin/sh
for i in 1 2 3 4 5 6; do
  echo "Test Case '-[T test$i]' passed (0.10 seconds)."
  sleep 0.3
done
`);
  const run = startSuiteRun({
    cwd: dir, args: ['test'], logPath: path.join(dir, 'run.log'), timeoutMs: 60000, stallMs: 900,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  const r = await run.promise;
  assert.equal(r.status, 'completed');
  assert.equal(r.counts.casesPassed, 6);
});

test('a runaway log is killed once it passes the cap', async () => {
  const dir = stubDir(`#!/bin/sh
echo "Test Case '-[T testA]' started."
while true; do echo "spam spam spam spam spam spam spam spam spam spam"; done
`);
  const run = startSuiteRun({
    cwd: dir, args: ['test'], logPath: path.join(dir, 'run.log'),
    timeoutMs: 60000, stallMs: 0, logCapBytes: 256 * 1024,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  const r = await run.promise;
  assert.equal(r.status, 'oversized');
  assert.ok(r.logBytes > 256 * 1024);
});

test('stall and log-cap windows come from config, with explicit opt-out', () => {
  assert.equal(resolveStallMs(undefined), 5 * 60 * 1000);
  assert.equal(resolveStallMs({ suite_stall_minutes: 12 }), 12 * 60 * 1000);
  assert.equal(resolveStallMs({ suite_stall_minutes: 0 }), 0, '0 disables');
  assert.equal(resolveStallMs({ suite_stall_minutes: -3 }), 5 * 60 * 1000, 'nonsense falls back');

  assert.equal(resolveLogCapBytes(undefined), 500 * 1024 * 1024);
  assert.equal(resolveLogCapBytes({ suite_log_cap_mb: 10 }), 10 * 1024 * 1024);
  assert.equal(resolveLogCapBytes({ suite_log_cap_mb: 0 }), 0, '0 disables');
});

// The reason a stall is a distinct status: the report must name the test. The
// previous "no verdict" message sent a fix loop at nothing.
test('the stalled report names the hung case and does not read as a defect', () => {
  const out = formatSuiteSection({
    status: 'stalled',
    command: 'xcodebuild test',
    logPath: '/tmp/x.log',
    durationMs: 400000,
    stalledForMs: 6 * 60 * 1000,
    lastCase: '-[DeskRhythmTests.EntitlementServiceStoreKitTests testAnnual]',
    counts: { casesPassed: 178, casesFailed: 0 },
  });
  assert.match(out, /STOPPED COMPLETING TESTS/);
  assert.match(out, /testAnnual/, 'the culprit is named');
  assert.match(out, /178 test cases passed/);
  assert.match(out, /Gate could not run/, 'routed as environment, not a defect');
});

test('a stall before any test started says so rather than naming nothing', () => {
  const out = formatSuiteSection({
    status: 'stalled', command: 'xcodebuild test', logPath: '/tmp/x.log',
    durationMs: 400000, stalledForMs: 300000, lastCase: null,
    counts: { casesPassed: 0, casesFailed: 0 },
  });
  assert.match(out, /before the first test/);
});

test('uiTestIdentifiers names the UITest target, not the subfolder the file sits in', () => {
  const { uiTestIdentifiers } = require('./qa-suite-run');
  assert.deepStrictEqual(
    uiTestIdentifiers([
      'ios/AppUITests/Onboarding/FooUITests.swift',
      'ios/AppUITests/BarUITests.swift',
      'ios/AppUITests/Deep/Er/BazUITests.swift',
    ]),
    ['AppUITests/FooUITests', 'AppUITests/BarUITests', 'AppUITests/BazUITests'],
  );
});

test('uiTestIdentifiers skips support files with no XCTestCase, keeps unreadable ones', () => {
  const { uiTestIdentifiers } = require('./qa-suite-run');
  const src = {
    'ios/AppUITests/Flow/Support.swift': 'enum Support { static let x = 1 }',
    'ios/AppUITests/Flow/RealUITests.swift': 'final class RealUITests: XCTestCase {}',
  };
  const readFile = (f) => { if (!(f in src)) throw new Error('ENOENT'); return src[f]; };
  assert.deepStrictEqual(
    uiTestIdentifiers([...Object.keys(src), 'ios/AppUITests/Gone.swift'], { readFile }),
    ['AppUITests/RealUITests', 'AppUITests/Gone'],
  );
});

test('uiTestIdentifiers lists every test class a file declares, not the file name', () => {
  const { uiTestIdentifiers } = require('./qa-suite-run');
  const src = {
    'ios/AppUITests/BasisUITests.swift': [
      'import XCTest',
      'private enum Kit { static func tap() {} }',
      'final class TargetsStepUITests: XCTestCase {}',
      '@MainActor',
      'final class EditorUITests: XCTestCase {}',
      '@MainActor final class SeededUITests: XCTestCase {}',
    ].join('\n'),
    'ios/AppUITests/Base.swift': 'class PRD024BaseUITestCase: XCTestCase {}\nfinal class ScreenUITests: PRD024BaseUITestCase {}',
  };
  assert.deepStrictEqual(
    uiTestIdentifiers(Object.keys(src), { readFile: (f) => src[f] }),
    ['AppUITests/TargetsStepUITests', 'AppUITests/EditorUITests', 'AppUITests/SeededUITests', 'AppUITests/ScreenUITests'],
  );
});

test('buildXcodebuildArgs turns off the post-failure sysdiagnose', () => {
  const { buildXcodebuildArgs } = require('./qa-suite-run');
  const args = buildXcodebuildArgs({ project: 'ios/A.xcodeproj', scheme: 'A', destination: 'platform=iOS Simulator,id=X' });
  const i = args.indexOf('-collect-test-diagnostics');
  assert.ok(i > 0, 'flag missing — one failing test would add up to 10 minutes of simctl diagnose');
  assert.equal(args[i + 1], 'never');
});

// fazon 2026-09-28: `pgrep -f 'xcodebuild.*test'` matched a codex QA agent whose
// prompt (passed as argv) named the xcodebuild command, and QA refused to run.
test('xcodebuildInFlight only counts real xcodebuild processes running a test action', () => {
  const { xcodebuildInFlight, isXcodebuildTestArgs } = require('./qa-suite-run');
  assert.equal(isXcodebuildTestArgs('/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild test -project a -scheme A'), true);
  assert.equal(isXcodebuildTestArgs('xcodebuild -project a -scheme A -destination x test-without-building'), true);
  assert.equal(isXcodebuildTestArgs('xcodebuild build -scheme FooTests -only-testing:FooTests'), false);

  const fake = (procs) => (cmd, args) => {
    if (cmd === 'pgrep') {
      const pids = Object.keys(procs);
      if (!pids.length) { const e = new Error('no match'); e.status = 1; throw e; }
      return pids.join('\n') + '\n';
    }
    return procs[args[args.length - 1]] + '\n';
  };
  // pgrep -x xcodebuild never lists a node/codex agent, whatever its argv says.
  assert.equal(xcodebuildInFlight({ run: fake({}) }), false);
  assert.equal(xcodebuildInFlight({ run: fake({ 101: 'xcodebuild build -scheme A' }) }), false);
  assert.equal(xcodebuildInFlight({ run: fake({ 101: 'xcodebuild build -scheme A', 102: 'xcodebuild test -scheme A' }) }), true);
});

// The iOS unit suite ran in every QA round of a project with a simulator,
// including web-only stories. It is skipped only when the branch changes
// nothing the app is built or tested from.
test('nativeSuiteRelevance: app folder, pbxproj references outside it, and configured paths', () => {
  const { nativeSuiteRelevance } = require('./qa-suite-run');
  const pbx = 'x /* a */ = {isa = PBXFileReference; path = "../contracts/fields-v1.json"; sourceTree = "<group>"; };\n'
    + 'y = {isa = PBXFileReference; path = Foo.swift; };';
  const base = { projectRoot: '/p', projectPath: 'ios/App.xcodeproj', readFile: () => pbx };
  const r = (changedFiles, extra) => nativeSuiteRelevance({ ...base, changedFiles, extraPaths: extra });

  assert.equal(r(['web/src/a.ts', 'docs/x.md']).relevant, false, 'web-only story skips');
  assert.deepEqual(r(['web/src/a.ts']).watched, ['ios/', 'contracts/fields-v1.json']);
  assert.equal(r(['web/a.ts', 'ios/App/Thing.swift']).relevant, true, 'any app file runs it');
  assert.equal(r(['contracts/fields-v1.json']).relevant, true, 'a contract the project references runs it');
  assert.equal(r(['contracts/other.json']).relevant, false, 'an unreferenced contract does not');
  assert.equal(r(['shared/rules.json'], ['shared/']).relevant, true, 'configured native_suite_paths count');
  assert.equal(r([]).relevant, false, 'no changes at all skips');
});

test('nativeSuiteRelevance runs the suite whenever it cannot tell', () => {
  const { nativeSuiteRelevance } = require('./qa-suite-run');
  assert.equal(nativeSuiteRelevance({ projectRoot: '/p', projectPath: 'ios/App.xcodeproj', changedFiles: null }).relevant, true);
  assert.equal(nativeSuiteRelevance({ projectRoot: '/p', projectPath: null, changedFiles: ['web/a.ts'] }).relevant, true);
  assert.equal(nativeSuiteRelevance({ projectRoot: '/p', projectPath: 'App.xcodeproj', changedFiles: ['web/a.ts'] }).relevant, true, 'project at repo root: everything is the app');
  const unreadable = nativeSuiteRelevance({ projectRoot: '/p', projectPath: 'ios/App.xcodeproj', changedFiles: ['web/a.ts'], readFile: () => { throw new Error('ENOENT'); } });
  assert.equal(unreadable.relevant, false);
  assert.deepEqual(unreadable.watched, ['ios/']);
});
