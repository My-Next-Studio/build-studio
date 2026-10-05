'use strict';

/**
 * Where the engine's judgements meet the decision layer (decide.js).
 *
 * Each function here is one decision point in SHADOW mode: it asks the layer the
 * same question the existing code answers, records both, and returns
 * immediately. The existing answer is what the engine acts on. Nothing here can
 * change a run's behaviour, and nothing here runs unless decisions are
 * configured (see decide.js for the config).
 */

const path = require('path');
const { loadHubConfig } = require('@build-studio/shared/cli');
const { BUILD_STUDIO_DIR } = require('@build-studio/shared/constants');
const { readOpenRouterKey } = require('@build-studio/shared/usage-collectors');
const decide = require('./decide');
const gateBlocked = require('./gate-blocked');

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

module.exports = { shadowGateBlocked, LOG_DIR, VERIFICATION_STEPS };
