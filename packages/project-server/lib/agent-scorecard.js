'use strict';

/**
 * Per-(role, step) performance records, so a project's agent configuration can
 * be judged on evidence instead of intuition.
 *
 * The question this exists to answer is comparative: the same role behaves
 * differently in different projects, because the thing that adapts it — the
 * project's own command file — is hand-written and never evaluated. A role
 * needing 2.5 rounds to converge in one project and 1.1 in another is not a
 * model problem, and the scorecard is what turns that into a file to open.
 *
 * WHY THIS KEEPS ITS OWN LOG RATHER THAN READING SNAPSHOTS
 *
 * Snapshots looked like the obvious source and are the wrong one. They are
 * capped at ten FILES per project and written per step transition, so a single
 * multi-step run fills the cap and evicts every earlier run — measured here, 90
 * snapshot files held only 12 distinct workflows, and the oldest survivors were
 * days old. A metric whose history depends on how many steps recent runs
 * happened to have is not a metric.
 *
 * So completion appends one line per agent to an append-only JSONL log. It
 * accumulates from the day it ships, costs a few hundred bytes per run, and is
 * never pruned.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * No composite "score". Weighing cache reads against finding counts against
 * duration would invent a precision the inputs do not have, and the number
 * would be argued with instead of acted on. Rows carry raw signals; the
 * comparison across projects is the analysis.
 */

const fs = require('fs');
const path = require('path');

/**
 * Token usage recorded before this date came from the old time-window
 * attribution, which charged each of six concurrent reviewers for all six plus
 * any other session open in the directory — one round was overstated by 4.3x.
 * Codex agents from that era are worse still: their numbers were derived from
 * *Claude* transcripts that merely overlapped in time.
 *
 * Averaging that into real measurements would produce a confident wrong answer,
 * which is the failure this whole area keeps repeating. Older usage is counted
 * as unmeasured rather than as data.
 */
const USAGE_TRUSTED_FROM = '2026-08-22T00:00:00.000Z';

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Blocking / Medium / Low counts from a structured review verdict.
 *
 * Returns null when the feedback carries no verdict line — an implementation
 * agent has no severities, and defaulting it to zeroes would make builders look
 * like flawless reviewers in any aggregate.
 */
function severityFromFeedback(text) {
  const s = String(text || '');
  const grab = (label) => {
    const m = s.match(new RegExp(String.raw`\*\*${label}:\*\*\s*(\d+)`, 'i'));
    return m ? parseInt(m[1], 10) : null;
  };
  const blocking = grab('Blocking');
  if (blocking === null) return null;
  return { blocking, medium: grab('Medium') || 0, low: grab('Low') || 0 };
}

/**
 * Which round THIS agent ran in — not which round the run reached.
 *
 * Stamping `wf.round` on every record made the column useless: a run that ended
 * at round 4 marked all its agents 4, including reviewers that ran once in
 * round 1 and never again. Read as "rounds this role needed" — which is what a
 * scorecard column called round invites — it was wrong for almost every row.
 *
 * The launcher already encodes the answer: it suffixes an agent's tmux window
 * with `-r<n>` for rounds after the first, so the window is the record of when
 * the agent actually ran. No suffix means round 1.
 */
function roundOfAgent(agent, wf) {
  const m = String((agent && agent.window) || '').match(/-r(\d+)$/);
  if (m) return parseInt(m[1], 10);
  // A first-round agent, or a step whose windows are not round-suffixed. Fall
  // back to the run's round only when the run never went past one, so a later
  // round is never attributed to an agent that predates it.
  return (wf && wf.round) === 1 ? 1 : 1;
}

/**
 * Every agent in a workflow, flattened to one record each.
 *
 * Sweeps BOTH homes. `wf.steps[*].agents` is where most live, but
 * task_execution's agents are under `wf.taskExecution.taskStates[i].agents` and
 * the step-level mirror is routinely empty mid-run — reading one and not the
 * other silently drops the builder, which is the role a scorecard most wants.
 */
