'use strict';

/**
 * Where the engine's judgements meet the decision layer (decide.js).
 *
 * Each function here is one decision point in SHADOW mode: it asks the layer the
 * same question the existing code answers, records both, and returns
 * immediately. The existing answer is what the engine acts on. Nothing here can
 * change a run's behaviour, and nothing here runs unless decisions are
 * configured (see decide.js for the config).
 *
 * The points, by `point` in the shadow log:
 *   gate_blocked  could a check not run?               gate-blocked.js
 *   agent_pane    what does the agent's terminal show?  agent-stalled.js, limit-block.js, agent-recovery.js
 *   report_final  final report, or a progress note?     transcript-recovery.js
 *   builder_role  which role does the PRD header name?  builder-role-hint.js
 * needs-attention.js and plan-contract.js have no shadow: the first is derived
 * from workflow state, not from text, and the second is a JSON parse, which is
 * exact. Neither has a judgement about wording to second-guess.
 */

const path = require('path');
const { loadHubConfig } = require('@build-studio/shared/cli');
const { BUILD_STUDIO_DIR } = require('@build-studio/shared/constants');
const { readOpenRouterKey } = require('@build-studio/shared/usage-collectors');
const decide = require('./decide');
const gateBlocked = require('./gate-blocked');
const agentStalled = require('./agent-stalled');
const transcriptRecovery = require('./transcript-recovery');
const builderRoleHint = require('./builder-role-hint');

const LOG_DIR = path.join(BUILD_STUDIO_DIR, 'decisions');

/**
 * Config + key for this project, or null when decisions are off. Read per call:
 * both are small files, and the owner can switch it on or off without a
 * restart.
 */
function context(projectConfig, deps = {}) {
  const hub = deps.hub !== undefined ? deps.hub : loadHubConfig();
  const config = decide.resolveDecisionsConfig(hub, projectConfig);
  if (!config) return null;
  const key = deps.key !== undefined ? deps.key : readOpenRouterKey();
  if (!key) return null;
  return { config, key, logDir: deps.logDir || LOG_DIR, fetchImpl: deps.fetchImpl, now: deps.now };
}

/** Steps whose reports can carry the "gate could not run" marker. */
const VERIFICATION_STEPS = new Set(['qa_validation', 'code_review', 'ac_verification', 'security_audit', 'final_review', 'coverage_matrix']);

/**
 * Decision point 1: could a check not run, or did it run and fail?
 * Called once per delivered report — not from anything that runs per poll.
 *
 * @returns {Promise<object|null>} the shadow record (tests await it; callers do not)
 */
function shadowGateBlocked({ projectConfig, wf, role, feedback }, deps = {}) {
  if (!wf || !VERIFICATION_STEPS.has(wf.currentStep) || !feedback) return Promise.resolve(null);
  const ctx = context(projectConfig, deps);
  if (!ctx) return Promise.resolve(null);
  return decide.shadow('gate_blocked', {
    state: feedback,
    questions: gateBlocked.SHADOW_QUESTIONS,
    existing: { could_not_run: !!gateBlocked.parseGateBlocked(feedback) },
    meta: { project: projectConfig && projectConfig.name, runId: wf.id, step: wf.currentStep, round: wf.round || 1, role, questionsVersion: gateBlocked.SHADOW_QUESTIONS_VERSION },
  }, ctx).catch(() => null);
}

/**
 * Ask each event once. The watchdog that calls the agent points ticks every 30
 * seconds, and its callers fire only on a transition (a block first seen, a
 * verdict that changed, a timeout), but a slip there would send the same pane
 * to the provider every tick. Keyed by run, agent launch and trigger, so a
 * relaunched agent is a new event.
 */
const asked = new Set();
const MAX_ASKED = 5000;
function firstTime(key) {
  if (asked.has(key)) return false;
  if (asked.size >= MAX_ASKED) asked.clear();
  asked.add(key);
  return true;
}
function resetAskedForTests() { asked.clear(); }

/** The last `lines` non-blank-trailing lines of a pane capture: the narrowest state that holds the answer. */
function paneTail(pane, lines = 40) {
  const rows = String(pane || '').replace(/\s+$/, '').split('\n');
  return rows.slice(-lines).join('\n');
}

function agentMeta(projectConfig, wf, agent, trigger, questionsVersion) {
  return {
    project: projectConfig && projectConfig.name, runId: wf.id, step: wf.currentStep, round: wf.round || 1,
    role: agent.role, cli: agent.cli || null, trigger, questionsVersion,
  };
}

