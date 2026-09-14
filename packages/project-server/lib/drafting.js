'use strict';

/**
 * Drafting sessions — the owner and one agent talking until a PRD exists.
 *
 * WHY THIS IS NOT A WORKFLOW
 *
 * Every workflow here has steps, gates, an approve/send-back transition and a
 * feedback contract. Drafting has none of them: it is one conversation, with no
 * intermediate state worth gating and an output that is a file rather than a
 * structured report.
 *
 * The constraint that actually forces the separation is narrower than taste. A
 * project allows ONE active workflow (`POST /workflow/start` answers 409
 * otherwise), and the established practice is to draft with review and
 * execution rounds in between. A drafting session occupying the workflow slot
 * would forbid the very interleaving it exists to support — so it runs in its
 * own tmux session and touches no workflow state.
 *
 * SESSION BOUNDARY (owner decision 2026-09-14)
 *
 * Per project, cut by hand when the subject changes. Not per release and not
 * per phase: the natural boundary is a change of AREA, which no release or
 * phase marker tracks. Expect several sessions inside one release. Nothing here
 * expires a session automatically; increment 2 adds an explicit "start fresh".
 */

const fs = require('fs');
const path = require('path');

/** The pseudo-step drafting resolves its CLI through. In the `plan` group. */
const DRAFT_STEP = 'draft_prd';

const STATE_FILE = 'draft-state.json';

/** tmux names have to survive `-t session:window` lookups. */
const sanitize = (s) => String(s || '').replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

/**
 * The tmux session drafting lives in — deliberately NOT the workflow session.
 *
 * Sharing it would tie a conversation's lifetime to a run's: reaping a finished
 * workflow's session takes every window with it, and the drafting window would
 * die with a run it has nothing to do with.
 */
function draftSessionName(projectName) {
  return `draft-${sanitize(projectName) || 'project'}`;
}

/** One window per item, so two drafts in flight do not share a pane. */
function draftWindowName(itemId) {
  return `draft-${sanitize(itemId) || 'item'}`.slice(0, 24);
}

function statePath(statePathDir) {
  return path.join(statePathDir, STATE_FILE);
}

/** Read the drafting state. Advisory: a missing or corrupt file reads as empty. */
function loadDraftState(statePathDir) {
  try {
    const raw = fs.readFileSync(statePath(statePathDir), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : { sessions: {} };
  } catch (_) {
    return { sessions: {} };
  }
}

function saveDraftState(statePathDir, state) {
  fs.mkdirSync(statePathDir, { recursive: true });
  fs.writeFileSync(statePath(statePathDir), JSON.stringify(state, null, 2) + '\n', 'utf8');
}

/**
 * Record a launched drafting session.
 *
 * Keyed by item so a second Draft click on the same item reattaches rather than
 * opening a second pane against the same document.
 */
function recordSession(statePathDir, sessionName, itemId, entry) {
  const state = loadDraftState(statePathDir);
  state.sessionName = sessionName;
  state.sessions = state.sessions || {};
  state.sessions[itemId] = { ...entry, itemId };
  saveDraftState(statePathDir, state);
  return state;
}

/**
 * The shell line that starts the conversation.
 *
 * Built per CLI through the shared flag builder rather than hard-coded to
 * `claude`. Building it against one CLI's spellings and retrofitting the others
 * is the mistake this is written to avoid — the button would be Claude-only in
 * practice while looking CLI-agnostic in config.
 *
 * The prompt is delivered through a FILE, not inlined: a skill invocation plus
 * an item id is small, but the same path carries whatever increment 4's
 * re-grounding delta grows into, and shell-escaping a growing prompt is a
 * recurring source of silent corruption.
 */
function buildDraftCommand({ cli, modelFlag = '', effortFlag = '', dangerFlag = '', promptFile }) {
  if (!cli) throw new Error('buildDraftCommand: cli is required');
  if (!promptFile) throw new Error('buildDraftCommand: promptFile is required');
  if (cli === 'opencode') {
    // OpenCode reads the prompt from stdin — verified for multi-KB prompts with
    // no shell-escaping exposure.
    return `opencode run${modelFlag}${effortFlag}${dangerFlag} < '${promptFile}'`;
  }
  // claude and codex both take it as one argument via command substitution.
  return `${cli}${dangerFlag}${modelFlag}${effortFlag} "$(cat '${promptFile}')"`;
}

/**
 * The opening message. Names the skill and the item, and says plainly that a
 * human is on the other end — an agent that assumes it is unattended will write
 * the document instead of asking about it, which is the one failure this step
 * cannot tolerate.
 */
function draftPrompt({ itemId, title }) {
  return `Use the /draft_prd skill to draft a PRD for backlog item ${itemId}${title ? ` — "${title}"` : ''}.

This is an INTERACTIVE session. The owner is at the keyboard and will answer
questions. Drafting is where they shape the product, so ask rather than assume:
your job is to interrogate the idea and write down what is decided, not to
produce a finished document from one prompt.

Start by reading the backlog item and whatever it references, then open the
conversation with what you need to know.`;
}

module.exports = {
  DRAFT_STEP,
  STATE_FILE,
  draftSessionName,
  draftWindowName,
  loadDraftState,
  saveDraftState,
  recordSession,
  buildDraftCommand,
  draftPrompt,
};
