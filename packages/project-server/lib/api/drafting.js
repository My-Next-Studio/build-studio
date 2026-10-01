'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  DRAFT_STEP, draftSessionName, draftWindowName,
  loadDraftState, saveDraftState, buildDraftCommand, draftPrompt, continuePrompt,
  ensureIgnored, draftCommitPaths, draftCommitMessage,
} = require('../drafting');
const { scopedCommit } = require('../scoped-commit');
const {
  resolveStepLaunchSettings, canPinSession, sessionPinFlag, sessionResumeFlag,
} = require('@build-studio/shared/cli');
const { readItem } = require('../backlog');
const agentSkills = require('../agent-skills');
const { computeDraftDelta, formatDraftDelta } = require('../draft-delta');

/**
 * Drafting runs OUTSIDE the workflow slot — see lib/drafting.js for why that is
 * a requirement rather than a convenience.
 */
function createDraftingRouter(config, state, tmuxOps) {
  const router = express.Router();
  const projectRoot = config.projectRoot;
  const projectName = config.name || path.basename(projectRoot);
  // The backlog helpers join projectRoot + a RELATIVE docs path. config.docsPath
  // is absolute, which path.join nests into a path that does not exist: every
  // readItem here returned null, so the Bug and has-a-PRD refusals never fired
  // and the prompt never carried the item's title.
  const docsRel = config.docs_path || path.relative(projectRoot, config.docsPath) || 'docs';

  /**
   * Commit what the session's drafts wrote. Non-fatal: the files are in the
   * working tree either way, and a failed commit is reported, not thrown. Lands
   * on whatever branch is checked out — a run's branch while execution is under
   * way, which merges with the run (owner decision 2026-10-01).
   */
  async function commitDrafts(session) {
    const itemIds = (session && session.items) || [];
    if (!itemIds.length || !fs.existsSync(path.join(projectRoot, '.git'))) return null;
    const paths = draftCommitPaths({ projectRoot, docsRel, itemIds, readItem });
    if (!paths.length) return null;
    const result = await scopedCommit(projectRoot, paths, draftCommitMessage(itemIds));
    if (!result.committed) console.warn(`[draft] PRD not committed: ${result.reason}`);
    return result;
  }

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
   * End the running agent, keeping the conversation resumable.
   *
   * Hiding the panel closes the VIEW; it deliberately leaves the session alone.
   * That is the right default for stepping away, but it made finishing ambiguous:
   * a completed draft whose agent is still sitting at its prompt looks exactly
   * like one in progress, so it held the one-draft-at-a-time lock and disabled
   * every Draft button (owner hit this 2026-09-19). Ending needed to be its own
   * deliberate act rather than a thing you had to know to type.
   *
   * The session id is KEPT. Ending stops the process; it does not abandon the
   * conversation, which can still be resumed. Start fresh is what discards.
   */
  router.post('/draft/end', async (req, res) => {
    const state = loadDraftState(config.statePath);
    const session = state.session || null;
    if (!session) return res.json({ ok: true, alreadyEnded: true });

    const target = `${state.sessionName}:${session.window}`;
    const pid = tmuxOps.panePid ? tmuxOps.panePid(target) : null;
    if (!pid) {
      saveDraftState(config.statePath, { ...state, session: { ...session, endedAt: new Date().toISOString() } });
      const commit = await commitDrafts(session);
      return res.json({ ok: true, alreadyEnded: true, commit });
    }

    // Two cases, and sending /exit to both was the bug: a pane whose agent has
    // already exited is a bare SHELL, which does not understand /exit — it
    // printed "command not found" and the window stayed open, so Close appeared
    // to do nothing (2026-09-19).
    const agentRunning = tmuxOps.hasLiveDescendant ? tmuxOps.hasLiveDescendant(pid) : false;
    try {
      if (agentRunning) {
        // The CLI's own exit, so it closes its session cleanly rather than being
        // cut off part-way through writing a file.
        tmuxOps.sendKeys(target, '/exit', projectRoot);
      } else {
        // Nothing to ask politely. Close the window itself.
        // No port argument: that is for windows running dev servers, not this one.
        tmuxOps.killWindowAndChildren(`${state.sessionName}:${session.window}`);
      }
    } catch (e) {
      return res.status(500).json({ error: `could not close the session: ${e.message}` });
    }
    saveDraftState(config.statePath, {
      ...state,
      session: { ...session, endedAt: new Date().toISOString() },
    });
    // Ending is the owner saying the draft is done, so its files are committed
    // now. The agent's own writes finished before it returned to its prompt.
    const commit = await commitDrafts(session);
    // The process takes a moment to go; the poll notices and re-enables the
    // buttons. Reported rather than waited for, so the request does not hang.
    res.json({ ok: true, ending: true, resumable: !!session.cliSessionId && canPinSession(session.cli), commit });
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
  router.post('/draft/start', async (req, res) => {
    const itemId = String((req.body && req.body.itemId) || '').trim();
    const wantFresh = (req.body && req.body.fresh) === true;
    if (!itemId) return res.status(400).json({ error: 'itemId is required' });

    let item = null;
    try { item = readItem(projectRoot, docsRel, itemId); } catch (_) { /* advisory */ }

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

    // Ignore the state file before writing it, and commit the rule at once: a
    // modified .gitignore on the default branch blocks the next execution run.
    // Pathspec-scoped, so nothing an agent has staged is swept in. Advisory —
    // a failed commit leaves one line to commit by hand, not a broken draft.
    try {
      if (ensureIgnored(projectRoot) && fs.existsSync(path.join(projectRoot, '.git'))) {
        scopedCommit(projectRoot, ['.gitignore'], 'chore: gitignore drafting state')
          .then((r) => { if (!r.committed) console.warn(`[draft] .gitignore not committed: ${r.reason}`); })
          .catch(() => {});
      }
    } catch (e) {
      console.warn(`[draft] could not update .gitignore: ${e.message}`);
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
          + ' Finish it and click End draft before drafting another item.',
        sessionRunning: true,
        lastItemId: prior.lastItemId || null,
        window: windowName,
      });
    }

    // An agent that exited on its own skipped End draft, and with it the commit.
    // Commit what the previous session wrote before starting the next one, so
    // it does not ride along uncommitted into this draft or the next run.
    if (state.session && !agentRunning) await commitDrafts(state.session);

    // ── otherwise launch: resuming the old conversation, or starting one ──────
    const resuming = !!(prior && prior.cliSessionId && canPinSession(cli) && !wantFresh);
    const cliSessionId = resuming
      ? prior.cliSessionId
      : (canPinSession(cli) ? crypto.randomUUID() : null);

    // A resumed session knows the project as it was when it last read it. Tell
    // it what has changed since its previous draft, so it re-reads the parts
    // that are stale instead of drafting against its memory of them. A fresh
    // session reads everything anyway and gets no delta. See draft-delta.js.
    let delta = '';
    if (resuming && prior.lastUsedAt) {
      try {
        delta = formatDraftDelta(computeDraftDelta({
          projectRoot, docsPath: config.docsPath, since: prior.lastUsedAt, own: prior.items || [],
        }), prior.lastUsedAt);
      } catch (e) {
        console.warn(`[draft] could not compute the change delta: ${e.message}`);
      }
    }
    const prompt = resuming
      ? continuePrompt({ itemId, title: item && item.title, sameItem: prior.lastItemId === itemId }) + delta
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
      // Changes on every launch, and the window name no longer does — it is
      // `draft` for the life of the project. The hub keys the terminal on this,
      // because ensureWindow KILLS and recreates the window, and a terminal that
      // only watches the name cannot tell that the pane underneath it was
      // replaced. It sat attached to a window that no longer existed.
      launchedAt: new Date().toISOString(),
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
    res.json({ ok: true, sessionName, mode: resuming ? 'resumed' : 'fresh', deltaLines: delta ? delta.split('\n').filter((l) => l.startsWith('- ')).length : 0, ...session });
  });

  return router;
}

module.exports = { createDraftingRouter };
