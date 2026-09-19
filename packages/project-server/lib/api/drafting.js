'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  DRAFT_STEP, draftSessionName, draftWindowName,
  loadDraftState, saveDraftState, buildDraftCommand, draftPrompt, continuePrompt,
} = require('../drafting');
const {
  resolveStepLaunchSettings, canPinSession, sessionPinFlag, sessionResumeFlag,
} = require('@build-studio/shared/cli');
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
  /**
   * The project's drafting session, and whether it can still be reached.
   *
   * Liveness is read from tmux rather than tracked: the window is the truth, and
   * anything the state file believed about it could only be out of date. A
   * session whose window is gone is NOT discarded — with a pinned id the
   * conversation can still be resumed, which is the whole point of increment 2.
   */
  router.get('/draft', (req, res) => {
    const state = loadDraftState(config.statePath);
    const session = state.session || null;
    if (!session) return res.json({ sessionName: state.sessionName || null, session: null });

    const target = `${state.sessionName}:${session.window}`;
    const pid = tmuxOps.panePid ? tmuxOps.panePid(target) : null;
    const live = !!pid;
    res.json({
      sessionName: state.sessionName,
      session: {
        ...session,
        live,
        // A pane with no child is a shell at a prompt: the window outlived its
        // agent. Different from a conversation still in progress.
        agentRunning: live && tmuxOps.hasLiveDescendant ? tmuxOps.hasLiveDescendant(pid) : false,
        // Resumable without the window, provided the CLI could be pinned.
        resumable: !!session.cliSessionId && canPinSession(session.cli),
        ageMs: session.startedAt ? Date.now() - Date.parse(session.startedAt) : null,
        idleMs: session.lastUsedAt ? Date.now() - Date.parse(session.lastUsedAt) : null,
      },
    });
  });

  /**
   * Start, continue, or resume the project's drafting session.
   *
   * There is ONE session per project — the owner's boundary, cut by hand when
   * the subject changes — so a second Draft click is normally a continuation,
   * not a new conversation. Three cases:
   *
   *   live      the window is up and an agent is in it → point it at the new
   *             item and attach. Nothing is killed. This is the case that used
   *             to destroy a running session, because window creation
   *             deduplicates by name.
   *   resumable the window is gone but the session id is known → relaunch with
   *             the CLI's resume flag, so the conversation continues where it
   *             stopped rather than starting over.
   *   fresh     no session, or the caller asked for one.
   */
  router.post('/draft/start', (req, res) => {
    const itemId = String((req.body && req.body.itemId) || '').trim();
    const wantFresh = (req.body && req.body.fresh) === true;
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });

    let item = null;
    try { item = readItem(projectRoot, config.docsPath, itemId); } catch (_) { /* advisory */ }

    if (item && item.type === 'Bug') {
      return res.status(409).json({
        error: `${itemId} is a Bug. Bugs go straight to a bugfix run and carry no PRD, so there is nothing to draft.`,
        isBug: true,
      });
    }
    if (item && item.prd) {
      return res.status(409).json({
        error: `${itemId} already has a PRD (${item.prd}). Re-drafting over a reviewed document is not supported yet.`,
        hasPrd: true,
      });
    }

    const launch = resolveStepLaunchSettings(DRAFT_STEP, null, config.cli, config.step_groups);
    const cli = launch.cli;
    const sessionName = draftSessionName(projectName);
    const windowName = draftWindowName();
    const target = `${sessionName}:${windowName}`;
    const dangerFlag = cli === 'opencode' ? ' --auto' : '';

    const state = loadDraftState(config.statePath);
    const prior = wantFresh ? null : (state.session || null);
    const pid = tmuxOps.panePid ? tmuxOps.panePid(target) : null;
    const windowLive = !!pid;
    const agentRunning = windowLive && tmuxOps.hasLiveDescendant ? tmuxOps.hasLiveDescendant(pid) : false;

    // ── one draft at a time ──────────────────────────────────────────────────
    //
    // A running session is refused rather than talked into. Sending a second
    // item into a live conversation meant typing into whatever the agent was
    // doing — fine mid-answer, wrong when it was sitting on a menu, where the
    // text would have been read as the menu choice. There is no need for two
    // drafts at once in one project (owner, 2026-09-19), so the case is removed
    // rather than made careful.
    //
    // Continuity is unaffected: once the agent finishes, the next Draft resumes
    // this same conversation through the path below.
    if (prior && windowLive && agentRunning && !wantFresh) {
      return res.status(409).json({
        error: `A drafting session is already running${prior.lastItemId ? ` for ${prior.lastItemId}` : ''}.`
          + ' Finish it, or use Start fresh to abandon it, before drafting another item.',
        sessionRunning: true,
        lastItemId: prior.lastItemId || null,
        window: windowName,
      });
    }

    // ── otherwise launch: resuming the old conversation, or starting one ──────
    const resuming = !!(prior && prior.cliSessionId && canPinSession(cli) && !wantFresh);
    const cliSessionId = resuming
      ? prior.cliSessionId
      : (canPinSession(cli) ? crypto.randomUUID() : null);

    const prompt = resuming
      ? continuePrompt({ itemId, title: item && item.title })
      : draftPrompt({ itemId, title: item && item.title });
    const inlined = agentSkills.inlineReferencedDefinitions(prompt, { cli, roots: [projectRoot], fs });
    if (inlined) {
      console.log(`[draft] inlined .claude definitions for ${itemId} (${cli}): ${inlined.length} chars`);
    }

    const promptFile = path.join(projectRoot, `prompt-${windowName}.txt`);
    try {
      fs.writeFileSync(promptFile, prompt + (inlined || ''), 'utf8');
    } catch (e) {
      return res.status(500).json({ error: `could not write the prompt file: ${e.message}` });
    }

    const logFile = config.logsPath ? path.join(config.logsPath, `${windowName}.log`) : null;
    try {
      const t = tmuxOps.ensureWindow(sessionName, windowName, projectRoot);
      tmuxOps.sendKeys(t, `cd '${projectRoot}' && ${buildDraftCommand({
        cli,
        modelFlag: launch.modelFlag,
        effortFlag: launch.effortFlag,
        dangerFlag,
        sessionFlag: resuming ? sessionResumeFlag(cli, cliSessionId) : sessionPinFlag(cli, cliSessionId),
        promptFile,
      })}`, projectRoot);
      if (logFile && typeof tmuxOps.pipePaneToLog === 'function') {
        fs.mkdirSync(config.logsPath, { recursive: true });
        tmuxOps.pipePaneToLog(t, logFile, projectRoot);
      }
    } catch (e) {
      return res.status(500).json({ error: `tmux: ${e.message}` });
    }

    const session = {
      cliSessionId,
      cli,
      model: launch.model || null,
      window: windowName,
      logFile,
      startedAt: resuming ? (prior.startedAt || new Date().toISOString()) : new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      lastItemId: itemId,
      items: resuming ? [...new Set([...(prior.items || []), itemId])] : [itemId],
      resumable: canPinSession(cli),
    };
    saveDraftState(config.statePath, { ...state, sessionName, session });
    res.json({ ok: true, sessionName, mode: resuming ? 'resumed' : 'fresh', ...session });
  });

  return router;
}

module.exports = { createDraftingRouter };
