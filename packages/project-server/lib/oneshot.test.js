'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { createOneShotRunner, sweepOldFiles, buildSpawnOptions } = require('./oneshot');

// ─── helpers ────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oneshot-test-'));
}

function cleanDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

/**
 * Build a fake spawn function that returns a controllable child-process stub.
 * spawnCalls accumulates every invocation as { command, args, options }.
 */
function makeFakeSpawn(behavior = 'success') {
  const spawnCalls = [];

  function fakeSpawn(command, args, options) {
    spawnCalls.push({ command, args, options });

    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();

    if (behavior === 'success') {
      setImmediate(() => proc.emit('close', 0));
    } else if (behavior === 'fail') {
      setImmediate(() => proc.emit('close', 1));
    } else if (behavior === 'hang') {
      // never emits close — caller must set maxDurationMs to avoid 10-min wait
    } else if (typeof behavior === 'function') {
      setImmediate(() => behavior(proc));
    }

    return proc;
  }

  fakeSpawn.calls = spawnCalls;
  return fakeSpawn;
}

/** No-op tmux factory — avoids real tmux calls in tests. */
function fakeTmuxOpsFactory() {
  return {
    createSession: () => {},
    pipePaneToLog: () => {},
    killSession: () => {},
  };
}

// Short timeout used in all hang-based tests to avoid leaving 10-min timers.
const SHORT_MS = 50;

// ─── argv-array invocation tests ─────────────────────────────────────────────

test('spawn is called with argv array, not a shell string', async () => {
  const projectRoot = makeTmpDir();
  try {
    const fakeSpawn = makeFakeSpawn('success');
    const { runOneShot } = createOneShotRunner({
      spawnFn: fakeSpawn,
      tmuxOpsFactory: fakeTmuxOpsFactory,
    });

    const { donePromise } = runOneShot({
      projectRoot,
      prompt: 'write a suggestion',
      label: 'suggest',
    });
    await donePromise;

    assert.equal(fakeSpawn.calls.length, 1);
    const { command, args } = fakeSpawn.calls[0];

    // Must be separate argv array — not a shell string
    assert.equal(command, 'claude');
    assert.ok(Array.isArray(args), 'args must be an array');
    assert.equal(args[0], '-p');
    assert.ok(args[1].startsWith('@'), 'prompt arg must start with @');
    assert.ok(args[1].endsWith('.prompt.txt'), 'prompt arg must point to a .prompt.txt file');
    assert.equal(args.length, 2);
  } finally {
    cleanDir(projectRoot);
  }
});

test('prompt content is written to a file, not interpolated into args', async () => {
  const projectRoot = makeTmpDir();
  try {
    const dangerousContent = 'rm -rf /; $(evil) `payload`; "quoted" \'stuff\'';
    const fakeSpawn = makeFakeSpawn('success');
    const { runOneShot } = createOneShotRunner({
      spawnFn: fakeSpawn,
      tmuxOpsFactory: fakeTmuxOpsFactory,
    });

    const { donePromise } = runOneShot({
      projectRoot,
      prompt: dangerousContent,
      label: 'suggest',
    });
    await donePromise;

    const { args } = fakeSpawn.calls[0];
    for (const arg of args) {
      assert.ok(!arg.includes('rm -rf'), 'dangerous content must not appear in args');
      assert.ok(!arg.includes('$(evil)'), 'shell expansion must not appear in args');
    }
  } finally {
    cleanDir(projectRoot);
  }
});