function agentRecords(wf, project) {
  if (!wf) return [];
  const out = [];
  const at = wf.updatedAt || wf.createdAt || null;
  const push = (step, a) => {
    if (!a || !a.role) return;
    // Skip agents that never launched.
    //
    // Monolithic planning SYNTHESISES its plan rather than running a planner:
    // it writes an agent record with a role, a window and a feedback string,
    // but no CLI, no cwd and no start time. Counted as a real agent it appears
    // as a permanently unmeasured row — inflating the gap column with something
    // that by design never ran and never will. A launched agent always has a
    // start time; that is the discriminator.
    if (!a.startedAt) return;
    const tu = a.tokenUsage || null;
    const started = a.startedAt ? Date.parse(a.startedAt) : null;
    const ended = a.completedAt ? Date.parse(a.completedAt) : null;
    // Usage is trusted only if it was recorded after the attribution fix. An
    // agent that ran earlier is "not measured", not "measured as zero".
    const trusted = !!tu && !!a.startedAt && a.startedAt >= USAGE_TRUSTED_FROM;
    out.push({
      at,
      wfId: wf.id || null,
      type: wf.type || null,
      // Which execution chain, so the lean trial can be split by arm. Rows
      // written before this field have none; an execution row without a
      // preset ran the full chain.
      preset: wf.type === 'execution' ? (wf.preset || 'full') : null,
      input: wf.input || null,
      round: roundOfAgent(a, wf),
      project: project || null,
      role: a.role,
      step,
      // Which agent this was. With every round now recorded (agent-history.js),
      // a role runs more than once per step, and several tasks share a role.
      window: a.window || null,
      cli: a.cli || null,
      model: (tu && tu.model) || a.model || null,
      status: a.status || null,
      durationMs: started && ended && ended >= started ? ended - started : null,
      tokens: trusted
        ? { in: num(tu.inputTokens), out: num(tu.outputTokens), cacheRead: num(tu.cacheRead), cacheCreate: num(tu.cacheCreate) }
        : null,
      // `typeof`, not `Number.isFinite(Number(x))` — the latter coerces null to
      // 0 and reports it as finite, turning "this model has no price" into
      // "this agent was free". That is the exact conversion this module exists
      // to prevent, and it slipped in here first.
      costUSD: trusted && typeof tu.costUSD === 'number' && Number.isFinite(tu.costUSD) ? tu.costUSD : null,
      usageSource: trusted ? (tu.source || 'transcript') : null,
      // Already included in tokens and costUSD; kept apart so a delegating
      // agent's spend can be split into its own and its subagents'.
      subagents: trusted && tu.subagents
        ? { count: num(tu.subagents.count), models: tu.subagents.models || [], costUSD: typeof tu.subagents.costUSD === 'number' ? tu.subagents.costUSD : null }
        : null,
      // An archived round keeps only its parsed verdict, not its feedback.
      severity: a._severity !== undefined ? a._severity : severityFromFeedback(a.feedback),
    });
  };
  for (const [step, st] of Object.entries(wf.steps || {})) {
    for (const a of (st && st.agents) || []) push(step, a);
  }
  for (const ts of Object.values((wf.taskExecution || {}).taskStates || {})) {
    for (const a of (ts && ts.agents) || []) push('task_execution', a);
  }
  // Rounds a re-run step replaced. Without them only the last round of each
  // step was ever recorded — the clean one — and the findings that sent the
  // work back, with the tokens and time spent on them, were lost.
  for (const h of wf.agentHistory || []) push(h.step, h);
  return out;
}

