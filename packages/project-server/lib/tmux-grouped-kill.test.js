'use strict';

// tmux 3.6a segfaults when kill-window empties a session that is still in a
// session group and a grouped session sorts before it (server_kill_window →
// server_destroy_session_group → … → cmd_find_from_nothing). Build Studio's hub
// groups a `view-*` session with each agent session, and `view-` sorts before
// `wf-`, so the crash took the whole server down, agents and terminals with it.
// The helpers never kill-window a session's last window, and never treat a tmux
// call that timed out as "nothing grouped".
// These run a REAL tmux server on a throwaway socket; the owner's sessions are
// never touched. A detached view is enough to crash 3.6a, so no client needed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');

const SOCKET = 'bs-grouped-kill-test';
const tmux = (...args) => execFileSync('tmux', ['-L', SOCKET, ...args], { stdio: ['pipe', 'pipe', 'pipe'] }).toString();
const quiet = (...args) => { try { return tmux(...args); } catch (_) { return ''; } };
const sessions = () => quiet('list-sessions', '-F', '#{session_name}').split('\n').filter(Boolean).sort();
const windowNames = (s) => quiet('list-windows', '-t', `=${s}`, '-F', '#{window_name}').split('\n').filter(Boolean).sort();

/**
 * tmux.js bound to the test socket. `hook(args)` runs before each tmux call the
 * helpers make, and may throw to stand in for a call that failed; `after(args)`
 * runs once it has returned.
 */
function helpersOnTestSocket({ hook = () => {}, after = () => {} } = {}) {
  const real = require('child_process');
  const original = real.execFileSync;
  real.execFileSync = (cmd, args, opts) => {
    if (cmd !== 'tmux') return original(cmd, args, opts);
    hook(args);
    const out = original(cmd, ['-L', SOCKET, ...args], opts);
    after(args);
    return out;
  };
  delete require.cache[require.resolve('./tmux')];
  const mod = require('./tmux');
  return { mod, restore: () => { real.execFileSync = original; delete require.cache[require.resolve('./tmux')]; } };
}

function setup(t, baseWindows = 1, hooks) {
  const { mod, restore } = helpersOnTestSocket(hooks);
  t.after(() => { quiet('kill-server'); restore(); });
  quiet('kill-server');
  tmux('new-session', '-d', '-s', 'sentinel');
  tmux('new-session', '-d', '-s', 'wf-1', '-n', 'agent');
  for (let i = 1; i < baseWindows; i++) tmux('new-window', '-t', 'wf-1:', '-n', `other${i}`);
  tmux('new-session', '-d', '-t', 'wf-1', '-s', 'view-agent-abc');
  return mod;
}

function timedOut() {
  const e = new Error('spawnSync tmux ETIMEDOUT');
  e.code = 'ETIMEDOUT';
  return e;
}

/** True from tmux 3.8, which carries the upstream fix. */
function tmuxHasGroupKillFix() {
  const m = execFileSync('tmux', ['-V']).toString().match(/(\d+)\.(\d+)/);
  return !!m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 8));
}

test('the setup really is the crashing shape: a bare kill-window takes the server down', (t) => {
  if (tmuxHasGroupKillFix()) return t.skip('this tmux has the upstream fix, so there is no crash to show');
  setup(t, 1);
  quiet('kill-window', '-t', 'wf-1:agent');
  assert.deepEqual(sessions(), [], 'tmux crashed, so nothing is left');
});

test('killing the last window of a grouped session closes it and its views', (t) => {
  const mod = setup(t, 1);
  assert.equal(mod.killWindowSafely('wf-1:agent'), true);
  assert.deepEqual(sessions(), ['sentinel'], 'base and view gone, sentinel (the rest of the server) intact');
});

test('the last window is closed with kill-session, never kill-window', (t) => {
  const calls = [];
  const mod = setup(t, 1, { hook: (args) => calls.push(args[0]) });
  mod.killWindowSafely('wf-1:agent');
  assert.ok(!calls.includes('kill-window'), `issued: ${calls.join(', ')}`);
});

test('killing one of several windows leaves the views alone', (t) => {
  const mod = setup(t, 2);
  assert.equal(mod.killWindowSafely('wf-1:agent'), true);
  assert.deepEqual(sessions(), ['sentinel', 'view-agent-abc', 'wf-1']);
  assert.deepEqual(windowNames('wf-1'), ['other1']);
});