test('two-pass run fires spawn twice sequentially', async () => {
  const projectRoot = makeTmpDir();
  try {
    const fakeSpawn = makeFakeSpawn('success');
    const { runOneShot } = createOneShotRunner({
      spawnFn: fakeSpawn,
      tmuxOpsFactory: fakeTmuxOpsFactory,
    });

    const { donePromise } = runOneShot({
      projectRoot,
      prompt: 'marketing pass prompt',
      label: 'suggest',
      passes: ['brand pass prompt'],
    });
    await donePromise;

    assert.equal(fakeSpawn.calls.length, 2, 'spawn must be called once per pass');
    for (const { command, args } of fakeSpawn.calls) {
      assert.equal(command, 'claude');
      assert.ok(Array.isArray(args));
      assert.equal(args[0], '-p');
      assert.ok(args[1].startsWith('@'));
    }
    // Pass 1 and pass 2 use different prompt files
    assert.notEqual(fakeSpawn.calls[0].args[1], fakeSpawn.calls[1].args[1]);
  } finally {
    cleanDir(projectRoot);
  }
});

// ─── concurrency tests ────────────────────────────────────────────────────────

test('second runOneShot for same projectRoot throws CONFLICT', async () => {
  const projectRoot = makeTmpDir();
  try {
    const { runOneShot } = createOneShotRunner({
      spawnFn: makeFakeSpawn('hang'),
      tmuxOpsFactory: fakeTmuxOpsFactory,
    });

    // First call — starts and hangs (SHORT_MS timeout so timer is cleared promptly)
    const { donePromise } = runOneShot({
      projectRoot,
      prompt: 'first',
      label: 'suggest',
      maxDurationMs: SHORT_MS,
    });

    // Second call — must throw synchronously before any await
    assert.throws(
      () => runOneShot({ projectRoot, prompt: 'second', label: 'suggest', maxDurationMs: SHORT_MS }),
      (err) => {
        assert.equal(err.code, 'CONFLICT');
        assert.ok(err.message.includes('already in progress'));
        return true;
      }
    );

    // Wait for first run to finish (timeout fires) so timers are cleared
    await donePromise;
  } finally {
    cleanDir(projectRoot);
  }
});

test('concurrency flag is cleared after successful completion', async () => {
  const projectRoot = makeTmpDir();
  try {
    const { runOneShot } = createOneShotRunner({
      spawnFn: makeFakeSpawn('success'),
      tmuxOpsFactory: fakeTmuxOpsFactory,
    });

    const { donePromise: dp1 } = runOneShot({ projectRoot, prompt: 'first', label: 'suggest' });
    await dp1;

    // Should not throw — flag cleared; await second run to clear its timer too
    const { donePromise: dp2 } = runOneShot({ projectRoot, prompt: 'second', label: 'suggest' });
    await dp2;
  } finally {
    cleanDir(projectRoot);
  }
});

test('concurrency flag is cleared after error', async () => {
  const projectRoot = makeTmpDir();
  try {
    const { runOneShot } = createOneShotRunner({
      spawnFn: makeFakeSpawn('fail'),
      tmuxOpsFactory: fakeTmuxOpsFactory,
    });

    const { donePromise: dp1 } = runOneShot({ projectRoot, prompt: 'first', label: 'suggest' });
    await dp1;

    // Should not throw — flag cleared on error too
    const { donePromise: dp2 } = runOneShot({ projectRoot, prompt: 'second', label: 'suggest' });
    await dp2;
  } finally {
    cleanDir(projectRoot);
  }
});

test('different projectRoots do not block each other', async () => {
  const root1 = makeTmpDir();
  const root2 = makeTmpDir();
  try {
    const { runOneShot } = createOneShotRunner({
      spawnFn: makeFakeSpawn('hang'),
      tmuxOpsFactory: fakeTmuxOpsFactory,
    });

    const { donePromise: dp1 } = runOneShot({
      projectRoot: root1,
      prompt: 'p1',
      label: 'suggest',
      maxDurationMs: SHORT_MS,
    });

    // Different project — must not throw
    const { donePromise: dp2 } = runOneShot({
      projectRoot: root2,
      prompt: 'p2',
      label: 'suggest',
      maxDurationMs: SHORT_MS,
    });

    await dp1;
    await dp2;
  } finally {
    cleanDir(root1);
    cleanDir(root2);
  }
});