function median(xs) {
  const v = xs.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

/**
 * Group records into one row per (project, role, step).
 *
 * Every "how many" is paired with a denominator that says how much of it was
 * actually measurable. `costUSD` beside `unpricedAgents` and `unmeasuredAgents`
 * is the difference between "this role is cheap" and "we cannot see this role".
 */
/**
 * Mean rounds across runs, or null when nothing was recorded.
 *
 * Null rather than 0: "no run recorded a round" and "converged in zero rounds"
 * are different claims, and the second one is not a thing that can happen.
 */
function meanRounds(byRun) {
  const vals = [...byRun.values()].filter((v) => v > 0);
  if (!vals.length) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Math.round(mean * 100) / 100;
}

function aggregate(records) {
  const rows = new Map();
  for (const r of records || []) {
    const key = `${r.project} ${r.role} ${r.step}`;
    if (!rows.has(key)) {
      rows.set(key, {
        project: r.project, role: r.role, step: r.step,
        agents: 0, errored: 0, runs: new Set(),
        tokens: { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 },
        costUSD: 0, pricedAgents: 0, unpricedAgents: 0, unmeasuredAgents: 0,
        findings: { blocking: 0, medium: 0, low: 0 }, verdicts: 0,
        _roundsByRun: new Map(), _durations: [], clis: new Set(), models: new Set(),
      });
    }
    const row = rows.get(key);
    row.agents += 1;
    if (r.status === 'error') row.errored += 1;
    if (r.wfId) row.runs.add(r.wfId);
    if (r.cli) row.clis.add(r.cli);
    if (r.model) row.models.add(r.model);
    if (Number.isFinite(r.durationMs)) row._durations.push(r.durationMs);
    // Rounds to converge, per RUN. The highest round this role reached within one
    // workflow is how many rounds that run needed; the mean across runs is the
    // metric. A max taken across ALL runs instead — which is what this was —
    // saturates at the round cap and reads 4-6 on nearly every row, so it
    // describes the cap rather than the role. See the comment on the output.
    if (r.wfId) {
      const round = num(r.round);
      if (round > 0) {
        row._roundsByRun.set(r.wfId, Math.max(row._roundsByRun.get(r.wfId) || 0, round));
      }
    }
    if (!r.tokens) row.unmeasuredAgents += 1;
    else {
      row.tokens.in += r.tokens.in;
      row.tokens.out += r.tokens.out;
      row.tokens.cacheRead += r.tokens.cacheRead;
      row.tokens.cacheCreate += r.tokens.cacheCreate;
      if (Number.isFinite(r.costUSD)) { row.costUSD += r.costUSD; row.pricedAgents += 1; }
      else row.unpricedAgents += 1;
    }
    if (r.severity) {
      row.verdicts += 1;
      row.findings.blocking += num(r.severity.blocking);
      row.findings.medium += num(r.severity.medium);
      row.findings.low += num(r.severity.low);
    }
  }
  return [...rows.values()].map((r) => ({
    ...r,
    runs: r.runs.size,
    clis: [...r.clis].sort(),
    models: [...r.models].sort(),
    costUSD: Math.round(r.costUSD * 10000) / 10000,
    medianDurationMs: median(r._durations),
    // The quantity this whole aggregation exists to expose: how many rounds this
    // role needs to settle, averaged over runs. Null when no run recorded a
    // round rather than 0 — "never measured" and "converged instantly" are not
    // the same claim.
    //
    // Read it beside `runs`. A mean over three runs moves a long way on one bad
    // run, and the two projects compared here differ by 5x in run count.
    //
    // For a step where several roles run TOGETHER in the same round — a review
    // round is the case — every role in that step necessarily shares the round
    // number, so the figure separates projects rather than roles. It is a per-role figure
    // only for steps a role runs alone.
    roundsToConverge: meanRounds(r._roundsByRun),
    _roundsByRun: undefined,
    _durations: undefined,
  })).sort((a, b) => b.tokens.cacheRead - a.tokens.cacheRead || a.role.localeCompare(b.role));
}

// ── the durable log ──────────────────────────────────────────────────────────

function logPath(statePath) { return path.join(statePath, 'scorecard.jsonl'); }

/** Append a completed run's records. Advisory: never throws into a caller. */
function appendRun(statePath, wf, project) {
  try {
    const records = agentRecords(wf, project);
    if (!records.length) return 0;
    fs.mkdirSync(statePath, { recursive: true });
    fs.appendFileSync(logPath(statePath), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    return records.length;
  } catch (_) { return 0; }
}

/** Read the log back. Malformed lines are skipped, never fatal. */
function readLog(statePath) {
  let raw;
  try { raw = fs.readFileSync(logPath(statePath), 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch (_) { /* skip */ }
  }
  return out;
}

/**
 * De-duplicate by (wfId, step, agent, round).
 *
 * A run appended twice — a relaunched completion, a seed followed by a real
 * append — would otherwise double every count. The last record for a key wins,
 * being the more complete one.
 */
function dedupe(records) {
  const seen = new Map();
  // Round and window are part of the identity: a role has a record per round
  // (agent-history.js) and per task. Keyed by role and step alone, the last
  // round replaced every earlier one on read, the loss the history exists to
  // fix. Rows from before the window field fall back to the role.
  for (const r of records || []) seen.set(`${r.wfId} ${r.step} ${r.window || r.role} ${r.round || 1}`, r);
  return [...seen.values()];
}

module.exports = {
  USAGE_TRUSTED_FROM,
  severityFromFeedback,
  agentRecords,
  aggregate,
  appendRun,
  readLog,
  dedupe,
  logPath,
};
