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
 * The environment the project-server really has: started from the desktop app,
 * with no locale. tmux then prints a tab in a `-F` format as `_`, which broke
 * every listing split on tabs while these tests, run from a UTF-8 shell, passed
 * (2026-10-23).
 */
const NO_LOCALE = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(LANG|LC_.*)$/.test(k)));

/**
 * tmux.js bound to the test socket. `hook(args)` runs before each tmux call the
 * helpers make, and may throw to stand in for a call that failed; `after(args)`
 * runs once it has returned. Both get the command and its arguments, without
 * tmux's own flags (`-u`) in front.
 */
function helpersOnTestSocket({ hook = () => {}, after = () => {} } = {}) {
  const real = require('child_process');
  const original = real.execFileSync;
  real.execFileSync = (cmd, args, opts) => {
    if (cmd !== 'tmux') return original(cmd, args, opts);
    const command = args[0] === '-u' ? args.slice(1) : args;
    hook(command);
    const out = original(cmd, ['-L', SOCKET, ...args], { ...opts, env: NO_LOCALE });
    after(command);
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

// Shows the crash where it happens (tmux 3.6a on macOS). The version alone does
// not say: CI's Linux tmux reports a pre-3.8 version and does not crash. So a
// tmux that survives the bare kill-window skips, naming itself; the tests below
// check the helpers either way.
test('the setup really is the crashing shape: a bare kill-window takes the server down', (t) => {
  const version = execFileSync('tmux', ['-V']).toString().trim();
  if (tmuxHasGroupKillFix()) return t.skip(`${version} has the upstream fix, so there is no crash to show`);
  setup(t, 1);
  quiet('kill-window', '-t', 'wf-1:agent');
  if (sessions().length) return t.skip(`${version} survived the bare kill-window here, so there is no crash to show`);
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

test('sessionId finds a live session by its exact name, and only that', (t) => {
  // The hub refuses to open an agent terminal when this returns null, so a
  // lookup that never matches reads every live session as gone.
  const mod = setup(t, 1);
  const ops = mod.createTmuxOps({ name: 'test' });
  assert.match(ops.sessionId('wf-1'), /^\$\d+$/);
  assert.notEqual(ops.sessionId('wf-1'), ops.sessionId('sentinel'));
  assert.equal(ops.sessionId('wf'), null, 'a prefix is not a match');
  assert.equal(ops.sessionId('does-not-exist'), null);
});

// 2026-10-23, twice: a draft start's close of the old draft window failed under
// load, silently. The hub's view outlived the session holding the old window,
// the next session of that name was pulled into the view's group, and the hub
// showed the finished draft's shell while the new draft ran beside it.

const windowIds = (s) => quiet('list-windows', '-t', `=${s}`, '-F', '#{window_id}').split('\n').filter(Boolean);

test('a view left behind by a failed close cannot bring the old window back', (t) => {
  let failViewKill = true;
  const mod = setup(t, 1, {
    hook: (args) => {
      if (failViewKill && args[0] === 'kill-session' && String(args[2]).startsWith('=view-')) throw timedOut();
    },
  });
  t.mock.method(console, 'warn', () => {});
  const [oldWindow] = windowIds('wf-1');
  const ops = mod.createTmuxOps({ name: 'test' });
  ops.ensureWindow('wf-1', 'agent', process.cwd());        // the next start, with the view's kill failing
  assert.deepEqual(sessions(), ['sentinel', 'view-agent-abc', 'wf-1'], 'the view survived, holding the old window');

  failViewKill = false;
  mod.releaseOrphanViews('wf-1');                          // what the hub does before attaching
  tmux('new-session', '-d', '-t', '=wf-1', '-s', 'view-agent-new');
  assert.ok(!windowIds('view-agent-new').includes(oldWindow), 'the hub does not see the old window');
  assert.deepEqual(windowIds('view-agent-new'), windowIds('wf-1'), 'the hub sees the new session');
});

test('a new session of the same name releases the old group first', (t) => {
  let failViewKill = true;
  const mod = setup(t, 1, {
    hook: (args) => {
      if (failViewKill && args[0] === 'kill-session' && String(args[2]).startsWith('=view-')) throw timedOut();
    },
  });
  t.mock.method(console, 'warn', () => {});
  const ops = mod.createTmuxOps({ name: 'test' });
  mod.closeSession('wf-1');
  assert.deepEqual(sessions(), ['sentinel', 'view-agent-abc']);
  failViewKill = false;
  ops.ensureWindow('wf-1', 'agent', process.cwd());
  assert.deepEqual(sessions(), ['sentinel', 'wf-1']);
});

test('releaseOrphanViews leaves the views of a live group alone', (t) => {
  const mod = setup(t, 1);
  assert.equal(mod.releaseOrphanViews('wf-1'), 0);
  assert.deepEqual(sessions(), ['sentinel', 'view-agent-abc', 'wf-1']);
});

test('a window that could not be closed is not duplicated', (t) => {
  const mod = setup(t, 2, {
    hook: (args) => {
      if (args[0] === 'kill-window') {
        const e = new Error('kill-window failed');
        e.stderr = Buffer.from('server exited unexpectedly');
        throw e;
      }
    },
  });
  const warn = t.mock.method(console, 'warn', () => {});
  const ops = mod.createTmuxOps({ name: 'test' });
  assert.throws(() => ops.ensureWindow('wf-1', 'agent', process.cwd()), /could not be closed/);
  assert.deepEqual(windowNames('wf-1'), ['agent', 'other1'], 'no second "agent" window');
  assert.match(warn.mock.calls[0].arguments[0], /could not kill wf-1:\d+: server exited unexpectedly/);
});

test('a close that tmux calls "already gone" but did not happen says what tmux answered', (t) => {
  // Live 2026-10-23, under load: the draft's only window and the hub's view
  // both survived the start, and the error pointed at a log line that did not
  // exist, because every answer had read as "already gone".
  const mod = setup(t, 1, {
    hook: (args) => {
      if (args[0] === 'kill-session') {
        const e = new Error('kill-session failed');
        e.stderr = Buffer.from('error connecting to /private/tmp/tmux-501/default (Resource temporarily unavailable)');
        throw e;
      }
    },
  });
  const warn = t.mock.method(console, 'warn', () => {});
  const ops = mod.createTmuxOps({ name: 'test' });
  assert.throws(
    () => ops.ensureWindow('wf-1', 'agent', process.cwd()),
    /could not be closed \(tmux answered: kill-session view-agent-abc: error connecting to .*Resource temporarily unavailable.*; kill-session wf-1: error connecting to/,
  );
  assert.deepEqual(windowNames('wf-1'), ['agent'], 'no second "agent" window');
  assert.deepEqual(sessions(), ['sentinel', 'view-agent-abc', 'wf-1']);
  assert.equal(warn.mock.calls.length, 1, 'one line for the whole attempt, not one per retry');
  assert.match(warn.mock.calls[0].arguments[0], /\[tmux\] could not close the earlier "agent" window in wf-1: tmux answered: kill-session view-agent-abc: error connecting to/);
});

test('a window listing that times out stops the launch instead of guessing', (t) => {
  const mod = setup(t, 1, {
    hook: (args) => {
      if (args[0] === 'list-windows' && args.includes('#{window_index} #{window_name}')) throw timedOut();
    },
  });
  const ops = mod.createTmuxOps({ name: 'test' });
  assert.throws(() => ops.ensureWindow('wf-1', 'agent', process.cwd()), /could not check wf-1 .*did not answer/);
  assert.deepEqual(windowNames('wf-1'), ['agent']);
});

test('a view that could not be closed is logged', (t) => {
  const mod = setup(t, 1, {
    hook: (args) => {
      if (args[0] === 'kill-session' && String(args[2]).startsWith('=view-')) throw timedOut();
    },
  });
  const warn = t.mock.method(console, 'warn', () => {});
  mod.closeSession('wf-1');
  assert.match(warn.mock.calls[0].arguments[0], /could not close view view-agent-abc of wf-1: tmux did not answer/);
});

test('an ungrouped or missing session is a no-op', (t) => {
  const mod = setup(t, 1);
  assert.equal(mod.releaseGroupedViews('sentinel'), 0);
  assert.equal(mod.releaseGroupedViews('does-not-exist'), 0);
});