// ─── timeout tests ────────────────────────────────────────────────────────────

test('timeout fires, sets status to "timeout", clears concurrency flag', async () => {
  const projectRoot = makeTmpDir();
  try {
    let killCalled = false;
    function fakeTmuxWithKillTracking() {
      return {
        createSession: () => {},
        pipePaneToLog: () => {},
        killSession: () => { killCalled = true; },
      };
    }

    const { runOneShot, getOneShotStatus } = createOneShotRunner({
      spawnFn: makeFakeSpawn('hang'),
      tmuxOpsFactory: fakeTmuxWithKillTracking,
    });

    const { runId, donePromise } = runOneShot({
      projectRoot,
      prompt: 'slow prompt',
      label: 'suggest',
      maxDurationMs: SHORT_MS,
    });

    const result = await donePromise;

    assert.equal(result.state, 'timeout');
    const status = getOneShotStatus(runId);
    assert.equal(status.state, 'timeout');
    assert.ok(status.durationMs >= 0);
    assert.ok(killCalled, 'killSession must be called on timeout');

    // Concurrency flag cleared — should not throw
    const { donePromise: dp2 } = runOneShot({
      projectRoot,
      prompt: 'after timeout',
      label: 'suggest',
      maxDurationMs: SHORT_MS,
    });
    await dp2;
  } finally {
    cleanDir(projectRoot);
  }
});

test('timeout clears prompt files', async () => {
  const projectRoot = makeTmpDir();
  try {
    const { runOneShot } = createOneShotRunner({
      spawnFn: makeFakeSpawn('hang'),
      tmuxOpsFactory: fakeTmuxOpsFactory,
    });

    const { runId, donePromise } = runOneShot({
      projectRoot,
      prompt: 'slow prompt',
      label: 'suggest',
      maxDurationMs: SHORT_MS,
    });
    await donePromise;

    const oneshotDir = path.join(projectRoot, 'tmp', 'oneshot');
    const promptFiles = fs.existsSync(oneshotDir)
      ? fs.readdirSync(oneshotDir).filter(f => f.startsWith(runId) && f.endsWith('.prompt.txt'))
      : [];
    assert.equal(promptFiles.length, 0, 'prompt files must be removed after timeout');
  } finally {
    cleanDir(projectRoot);
  }
});

// ─── status registry tests ────────────────────────────────────────────────────

test('getOneShotStatus returns null for unknown runId', () => {
  const { getOneShotStatus } = createOneShotRunner({
    spawnFn: makeFakeSpawn('success'),
    tmuxOpsFactory: fakeTmuxOpsFactory,
  });
  assert.equal(getOneShotStatus('nonexistent'), null);
});

test('status transitions to "complete" on success', async () => {
  const projectRoot = makeTmpDir();
  try {
    const { runOneShot, getOneShotStatus } = createOneShotRunner({
      spawnFn: makeFakeSpawn('success'),
      tmuxOpsFactory: fakeTmuxOpsFactory,
    });

    const { runId, donePromise } = runOneShot({
      projectRoot,
      prompt: 'prompt',
      label: 'suggest',
    });

    assert.equal(getOneShotStatus(runId).state, 'running');
    await donePromise;
    assert.equal(getOneShotStatus(runId).state, 'complete');
    assert.ok(getOneShotStatus(runId).durationMs >= 0);
  } finally {
    cleanDir(projectRoot);
  }
});

test('status transitions to "error" on non-zero exit', async () => {
  const projectRoot = makeTmpDir();
  try {
    const { runOneShot, getOneShotStatus } = createOneShotRunner({
      spawnFn: makeFakeSpawn('fail'),
      tmuxOpsFactory: fakeTmuxOpsFactory,
    });

    const { runId, donePromise } = runOneShot({
      projectRoot,
      prompt: 'prompt',
      label: 'suggest',
    });
    await donePromise;
    assert.equal(getOneShotStatus(runId).state, 'error');
    assert.equal(getOneShotStatus(runId).exitCode, 1);
  } finally {
    cleanDir(projectRoot);
  }
});

