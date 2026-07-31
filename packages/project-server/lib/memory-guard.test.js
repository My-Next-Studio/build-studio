'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseAvailableMemory, evaluate, DEFAULT_PER_AGENT_MB, DEFAULT_HEADROOM_MB,
} = require('./memory-guard');

const GB = 1024 * 1024 * 1024;

/** Build vm_stat output with the given page counts (16 KB pages, as on arm64). */
function vmStat({ free = 0, inactive = 0, speculative = 0, purgeable = 0 } = {}) {
  return [
    'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
    `Pages free:                                     ${free}.`,
    'Pages active:                                 166035.',
    `Pages inactive:                               ${inactive}.`,
    `Pages speculative:                               ${speculative}.`,
    'Pages throttled:                                   0.',
    'Pages wired down:                             223080.',
    `Pages purgeable:                                   ${purgeable}.`,
  ].join('\n');
}

// A real reading from a busy-but-working machine (2026-07-31): 3.09 GB
// available of 16 GB, one review WF running. This must NOT be blocked — it is
// the everyday state, and a guard that fires here would be turned off.
const BUSY = vmStat({ free: 4312, inactive: 195000, speculative: 800, purgeable: 200 });
// The exhausted end of the same day: agents wedged, ~0.6 GB left.
const EXHAUSTED = vmStat({ free: 2000, inactive: 36000, speculative: 400, purgeable: 100 });
const ROOMY = vmStat({ free: 200000, inactive: 300000, speculative: 5000, purgeable: 1000 });

test('computes available memory from free + inactive + speculative + purgeable', () => {
  // Counting only "free" would understate this by ~40x — macOS keeps free near
  // zero by design, which is why a free-RAM threshold false-fires constantly.
  const m = parseAvailableMemory(vmStat({ free: 1000, inactive: 2000, speculative: 500, purgeable: 500 }), 16 * GB);
  assert.equal(m.availableMb, Math.round((4000 * 16384) / (1024 * 1024)));
  assert.equal(m.totalMb, 16384);
});

test('reports a percentage of total RAM', () => {
  const m = parseAvailableMemory(BUSY, 16 * GB);
  assert.ok(m.pct > 15 && m.pct < 25, `got ${m.pct}%`);
});

test('unreadable input yields null rather than a guess', () => {
  for (const bad of ['', null, undefined, 'not vm_stat output']) {
    assert.equal(parseAvailableMemory(bad, 16 * GB), null, JSON.stringify(bad));
  }
  assert.equal(parseAvailableMemory(BUSY, 0), null, 'no total');
  assert.equal(parseAvailableMemory('page size of 16384 bytes\nnothing else', 16 * GB), null, 'no page counts');
});

test('fails open when memory cannot be read', () => {
  // A guard that blocks work because it could not measure something is worse
  // than no guard — and non-macOS hosts have no vm_stat at all.
  assert.equal(evaluate(null, 6).defer, false);
});

test('defers a six-agent review fan-out on an exhausted machine', () => {
  const v = evaluate(parseAvailableMemory(EXHAUSTED, 16 * GB), 6);
  assert.equal(v.defer, true);
  assert.equal(v.neededMb, 6 * DEFAULT_PER_AGENT_MB + DEFAULT_HEADROOM_MB);
  assert.match(v.reason, /6 agents/);
  assert.match(v.reason, /relaunch the step/i);
});

test('a busy-but-working machine is NOT blocked', () => {
  // The everyday state — one review running, 3 GB free. A guard that fires
  // here would be turned off within a day, which is worse than no guard.
  assert.equal(evaluate(parseAvailableMemory(BUSY, 16 * GB), 6).defer, false);
});

test('the budget scales, so a small launch survives where a fan-out does not', () => {
  // The point of scaling: at ~1.5 GB there is room for one agent (1224 MB) but
  // not six (2224 MB). A one-agent bugfix is not what exhausts the box, so it
  // should not inherit the fan-out's ceiling.
  const mem = { availableMb: 1500, totalMb: 16384, pct: 9 };
  assert.equal(evaluate(mem, 1).defer, false);
  assert.equal(evaluate(mem, 6).defer, true);
});

test('a truly exhausted machine blocks even one agent', () => {
  // At 602 MB there is not room for a single agent plus headroom. Launching
  // anything here is how agents end up wedged.
  assert.equal(evaluate(parseAvailableMemory(EXHAUSTED, 16 * GB), 1).defer, true);
});

test('a roomy machine allows the fan-out', () => {
  assert.equal(evaluate(parseAvailableMemory(ROOMY, 16 * GB), 6).defer, false);
});

test('the budget is agent count times per-agent plus headroom', () => {
  const mem = { availableMb: 2000, totalMb: 16384, pct: 12 };
  assert.equal(evaluate(mem, 4, { perAgentMb: 100, headroomMb: 500 }).neededMb, 900);
  assert.equal(evaluate(mem, 4, { perAgentMb: 100, headroomMb: 500 }).defer, false);
  assert.equal(evaluate(mem, 4, { perAgentMb: 400, headroomMb: 500 }).defer, true);
});

test('exactly enough memory is enough', () => {
  const mem = { availableMb: 6 * DEFAULT_PER_AGENT_MB + DEFAULT_HEADROOM_MB, totalMb: 16384, pct: 13 };
  assert.equal(evaluate(mem, 6).defer, false);
});

test('a zero or missing agent count is treated as one agent', () => {
  const mem = { availableMb: DEFAULT_HEADROOM_MB + DEFAULT_PER_AGENT_MB, totalMb: 16384, pct: 8 };
  assert.equal(evaluate(mem, 0).defer, false);
  assert.equal(evaluate(mem, undefined).defer, false);
});
