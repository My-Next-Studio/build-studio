'use strict';

// tmux 3.6a segfaults when destroying a session that is still in a session
// group (server_kill_window → server_destroy_session_group → … →
// cmd_find_from_nothing). Build Studio's hub groups a `view-*` session with
// each agent session, and the crash took the whole server down three times in
// four days. The helpers make sure a session is never destroyed while grouped.
// These run a REAL tmux server on a throwaway socket; the owner's sessions are
// never touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');

const SOCKET = 'bs-grouped-kill-test';
const tmux = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
const quiet = (...args) => { try { return tmux(...args); } catch (_) { return ''; } };
const sessions = () => quiet('list-sessions', '-F', '#{session_name}').split('\n').filter(Boolean).sort();

function helpersOnTestSocket() {
  const real = require('child_process');
  const original = real.execFileSync;
  real.execFileSync = (cmd, args, opts) => (cmd === 'tmux' ? original(cmd, ['-L', SOCKET, ...args], opts) : original(cmd, args, opts));
  delete require.cache[require.resolve('./tmux')];
  const mod = require('./tmux');
  return { mod, restore: () => { real.execFileSync = original; delete require.cache[require.resolve('./tmux')]; } };
}

function setup(t, baseWindows = 1) {
  const { mod, restore } = helpersOnTestSocket();
  t.after(() => { quiet('kill-server'); restore(); });
  quiet('kill-server');
  tmux('new-session', '-d', '-s', 'sentinel');
  tmux('new-session', '-d', '-s', 'wf-1', '-n', 'agent');
  for (let i = 1; i < baseWindows; i++) tmux('new-window', '-t', 'wf-1:', '-n', `other${i}`);
  tmux('new-session', '-d', '-t', 'wf-1', '-s', 'view-agent-abc');
  return mod;
}

test('killing the last window of a grouped session releases its views first', (t) => {
  const mod = setup(t, 1);
  mod.killWindowSafely('wf-1:agent');
  assert.deepEqual(sessions(), ['sentinel'], 'base and view gone, sentinel (the rest of the server) intact');
});

test('killing one of several windows leaves the views alone', (t) => {
  const mod = setup(t, 2);
  mod.killWindowSafely('wf-1:agent');
  assert.deepEqual(sessions(), ['sentinel', 'view-agent-abc', 'wf-1']);
});

test('releaseGroupedViews only touches view-* sessions in that group', (t) => {
  const mod = setup(t, 1);
  tmux('new-session', '-d', '-t', 'wf-1', '-s', 'not-a-view');   // grouped, but not ours to remove
  tmux('new-session', '-d', '-s', 'view-elsewhere');            // a view, but not in this group
  assert.equal(mod.releaseGroupedViews('wf-1'), 1);
  assert.deepEqual(sessions(), ['not-a-view', 'sentinel', 'view-elsewhere', 'wf-1']);
});

test('an ungrouped or missing session is a no-op', (t) => {
  const mod = setup(t, 1);
  assert.equal(mod.releaseGroupedViews('sentinel'), 0);
  assert.equal(mod.releaseGroupedViews('does-not-exist'), 0);
});