// ─── session name format test ─────────────────────────────────────────────────

test('sessionName has expected format oneshot-<label>-<timestamp>', async () => {
  const projectRoot = makeTmpDir();
  try {
    const { runOneShot } = createOneShotRunner({
      spawnFn: makeFakeSpawn('hang'),
      tmuxOpsFactory: fakeTmuxOpsFactory,
    });

    const before = Date.now();
    const { sessionName, donePromise } = runOneShot({
      projectRoot,
      prompt: 'p',
      label: 'marketing',
      maxDurationMs: SHORT_MS,
    });
    const after = Date.now();

    assert.ok(sessionName.startsWith('oneshot-marketing-'), `sessionName="${sessionName}"`);
    const ts = parseInt(sessionName.replace('oneshot-marketing-', ''), 10);
    assert.ok(ts >= before && ts <= after, 'timestamp must be in the expected range');

    await donePromise;
  } finally {
    cleanDir(projectRoot);
  }
});

// ─── retention sweep test ─────────────────────────────────────────────────────

test('sweepOldFiles removes .log and .prompt.txt files older than 7 days', () => {
  const dir = makeTmpDir();
  try {
    const old = path.join(dir, 'old.log');
    const oldPrompt = path.join(dir, 'old.prompt.txt');
    const fresh = path.join(dir, 'fresh.log');
    const other = path.join(dir, 'other.txt');

    fs.writeFileSync(old, 'data');
    fs.writeFileSync(oldPrompt, 'data');
    fs.writeFileSync(fresh, 'data');
    fs.writeFileSync(other, 'data');

    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    fs.utimesSync(old, eightDaysAgo, eightDaysAgo);
    fs.utimesSync(oldPrompt, eightDaysAgo, eightDaysAgo);

    sweepOldFiles(dir);

    assert.ok(!fs.existsSync(old), 'old .log must be deleted');
    assert.ok(!fs.existsSync(oldPrompt), 'old .prompt.txt must be deleted');
    assert.ok(fs.existsSync(fresh), 'fresh .log must be kept');
    assert.ok(fs.existsSync(other), 'non-managed file must not be deleted');
  } finally {
    cleanDir(dir);
  }
});

test('sweepOldFiles is a no-op on a non-existent directory', () => {
  assert.doesNotThrow(() => sweepOldFiles('/tmp/this-dir-does-not-exist-oneshot-test'));
});

// ─── buildSpawnOptions — agent_defaults wiring (regression test for the
//     MEDIUM finding raised on PRD-061: oneshot ignored agent_defaults) ─────

test('buildSpawnOptions: no agentDefaults → minimal argv, env preserved', () => {
  const env = { ANTHROPIC_API_KEY: 'sk-test', PATH: '/usr/bin' };
  const original = { ...process.env };
  Object.assign(process.env, env);
  try {
    const { argv, spawnOpts } = buildSpawnOptions({
      promptFile: '/tmp/p.txt',
      projectRoot: '/tmp/proj',
    });
    assert.deepEqual(argv, ['-p', '@/tmp/p.txt']);
    assert.equal(spawnOpts.cwd, '/tmp/proj');
    assert.deepEqual(spawnOpts.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(spawnOpts.env.ANTHROPIC_API_KEY, 'sk-test', 'API key kept when not asked to drop');
  } finally {
    process.env = original;
  }
});

test('buildSpawnOptions: skip_permissions=true → adds --dangerously-skip-permissions', () => {
  const { argv } = buildSpawnOptions({
    promptFile: '/tmp/p.txt',
    projectRoot: '/tmp/proj',
    agentDefaults: { skip_permissions: true },
  });
  assert.ok(argv.includes('--dangerously-skip-permissions'),
    'argv must include --dangerously-skip-permissions');
  assert.deepEqual(argv, ['--dangerously-skip-permissions', '-p', '@/tmp/p.txt']);
});

test('buildSpawnOptions: unset_api_key=true → ANTHROPIC_API_KEY removed from env', () => {
  const original = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'sk-must-not-leak';
  try {
    const { spawnOpts } = buildSpawnOptions({
      promptFile: '/tmp/p.txt',
      projectRoot: '/tmp/proj',
      agentDefaults: { unset_api_key: true },
    });
    assert.ok(!('ANTHROPIC_API_KEY' in spawnOpts.env),
      'API key must be removed so the spawn uses Claude Code subscription, not API spend');
    assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-must-not-leak',
      'process.env must be untouched (defensive copy)');
  } finally {
    process.env = original;
  }
});

