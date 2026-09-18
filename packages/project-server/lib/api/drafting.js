'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const {
  DRAFT_STEP, draftSessionName, draftWindowName,
  loadDraftState, saveDraftState, recordSession, buildDraftCommand, draftPrompt,
} = require('../drafting');
const { resolveStepLaunchSettings } = require('@build-studio/shared/cli');
const { readItem } = require('../backlog');
const agentSkills = require('../agent-skills');

/**
 * Drafting runs OUTSIDE the workflow slot — see lib/drafting.js for why that is
 * a requirement rather than a convenience.
 */
function createDraftingRouter(config, state, tmuxOps) {
  const router = express.Router();
  const projectRoot = config.projectRoot;
  const projectName = config.name || path.basename(projectRoot);

  // Which drafting sessions are still alive?
  //
  // The state file is a record of what was STARTED, and a window can be gone —
  // exited, killed, or replaced by a later draft of the same item. Returning it
  // raw would have the hub offer a view of a pane that is not there.
  //
  // Liveness is read from tmux rather than tracked: the window is the truth, and
  // anything this file believed about it could only ever be out of date. Dead
  // entries are pruned as they are found, which is also what keeps the file from
  // growing a row per draft ever started.
  router.get('/draft', (req, res) => {
    const state = loadDraftState(config.statePath);
    const sessions = state.sessions || {};
    const live = {};
    let pruned = false;
    for (const [itemId, entry] of Object.entries(sessions)) {
      const target = `${state.sessionName}:${entry.window}`;
      const pid = tmuxOps.panePid ? tmuxOps.panePid(target) : null;
      if (!pid) { pruned = true; continue; }
      live[itemId] = {
        ...entry,
        live: true,
        // A pane with no child process is a shell sitting at a prompt — the
        // session outlived its agent. Worth showing differently from one still
        // in conversation, so the hub can say which.
        agentRunning: tmuxOps.hasLiveDescendant ? tmuxOps.hasLiveDescendant(pid) : false,
      };
    }
    if (pruned) saveDraftState(config.statePath, { ...state, sessions: live });
    res.json({ ...state, sessions: live });
  });

  router.post('/draft/start', (req, res) => {
    const itemId = String((req.body && req.body.itemId) || '').trim();
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });

    let item = null;
    try { item = readItem(projectRoot, config.docsPath, itemId); } catch (_) { /* advisory */ }

    // Bugs never get a PRD: their lifecycle is Backlog → bugfix run, with no
    // drafting stage. Refused here as well as hidden in the UI, so a direct call
    // cannot open a session that would write a PRD nothing will ever read.
    if (item && item.type === 'Bug') {
      return res.status(409).json({
        error: `${itemId} is a Bug. Bugs go straight to a bugfix run and carry no PRD, so there is nothing to draft.`,
        isBug: true,
      });
    }

    // Increment 1 deliberately refuses an item that already has a PRD. Drafting
    // over a reviewed document is legitimate but silently replaces it, and the
    // UI for two drafting affordances on one story is unresolved (owner
    // decision 2026-09-14: skip it for now).
    if (item && item.prd) {
      return res.status(409).json({
        error: `${itemId} already has a PRD (${item.prd}). Re-drafting over a reviewed document is not supported yet.`,
        hasPrd: true,
      });
    }

    const launch = resolveStepLaunchSettings(DRAFT_STEP, null, config.cli, config.step_groups);
    const cli = launch.cli;
    const sessionName = draftSessionName(projectName);
    const windowName = draftWindowName(itemId);

    // Permission handling mirrors the workflow launcher per CLI. A drafting
    // agent is ATTENDED, so it does not need codex's bypass — an approval
    // prompt has someone to answer it.
    const dangerFlag = cli === 'opencode' ? ' --auto' : '';

    // `.claude/skills/` is a Claude Code path. A codex or opencode agent cannot
    // load it, and a reference it cannot resolve is worse than none: it names a
    // capability the agent lacks, so the agent substitutes something of its own
    // chosen without any knowledge of what the project provides. Drafting is the
    // step where that matters most — the skill IS the method here, not a
    // convenience. Same resolver the workflow launcher uses.
    const prompt = draftPrompt({ itemId, title: item && item.title });
    const inlined = agentSkills.inlineReferencedDefinitions(prompt, {
      cli, roots: [projectRoot], fs,
    });
    if (inlined) {
      console.log(`[draft] inlined .claude definitions for ${itemId} (${cli}): ${inlined.length} chars`);
    }

    const promptFile = path.join(projectRoot, `prompt-${windowName}.txt`);
    try {
      fs.writeFileSync(promptFile, prompt + (inlined || ''), 'utf8');
    } catch (e) {
      return res.status(500).json({ error: `could not write the prompt file: ${e.message}` });
    }

    // Pipe the pane to a log, as workflow agents do. Without it the pane IS the
    // only record, and a launch that fails before the CLI starts leaves nothing
    // to read: diagnosing the first real failure meant digging through tmux
    // scrollback, which survives only as long as the window does.
    const logFile = config.logsPath ? path.join(config.logsPath, `${windowName}.log`) : null;

    let target;
    try {
      target = tmuxOps.ensureWindow(sessionName, windowName, projectRoot);
      tmuxOps.sendKeys(target, `cd '${projectRoot}' && ${buildDraftCommand({
        cli, modelFlag: launch.modelFlag, effortFlag: launch.effortFlag, dangerFlag, promptFile,
      })}`, projectRoot);
      if (logFile && typeof tmuxOps.pipePaneToLog === 'function') {
        fs.mkdirSync(config.logsPath, { recursive: true });
        tmuxOps.pipePaneToLog(target, logFile, projectRoot);
      }
    } catch (e) {
      return res.status(500).json({ error: `tmux: ${e.message}` });
    }

    const entry = {
      window: windowName,
      startedAt: new Date().toISOString(),
      cli,
      model: launch.model || null,
      logFile,
      title: (item && item.title) || null,
    };
    recordSession(config.statePath, sessionName, itemId, entry);

    res.json({ ok: true, sessionName, ...entry });
  });

  return router;
}

module.exports = { createDraftingRouter };
