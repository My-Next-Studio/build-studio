'use strict';

// A launch must survive the tmux session disappearing underneath it.
//
// Reaping an agent's window when its feedback lands ends the session if it was
// the last window, and tmux tears the server down asynchronously. A step
// launched in the same request as the reap can therefore see the session alive
// and then find the server gone a moment later. launch-studio hit this on
// 2026-08-01: the fix planner reported, its window was reaped, and the
// fix_execution launch that followed died on `no server running` — leaving the
// step half-started with an errored agent and no process.
//
// These drive a REAL tmux server on a throwaway socket, because the bug lives
// in tmux's own lifecycle (last window closes → server exits), which a stub
// cannot reproduce.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');

const SOCKET = 'bs-ensure-window-test';
const tmux = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
const quiet = (...args) => { try { tmux(...args); } catch (_) {} };

/** createTmuxOps bound to the throwaway socket, so real sessions are untouched. */
function opsOnTestSocket() {
  const real = require('child_process');
  const originalExecFileSync = real.execFileSync;
  // Wrap execFileSync so every tmux call in tmux.js goes to our socket.
  real.execFileSync = (cmd, args, opts) => (cmd === 'tmux'
    ? originalExecFileSync(cmd, ['-L', SOCKET, ...args], opts)
    : originalExecFileSync(cmd, args, opts));
  delete require.cache[require.resolve('./tmux')];
  const { createTmuxOps } = require('./tmux');
  const ops = createTmuxOps({ name: 'test' });
  return { ops, restore: () => { real.execFileSync = originalExecFileSync; delete require.cache[require.resolve('./tmux')]; } };
}

test('ensureWindow creates the session when there is none', (t) => {
  const { ops, restore } = opsOnTestSocket();
  t.after(() => { quiet('kill-server'); restore(); });
  quiet('kill-server');

  const target = ops.ensureWindow('s1', 'first', process.cwd());
  assert.equal(target, 's1:first');
  assert.equal(ops.hasSession('s1'), true);
});

test('ensureWindow adds a window to a live session', (t) => {
  const { ops, restore } = opsOnTestSocket();
  t.after(() => { quiet('kill-server'); restore(); });
  quiet('kill-server');

  ops.ensureWindow('s1', 'first', process.cwd());
  const target = ops.ensureWindow('s1', 'second', process.cwd());
  assert.match(target, /^s1:\d+$/); // indexed, not named
  const windows = tmux('list-windows', '-t', 's1', '-F', '#{window_name}').trim().split('\n');
  assert.deepEqual(windows.sort(), ['first', 'second']);
});

test('ensureWindow survives the session dying between the check and the call', (t) => {
  // The launch-studio regression, reproduced: the session exists when the
  // launch starts, and is gone by the time the window is created.
  const { ops, restore } = opsOnTestSocket();
  t.after(() => { quiet('kill-server'); restore(); });
  quiet('kill-server');

  ops.ensureWindow('s1', 'only-window', process.cwd());
  assert.equal(ops.hasSession('s1'), true);

  // Reap the last window — exactly what the feedback handler now does. tmux
  // ends the session and shuts the server down.
  ops.killWindowAndChildren('s1:only-window');

  // The launch proceeds believing the session is alive. It must not throw.
  const target = ops.ensureWindow('s1', 'next-step', process.cwd());
  assert.equal(target, 's1:next-step');
  assert.equal(ops.hasSession('s1'), true);
  assert.equal(tmux('list-windows', '-t', 's1', '-F', '#{window_name}').trim(), 'next-step');
});

test('a genuine window failure still surfaces', (t) => {
  // The recovery must not swallow errors that are not the race — a session
  // that is still standing when the call fails means something else is wrong.
  const { ops, restore } = opsOnTestSocket();
  t.after(() => { quiet('kill-server'); restore(); });
  quiet('kill-server');

  ops.ensureWindow('s1', 'live', process.cwd());
  assert.throws(
    () => ops.ensureWindow('s1', 'bad', '/definitely/not/a/directory/here'),
    /.+/,
    'a bad cwd on a live session should throw',
  );
  assert.equal(ops.hasSession('s1'), true);
});