test('buildSpawnOptions: model=opus → --model claude-opus-4-6', () => {
  const { argv } = buildSpawnOptions({
    promptFile: '/tmp/p.txt',
    projectRoot: '/tmp/proj',
    agentDefaults: { model: 'opus' },
  });
  assert.deepEqual(argv, ['--model', 'claude-opus-4-6', '-p', '@/tmp/p.txt']);
});

test('buildSpawnOptions: model=sonnet → --model claude-sonnet-4-6', () => {
  const { argv } = buildSpawnOptions({
    promptFile: '/tmp/p.txt',
    projectRoot: '/tmp/proj',
    agentDefaults: { model: 'sonnet' },
  });
  assert.ok(argv.includes('claude-sonnet-4-6'));
});

test('buildSpawnOptions: unknown model name passed through verbatim', () => {
  const { argv } = buildSpawnOptions({
    promptFile: '/tmp/p.txt',
    projectRoot: '/tmp/proj',
    agentDefaults: { model: 'claude-haiku-future-id' },
  });
  assert.ok(argv.includes('claude-haiku-future-id'),
    'unknown model strings should be passed through unchanged so newer model ids work');
});

test('buildSpawnOptions: full example-web-shaped agent_defaults → all three transforms', () => {
  const original = { ...process.env };
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  try {
    const { argv, spawnOpts } = buildSpawnOptions({
      promptFile: '/tmp/p.txt',
      projectRoot: '/tmp/proj',
      agentDefaults: { skip_permissions: true, unset_api_key: true, model: 'opus' },
    });
    assert.deepEqual(argv,
      ['--model', 'claude-opus-4-6', '--dangerously-skip-permissions', '-p', '@/tmp/p.txt']);
    assert.ok(!('ANTHROPIC_API_KEY' in spawnOpts.env));
  } finally {
    process.env = original;
  }
});

// ─── End-to-end: spawnPass receives the assembled argv via runOneShot ───────

test('runOneShot: agent_defaults are threaded into the spawn call', async () => {
  const fakeSpawn = makeFakeSpawn();
  const { runOneShot: localRun } = createOneShotRunner({
    spawnFn: fakeSpawn,
    tmuxOpsFactory: fakeTmuxOpsFactory,
  });

  const projectRoot = makeTmpDir();
  try {
    const { donePromise } = localRun({
      projectRoot,
      prompt: 'pass1',
      label: 'spawn-args-test',
      agentDefaults: { skip_permissions: true, unset_api_key: true, model: 'sonnet' },
      maxDurationMs: 5000,
    });
    await donePromise;

    assert.equal(fakeSpawn.calls.length, 1, 'one pass = one spawn');
    const { command, args, options } = fakeSpawn.calls[0];
    assert.equal(command, 'claude');
    assert.ok(args.includes('--dangerously-skip-permissions'));
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('claude-sonnet-4-6'));
    assert.ok(!('ANTHROPIC_API_KEY' in (options.env || {})),
      'env passed to spawn must drop ANTHROPIC_API_KEY when unset_api_key=true');
  } finally {
    cleanDir(projectRoot);
  }
});