/**
 * Decision points 2–4, one question: what does the agent's terminal show?
 * The pattern verdicts it shadows are limit-block.js (a usage limit),
 * agent-recovery.js (the program exited) and agent-stalled.js (waiting at a
 * question, blocked on a login, idle at a prompt). Called by the watchdog on a
 * transition, never per tick.
 *
 * @param {object} p
 * @param {string} p.trigger   what happened: 'limit_detected', 'stalled:<reason>', 'idle_timeout', 'process_dead', 'process_gone'
 * @param {string} p.pane      the pane capture the watchdog read
 * @param {boolean} [p.limit]  limit-block found a usage limit
 * @param {boolean} [p.exited] agent-recovery found the program exited
 * @param {string} [p.stalledReason] agent-stalled's verdict, if any
 */
function shadowAgentPane({ projectConfig, wf, agent, trigger, pane, limit = false, exited = false, stalledReason = null }, deps = {}) {
  if (!wf || !agent || !trigger) return Promise.resolve(null);
  const state = paneTail(pane);
  if (!state.trim()) return Promise.resolve(null);
  if (!firstTime(`pane|${wf.id}|${agent.window}|${agent.startedAt}|${trigger}`)) return Promise.resolve(null);
  const ctx = context(projectConfig, deps);
  if (!ctx) return Promise.resolve(null);
  return decide.shadow('agent_pane', {
    state,
    questions: agentStalled.PANE_SHADOW_QUESTIONS,
    existing: {
      pane_state: agentStalled.existingPaneState({ limit, exited, stalledReason }),
      limit: !!limit, exited: !!exited, stalled_reason: stalledReason || null,
    },
    meta: agentMeta(projectConfig, wf, agent, trigger, agentStalled.PANE_SHADOW_QUESTIONS_VERSION),
  }, ctx).catch(() => null);
}

/**
 * Decision point 5: is what the agent said last its final report, or a
 * progress note? Shadows transcript-recovery.js's looksLikeReport, which
 * decides whether Recover is offered. Called when the watchdog finds an agent
 * finished-but-unreported, or times it out, never per tick.
 */
function shadowReportFinal({ projectConfig, wf, agent, trigger, text }, deps = {}) {
  if (!wf || !agent || !trigger || !text || !String(text).trim()) return Promise.resolve(null);
  if (!firstTime(`report|${wf.id}|${agent.window}|${agent.startedAt}|${trigger}`)) return Promise.resolve(null);
  const ctx = context(projectConfig, deps);
  if (!ctx) return Promise.resolve(null);
  return decide.shadow('report_final', {
    state: text,
    questions: transcriptRecovery.REPORT_SHADOW_QUESTIONS,
    existing: { final_report: transcriptRecovery.looksLikeReport(text) },
    meta: agentMeta(projectConfig, wf, agent, trigger, transcriptRecovery.REPORT_SHADOW_QUESTIONS_VERSION),
  }, ctx).catch(() => null);
}

/**
 * Decision point 6: which implementation role does the PRD's header name?
 * Shadows builder-role-hint.js's parseBuilderRoleHint. Called once per
 * execution run started from a PRD.
 *
 * @param {object} p
 * @param {Array<{role: string}>} p.executionRoles  config.roles.execution
 * @param {string|null} p.resolvedRole  the role the header line resolved to, or null
 */
function shadowBuilderRole({ projectConfig, wf, prdText, executionRoles, resolvedRole = null }, deps = {}) {
  if (!wf || !Array.isArray(executionRoles) || executionRoles.length === 0) return Promise.resolve(null);
  const header = builderRoleHint.prdHeader(prdText);
  if (!header.trim()) return Promise.resolve(null);
  const ctx = context(projectConfig, deps);
  if (!ctx) return Promise.resolve(null);
  const raw = builderRoleHint.parseBuilderRoleHint(prdText);
  return decide.shadow('builder_role', {
    state: header,
    questions: builderRoleHint.builderRoleShadowQuestions(executionRoles),
    // An unresolved hint keeps its raw value: the header names something, just
    // not a role of this project, and that is a different answer from "none".
    existing: { builder_role: resolvedRole || raw || builderRoleHint.NO_ROLE, raw: raw || null, resolves: !raw || !!resolvedRole },
    meta: {
      project: projectConfig && projectConfig.name, runId: wf.id, step: wf.currentStep, round: wf.round || 1,
      prdPath: wf.prdPath || null, questionsVersion: builderRoleHint.BUILDER_ROLE_SHADOW_QUESTIONS_VERSION,
    },
  }, ctx).catch(() => null);
}

/**
 * Never throws, not even synchronously. The agent points are called from the
 * watchdog's tick, outside its try/catch, and a shadow call must not be able
 * to break the tick that acts on the real verdict.
 */
function safe(fn) {
  return (...args) => {
    try { return fn(...args); } catch (_) { return Promise.resolve(null); }
  };
}

module.exports = {
  shadowGateBlocked: safe(shadowGateBlocked),
  shadowAgentPane: safe(shadowAgentPane),
  shadowReportFinal: safe(shadowReportFinal),
  shadowBuilderRole: safe(shadowBuilderRole),
  paneTail, LOG_DIR, VERIFICATION_STEPS, resetAskedForTests,
};
