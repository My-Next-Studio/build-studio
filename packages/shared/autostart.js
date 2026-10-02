'use strict';

/**
 * Which project-servers run without being asked.
 *
 * Every registered project used to start at launch, including ones untouched for
 * weeks: each is a Node process (~50–65 MB) with its own timers, and the hub
 * polls every one of them for the top bar. The policy now (owner decision
 * 2026-10-02):
 *
 *   at launch   start a project that has an ACTIVE WORKFLOW, or that was running
 *               when the app last quit. Everything else stays off and starts
 *               when its tab is opened.
 *   at quit     record which projects were running, then stop the idle ones.
 *               A project with an active workflow keeps running.
 *
 * WHY AN ACTIVE WORKFLOW ALWAYS RUNS. Its agents live in tmux, outside the
 * server, and report back to it over HTTP; its auto-advance and watchdogs run
 * in it. A run whose server is off stalls silently.
 */

const fs = require('fs');
const path = require('path');
const { BUILD_STUDIO_DIR } = require('./constants');

const LAST_SESSION_PATH = path.join(BUILD_STUDIO_DIR, 'last-session.json');

/** Does this project have a workflow that is not finished? */
function hasActiveWorkflow(projectPath, { readFile = fs.readFileSync } = {}) {
  try {
    const wf = JSON.parse(readFile(path.join(projectPath, '.build-studio', 'workflow-state.json'), 'utf8'));
    return !!(wf && wf.currentStep && wf.currentStep !== 'completed');
  } catch (_) {
    return false;
  }
}

/** Names running at the last quit, or null when never recorded. */
function readLastSession(file = LAST_SESSION_PATH) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data.running) ? data.running : null;
  } catch (_) {
    return null;
  }
}

function writeLastSession(running, file = LAST_SESSION_PATH, now = new Date()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ running, at: now.toISOString() }, null, 2) + '\n', 'utf8');
}

/**
 * The projects to start at launch.
 *
 * With no recorded session (first launch on this version), only projects with
 * an active workflow start: the old behaviour started everything, so there is
 * no meaningful "last session" to restore yet.
 *
 * @param {Array<{name: string, path: string}>} projects  the registry
 * @param {{lastSession: string[]|null, isActive?: (p) => boolean}} opts
 * @returns {string[]} names
 */
function projectsToAutoStart(projects, { lastSession, isActive = (p) => hasActiveWorkflow(p.path) }) {
  const last = new Set(lastSession || []);
  return projects.filter((p) => isActive(p) || last.has(p.name)).map((p) => p.name);
}

/**
 * At quit: which running projects to stop. Idle ones only; an active workflow
 * keeps its server so the run carries on while the app is closed.
 */
function projectsToStopAtQuit(projects, { isRunning, isActive = (p) => hasActiveWorkflow(p.path) }) {
  return projects.filter((p) => isRunning(p) && !isActive(p)).map((p) => p.name);
}

module.exports = {
  LAST_SESSION_PATH,
  hasActiveWorkflow,
  readLastSession,
  writeLastSession,
  projectsToAutoStart,
  projectsToStopAtQuit,
};
