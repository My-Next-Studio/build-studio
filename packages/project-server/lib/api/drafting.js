'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  DRAFT_STEP, draftSessionName, draftWindowName,
  loadDraftState, saveDraftState, buildDraftCommand, draftPrompt, continuePrompt,
  ensureIgnored, draftCommitPaths, draftCommitMessage,
  CREATE_STORY_SKILL, CREATE_STORY_MARKER, createStoryPrompt, continueCreateStoryPrompt, ensureCreateStorySkill,
} = require('../drafting');
const { resolveTemplateDir } = require('../agents-md');
const { scopedCommit } = require('../scoped-commit');
const {
  resolveStepLaunchSettings, canPinSession, canResumeSession, sessionPinFlag, sessionResumeFlag,
} = require('@build-studio/shared/cli');
const { findDraftSessionId } = require('../draft-session-id');
const { readItem } = require('../backlog');
const agentSkills = require('../agent-skills');
const { computeDraftDelta, formatDraftDelta } = require('../draft-delta');

/**
 * Drafting runs OUTSIDE the workflow slot — see lib/drafting.js for why that is
 * a requirement rather than a convenience.
 */
function createDraftingRouter(config, state, tmuxOps, { findSessionId = findDraftSessionId, templateDir = resolveTemplateDir() } = {}) {
  const router = express.Router();
  const projectRoot = config.projectRoot;
  const projectName = config.name || path.basename(projectRoot);

  /**
   * The conversation id of a drafting session, or null.
   *
   * Claude's is chosen at launch and stored. Codex and OpenCode choose their
   * own, so it is read back from the CLI's records the first time it is needed
   * (draft-session-id.js), matched on the session's launch time and the item it
   * opened on. Only called from Draft and End draft, never from the poll: the
   * OpenCode lookup starts processes.
   */
  function sessionIdOf(session) {
    if (!session) return null;
    if (session.cliSessionId) return session.cliSessionId;
    if (canPinSession(session.cli) || !canResumeSession(session.cli)) return null;
    const itemId = session.openingItemId || (session.items || [])[0];
    // A session opened by Create story has no item; it is found by its marker.
    const marker = !itemId && session.openingMarker ? { marker: session.openingMarker } : {};
    try {
      return findSessionId({ cli: session.cli, projectRoot, since: session.startedAt, itemId, ...marker }) || null;
    } catch (e) {
      console.warn(`[draft] could not look up the ${session.cli} session id: ${e.message}`);
      return null;
    }
  }
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
        // Codex/OpenCode ids are looked up on the next Draft, not here (this is
        // polled), so for them "resumable" means "will be looked up".
        resumable: !!session.cliSessionId || (canResumeSession(session.cli) && !canPinSession(session.cli)),
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
    // Codex/OpenCode: read the conversation id back now and keep it, so the next
    // Draft resumes it without another lookup.
    const cliSessionId = sessionIdOf(session);
    if (!pid) {
      saveDraftState(config.statePath, { ...state, session: { ...session, cliSessionId, endedAt: new Date().toISOString() } });
      const commit = await commitDrafts(session);
      return res.json({ ok: true, alreadyEnded: true, resumable: !!cliSessionId, commit });
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
      session: { ...session, cliSessionId, endedAt: new Date().toISOString() },
    });
    // Ending is the owner saying the draft is done, so its files are committed
    // now. The agent's own writes finished before it returned to its prompt.
    const commit = await commitDrafts(session);
    // The process takes a moment to go; the poll notices and re-enables the
    // buttons. Reported rather than waited for, so the request does not hang.
    res.json({ ok: true, ending: true, resumable: !!cliSessionId, commit });
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

    return launchInSession(res, {
      itemId,
      wantFresh,
      freshPrompt: () => draftPrompt({ itemId, title: item && item.title }),
      resumePrompt: (prior) => continuePrompt({ itemId, title: item && item.title, sameItem: prior.lastItemId === itemId }),
    });
  });

  /**
   * Create a backlog story with the owner, in the drafting session.
   *
   * The same conversation as Draft, deliberately (owner request 2026-10-06): a
   * story usually comes up while drafting its neighbour, and that conversation
   * already holds the context the story needs. So this shares Draft's session,
   * its resume path and its one-at-a-time rule — the hub disables the button
   * while a draft runs, and the owner asks for the story in the terminal.
   *
   * The agent files the story through POST /backlog/items, which allocates the
   * id, places it and commits it. Nothing here writes to the backlog.
   */
  router.post('/draft/create-story', async (req, res) => {
    const wantFresh = (req.body && req.body.fresh) === true;
    return launchInSession(res, {
      itemId: null,
      wantFresh,
      freshPrompt: () => createStoryPrompt({ port: config.port }),
      resumePrompt: () => continueCreateStoryPrompt({ port: config.port }),
    });
  });

  /**
   * Start, continue, or resume the drafting session with a given opening
   * request — a draft of `itemId`, or (itemId null) a new story.
   */
  async function launchInSession(res, { itemId, wantFresh, freshPrompt, resumePrompt }) {
    // Every drafting session gets the create_story skill, not only one opened
    // by Create story: while a draft runs, the owner asks for a story in the
    // terminal, and that must reach the skill too. Projects onboarded before it
    // existed lack it, so it is installed here, before the CLI starts, and
    // committed so it does not sit untracked on the default branch.
    try {
      const added = ensureCreateStorySkill(projectRoot, templateDir);
      if (added && fs.existsSync(path.join(projectRoot, '.git'))) {
        const r = await scopedCommit(projectRoot, [added], `chore: add the ${CREATE_STORY_SKILL} skill`);
        if (!r.committed) console.warn(`[draft] ${added} installed but not committed: ${r.reason}`);
      }
    } catch (e) {
      console.warn(`[draft] could not install the ${CREATE_STORY_SKILL} skill: ${e.message}`);
    }
    // Ignore the state file before writing it, and commit the rule at once: a
    // modified .gitignore on the default branch blocks the next execution run.
    // Pathspec-scoped, so nothing an agent has staged is swept in. Advisory —
    // a failed commit leaves one line to commit by hand, not a broken draft.
    // Awaited: the leftover-draft commit below runs in the same repo, and two
    // commits at once contend for git's index lock. Unawaited, the draft
    // commit could exhaust its retries under load and be skipped.
    try {
      if (ensureIgnored(projectRoot) && fs.existsSync(path.join(projectRoot, '.git'))) {
        const r = await scopedCommit(projectRoot, ['.gitignore'], 'chore: gitignore drafting state');
        if (!r.committed) console.warn(`[draft] .gitignore not committed: ${r.reason}`);
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
    // Resume only on the CLI that holds the conversation: another CLI's id means
    // nothing to it. A CLI switch starts fresh (plan decision 5).
    const priorId = prior && prior.cli === cli ? sessionIdOf(prior) : null;
    const resuming = !!(priorId && canResumeSession(cli) && !wantFresh);
    // Claude's id is chosen here; Codex/OpenCode choose their own and it is read
    // back later, so a fresh launch on those starts with none.
    const cliSessionId = resuming
      ? priorId
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
    const prompt = resuming ? resumePrompt(prior) + delta : freshPrompt();
    const inlined = agentSkills.inlineReferencedDefinitions(prompt, { cli, roots: [projectRoot], fs });
    if (inlined) {
      console.log(`[draft] inlined .claude definitions for ${itemId || 'a new story'} (${cli}): ${inlined.length} chars`);
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
      // null after Create story: the session is no longer on the last draft's
      // item, and "continue where we left off" would be wrong for it.
      lastItemId: itemId,
      lastAction: itemId ? 'draft' : 'create_story',
      // What the conversation OPENED on: its prompt is what identifies a
      // Codex/OpenCode session when the id is read back (draft-session-id.js).
      // An item for a Draft, the marker phrase for Create story.
      openingItemId: resuming ? (prior.openingItemId || (prior.items || [])[0] || itemId) : itemId,
      openingMarker: resuming ? (prior.openingMarker || null) : (itemId ? null : CREATE_STORY_MARKER),
      // The items this session drafted, which End draft commits. A story is
      // committed when it is filed, so Create story adds nothing here.
      items: [...new Set([...(resuming ? (prior.items || []) : []), ...(itemId ? [itemId] : [])])],
      resumable: canResumeSession(cli),
    };
    saveDraftState(config.statePath, { ...state, sessionName, session });
    res.json({ ok: true, sessionName, mode: resuming ? 'resumed' : 'fresh', deltaLines: delta ? delta.split('\n').filter((l) => l.startsWith('- ')).length : 0, ...session });
  }

  return router;
}

module.exports = { createDraftingRouter };
