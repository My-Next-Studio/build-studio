'use strict';

/**
 * "Is there room to launch these agents right now?"
 *
 * Each CLI agent holds 100-200 MB and does not exit when it finishes. A review
 * workflow fans out six at once and runs several rounds, so a single run can
 * put 2-4 GB of agents on the machine — and two runs in parallel, or one long
 * one, exhausts a 16 GB box.
 *
 * The failure that follows is not a clean out-of-memory error. The agents keep
 * running but thrash: they stop repainting, stop accepting keystrokes, and
 * become impossible to nudge — which then looks like a stalled workflow with no
 * cause (fazon, 2026-07-30 and 2026-07-31: two agents finished their work and
 * were unreachable afterwards, so the only way to recover their output was to
 * read it out of the CLI transcript on disk). By the time it shows up, the
 * cheap recovery is already gone.
 *
 * So the check belongs *before* the fan-out. Refusing to launch costs one
 * click; a wedged agent costs the whole step.
 *
 * WHY NOT SWAP USED. The obvious signal — `vm.swapusage` — is a LAGGING one.
 * macOS leaves pages in swap long after the pressure that put them there is
 * gone: measured at 89% swap on an otherwise idle machine with 1.5 GB of agents
 * running, which would have deferred every launch on a healthy box. Occupancy
 * says where memory has been, not where it is.
 *
 * WHY NOT A FIXED PERCENTAGE. A threshold that ignores the launch treats a
 * one-agent bugfix and a six-agent review fan-out identically, when the whole
 * problem is the fan-out. The budget is computed from what is about to be
 * spawned instead, so a small launch still gets through on a tight machine.
 *
 * Everything here is pure — the vm_stat/sysctl calls live in the caller.
 */

/** Working-set estimate per agent. Observed 100-200 MB across claude/codex. */
const DEFAULT_PER_AGENT_MB = 200;
/** Left for everything that is not an agent: the app, the servers, the OS. */
const DEFAULT_HEADROOM_MB = 1024;

const MB = 1024 * 1024;

/**
 * Available memory, from `vm_stat` + `hw.memsize`.
 *
 * Available = free + inactive + speculative + purgeable. Inactive and purgeable
 * pages are reclaimable on demand, so counting only "free" understates real
 * headroom by an order of magnitude — macOS keeps free near zero by design,
 * which is exactly why a free-RAM threshold false-fires constantly.
 *
 * @param {string} vmStatOut  raw `vm_stat` output
 * @param {number} totalBytes `sysctl -n hw.memsize`
 * @returns {null|{availableMb:number, totalMb:number, pct:number}} null when
 *   unrecognised — including on platforms with no vm_stat.
 */
function parseAvailableMemory(vmStatOut, totalBytes) {
  const text = String(vmStatOut || '');
  const pageSize = Number((/page size of (\d+)/.exec(text) || [])[1]);
  const total = Number(totalBytes);
  if (!(pageSize > 0) || !(total > 0)) return null;

  const pages = (label) => {
    const m = new RegExp(`${label}:\\s+(\\d+)`).exec(text);
    return m ? Number(m[1]) : 0;
  };
  const free = pages('Pages free');
  const inactive = pages('Pages inactive');
  const speculative = pages('Pages speculative');
  const purgeable = pages('Pages purgeable');
  // "Pages free" is the only one guaranteed present; if it is missing entirely
  // the output is not vm_stat and we should not pretend to have a reading.
  if (!/Pages free:/.test(text)) return null;

  const availableBytes = (free + inactive + speculative + purgeable) * pageSize;
  return {
    availableMb: Math.round(availableBytes / MB),
    totalMb: Math.round(total / MB),
    pct: Math.round((availableBytes / total) * 100),
  };
}

/**
 * Decide whether to defer a launch of `agentCount` agents.
 *
 * Fails OPEN: an unreadable or unparseable reading never blocks a launch. A
 * guard that stops work because it could not measure something is worse than no
 * guard — this exists to prevent one specific, observed thrash, not to police
 * the machine.
 *
 * @param {null|{availableMb:number, totalMb:number, pct:number}} mem
 * @param {number} agentCount  how many agents this launch is about to start
 * @param {{perAgentMb?:number, headroomMb?:number}} [opts]
 * @returns {{defer:boolean, mem:object|null, neededMb?:number, reason?:string}}
 */
function evaluate(mem, agentCount, { perAgentMb = DEFAULT_PER_AGENT_MB, headroomMb = DEFAULT_HEADROOM_MB } = {}) {
  if (!mem) return { defer: false, mem: null };
  const n = Number(agentCount) > 0 ? Number(agentCount) : 1;
  const per = Number(perAgentMb) >= 0 ? Number(perAgentMb) : DEFAULT_PER_AGENT_MB;
  const head = Number(headroomMb) >= 0 ? Number(headroomMb) : DEFAULT_HEADROOM_MB;
  const neededMb = n * per + head;

  if (mem.availableMb >= neededMb) return { defer: false, mem, neededMb };
  return {
    defer: true,
    mem,
    neededMb,
    reason: `Launch deferred to protect the machine: ${mem.availableMb} MB available, but starting `
      + `${n} agent${n === 1 ? '' : 's'} needs about ${neededMb} MB (${per} MB each plus ${head} MB headroom). `
      + `Agents launched into a machine this tight thrash and stop responding to input. `
      + `Close finished runs to free memory, then relaunch the step.`,
  };
}

module.exports = {
  parseAvailableMemory, evaluate,
  DEFAULT_PER_AGENT_MB, DEFAULT_HEADROOM_MB,
};