test('a window can be named by index', (t) => {
  const mod = setup(t, 2);
  const index = quiet('list-windows', '-t', '=wf-1', '-F', '#{window_index} #{window_name}')
    .split('\n').find((l) => l.endsWith(' other1')).split(' ')[0];
  assert.equal(mod.killWindowSafely(`wf-1:${index}`), true);
  assert.deepEqual(windowNames('wf-1'), ['agent']);
});

test('when tmux does not answer, nothing is killed', (t) => {
  // 2026-10-23: the listing timed out, was read as "not grouped", and the kill
  // went ahead with the view attached. Fail closed instead.
  const issued = [];
  const mod = setup(t, 1, {
    hook: (args) => {
      if (args[0] === 'list-windows') throw timedOut();
      issued.push(args[0]);
    },
  });
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(mod.killWindowSafely('wf-1:agent'), false);
  assert.deepEqual(sessions(), ['sentinel', 'view-agent-abc', 'wf-1'], 'everything still standing');
  assert.ok(!issued.includes('kill-window') && !issued.includes('kill-session'), `issued: ${issued.join(', ')}`);
  assert.match(warn.mock.calls[0].arguments[0], /did not answer/);
});

test('a view that attaches mid-kill cannot crash the server', (t) => {
  // The hub can open a terminal at any moment; its tmux client is a separate
  // process. Here a view joins the group right after the views were listed.
  let joined = false;
  const mod = setup(t, 1, {
    after: (args) => {
      if (args[0] !== 'list-sessions' || joined) return;
      joined = true;
      quiet('new-session', '-d', '-t', 'wf-1', '-s', 'view-late-xyz');
    },
  });
  assert.equal(mod.killWindowSafely('wf-1:agent'), true);
  assert.ok(joined, 'the late view was created during the kill');
  assert.deepEqual(sessions(), ['sentinel'], 'server alive, and the late view did not outlive its session');
});

test('a window is matched exactly, never by prefix', (t) => {
  // tmux's own -t resolution falls back to a prefix match.
  const mod = setup(t, 1);
  tmux('rename-window', '-t', 'wf-1:agent', 'qa-validate-r2');
  tmux('new-window', '-t', 'wf-1:', '-n', 'other');
  assert.equal(mod.killWindowSafely('wf-1:qa-validate'), false);
  assert.deepEqual(windowNames('wf-1'), ['other', 'qa-validate-r2']);
});

test('a window that is already gone is a no-op', (t) => {
  const mod = setup(t, 1);
  assert.equal(mod.killWindowSafely('wf-1:gone'), false);
  assert.equal(mod.killWindowSafely('no-such-session:agent'), false);
  assert.deepEqual(sessions(), ['sentinel', 'view-agent-abc', 'wf-1']);
});

test('releaseGroupedViews only touches view-* sessions in that group', (t) => {
  const mod = setup(t, 1);
  tmux('new-session', '-d', '-t', 'wf-1', '-s', 'not-a-view');   // grouped, but not ours to remove
  tmux('new-session', '-d', '-s', 'view-elsewhere');            // a view, but not in this group
  assert.equal(mod.releaseGroupedViews('wf-1'), 1);
  assert.deepEqual(sessions(), ['not-a-view', 'sentinel', 'view-elsewhere', 'wf-1']);
});

test('views left behind by a closed session are still released', (t) => {
  // The group outlives its base and keeps its name; a view in it holds the
  // agent's window open with nobody watching.
  const mod = setup(t, 1);
  tmux('kill-session', '-t', '=wf-1');
  assert.deepEqual(sessions(), ['sentinel', 'view-agent-abc']);
  assert.equal(mod.releaseGroupedViews('wf-1'), 1);
  assert.deepEqual(sessions(), ['sentinel']);
});

test('closeSession closes a grouped session without crashing', (t) => {
  const mod = setup(t, 2);
  mod.closeSession('wf-1');
  assert.deepEqual(sessions(), ['sentinel']);
});

test('an ungrouped or missing session is a no-op', (t) => {
  const mod = setup(t, 1);
  assert.equal(mod.releaseGroupedViews('sentinel'), 0);
  assert.equal(mod.releaseGroupedViews('does-not-exist'), 0);
});
