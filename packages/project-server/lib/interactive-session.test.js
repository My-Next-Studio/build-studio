'use strict';

// Stopping an interactive agent escalates until it is gone: /exit, then Escape
// and ctrl+c, then the window. Codex once sat on "This conversation is open in
// another app — press R", where /exit is only text; the agent outlived End and
// the project's Draft button stayed blocked (2026-11-07).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stopAgent, EXIT_GRACE_MS, INTERRUPT_GRACE_MS } = require('./interactive-session');

/** A pane whose agent stops after `stopsAfter` of the given key events. */
function pane({ live = true, agent = true, stopsOn = null } = {}) {
  const calls = [];
  const state = { live, agent };
  return {
    calls,
    tmuxOps: {
      panePid: () => (state.live ? 4242 : null),
      hasLiveDescendant: () => state.agent,
      sendKeys: (t, cmd) => { calls.push(['sendKeys', cmd]); if (stopsOn === 'exit') state.agent = false; },
      sendKeysRaw: (t, ...keys) => { calls.push(['sendKeysRaw', ...keys]); if (stopsOn === 'interrupt') state.agent = false; },
      killWindowAndChildren: () => { calls.push(['kill']); state.live = false; state.agent = false; },
    },
  };
}

/** Run scheduled steps by hand, recording their delays. */
function clock() {
  const queue = [];
  return {
    delays: () => queue.map((q) => q.ms),
    schedule: (fn, ms) => { queue.push({ fn, ms }); return { unref() {} }; },
    runNext: () => { const q = queue.shift(); if (q) q.fn(); return !!q; },
  };
}

test('a bare shell (the agent already gone) is closed at once', () => {
  const p = pane({ agent: false });
  assert.equal(stopAgent({ tmuxOps: p.tmuxOps, target: 's:w', schedule: clock().schedule }), 'killed');
  assert.deepEqual(p.calls, [['kill']]);
});

test('no pane: nothing to do', () => {
  const p = pane({ live: false });
  assert.equal(stopAgent({ tmuxOps: p.tmuxOps, target: 's:w', schedule: clock().schedule }), 'gone');
  assert.deepEqual(p.calls, []);
});

test('an agent that honours /exit gets nothing more', () => {
  const p = pane({ stopsOn: 'exit' });
  const c = clock();
  assert.equal(stopAgent({ tmuxOps: p.tmuxOps, target: 's:w', schedule: c.schedule }), 'exiting');
  assert.deepEqual(c.delays(), [EXIT_GRACE_MS]);
  c.runNext();
  assert.deepEqual(p.calls, [['sendKeys', '/exit']]);
});

test('an agent deaf to /exit gets Escape and ctrl+c, and that is enough', () => {
  const p = pane({ stopsOn: 'interrupt' });
  const c = clock();
  stopAgent({ tmuxOps: p.tmuxOps, target: 's:w', schedule: c.schedule });
  c.runNext();
  assert.deepEqual(c.delays(), [INTERRUPT_GRACE_MS]);
  c.runNext();
  assert.deepEqual(p.calls, [['sendKeys', '/exit'], ['sendKeysRaw', 'Escape', 'C-c', 'C-c']]);
});

test('an agent that survives everything has its window closed', () => {
  const p = pane();
  const c = clock();
  stopAgent({ tmuxOps: p.tmuxOps, target: 's:w', schedule: c.schedule });
  while (c.runNext()) { /* drain */ }
  assert.deepEqual(p.calls, [['sendKeys', '/exit'], ['sendKeysRaw', 'Escape', 'C-c', 'C-c'], ['kill']]);
});
