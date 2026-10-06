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
const { ensureIgnoreRule } = require('./ignore-rule');

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

/**
 * ONE window per project, not per item.
 *
 * The owner's boundary is per project, cut by hand when the subject changes
 * (decision 2026-09-14) — and the original request was continuity across drafts,
 * "since related stories touch related areas". A window per item would give the
 * opposite: every draft a fresh conversation that has to be told the same things
 * again.
 */
function draftWindowName() {
  return 'draft';
}

function statePath(statePathDir) {
  return path.join(statePathDir, STATE_FILE);
}

const IGNORE_RULE = `.build-studio/${STATE_FILE}`;

/**
 * Make sure the project ignores the drafting state BEFORE the first write.
 *
 * Onboarding writes the rule, but only when a project is onboarded — one that
 * predates drafting never gets it, so its first session left an untracked file
 * that the next sweep-all commit picked up. Found in two projects.
 *
 * Adds this ONE line, not the whole pattern list: rewriting a project's
 * .gitignore wholesale as a side effect of clicking Draft would be a surprise.
 *
 * @returns {boolean} true when the file was changed and so needs committing —
 *   a modified .gitignore on the default branch blocks the next execution run.
 */
function ensureIgnored(projectRoot) {
  return ensureIgnoreRule(projectRoot, IGNORE_RULE);
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
/**
 * Single-quote the VALUES in a pre-built flag string.
 *
 * The launch line is typed into the pane's interactive shell, which is zsh, and
 * zsh globs unquoted arguments. Model ids carry brackets — `claude-opus-5[1m]`
 * — so `--model claude-opus-5[1m]` dies with `no matches found` before the CLI
 * starts: the pane sits at a bare prompt and the button looks like it did
 * nothing. Observed on the first real use (FAZ-318, 2026-09-17).
 *
 * bash happens to pass an unmatched glob through literally, which is why the
 * workflow launcher — which writes a script and runs it with bash — never hit
 * this. Quoting fixes it at the source instead of depending on which shell
 * reads the line.
 *
 * Flag NAMES are left alone; anything not starting with `-` is a value.
 */
function quoteFlagValues(flags) {
  return String(flags || '')
    .split(' ')
    .map((tok) => (!tok || tok.startsWith('-') ? tok : `'${tok.replace(/'/g, `'\''`)}'`))
    .join(' ');
}

function buildDraftCommand({ cli, modelFlag = '', effortFlag = '', dangerFlag = '', sessionFlag = '', promptFile }) {
  if (!cli) throw new Error('buildDraftCommand: cli is required');
  if (!promptFile) throw new Error('buildDraftCommand: promptFile is required');
  if (cli === 'opencode') {
    // The interactive TUI, not `opencode run`: `run` sends one message and
    // exits, which is a workflow agent's shape, not a conversation. Drafting on
    // OpenCode launched that way never let the owner answer a question.
    // The TUI has no `--variant`, so the effort setting is not passed.
    const ocFlags = `${quoteFlagValues(sessionFlag)}${quoteFlagValues(dangerFlag)}${quoteFlagValues(modelFlag)}`;
    return `opencode${ocFlags} --prompt "$(cat '${promptFile}')"`;
  }
  // Session flag FIRST: for codex it is the `resume <id>` subcommand, which
  // must follow the binary directly.
  const flags = `${quoteFlagValues(sessionFlag)}${quoteFlagValues(dangerFlag)}${quoteFlagValues(modelFlag)}${quoteFlagValues(effortFlag)}`;
  // claude and codex both take it as one argument via command substitution.
  return `${cli}${flags} "$(cat '${promptFile}')"`;
}

/**
 * The opening message. Names the skill and the item, and says plainly that a
 * human is on the other end — an agent that assumes it is unattended will write
 * the document instead of asking about it, which is the one failure this step
 * cannot tolerate.
 */
function draftPrompt({ itemId, title }) {
  // Backticked-skill form, NOT `/draft_prd`. The skill lives in
  // `.claude/skills/draft_prd/`, so the slash form resolves against
  // `.claude/commands/` instead, finds nothing, and inlines nothing — leaving a
  // non-Claude agent to invent a substitute for the one thing this step must get
  // right. See agent-skills.js.
  return `Use the \`draft_prd\` skill to draft a PRD for backlog item ${itemId}${title ? ` — "${title}"` : ''}.

This is an INTERACTIVE session. The owner is at the keyboard and will answer
questions. Drafting is where they shape the product, so ask rather than assume:
your job is to interrogate the idea and write down what is decided, not to
produce a finished document from one prompt.

Start by reading the backlog item and whatever it references, then open the
conversation with what you need to know.`;
}

/**
 * What to say when an EXISTING conversation is pointed at a new item.
 *
 * Deliberately short. The session already knows how this project drafts and what
 * was discussed; repeating the full briefing would spend context re-teaching it
 * what it just did, which is the cost continuity exists to avoid.
 */
function continuePrompt({ itemId, title, sameItem = false }) {
  // Resuming the draft that was ended before its PRD was written is not a new
  // item: "Next: draft…" told the agent to start over on work it had half done.
  if (sameItem) {
    return `Continue drafting the PRD for backlog item ${itemId}${title ? ` — "${title}"` : ''} where we left off.`
      + ` The draft was paused before the PRD was written. Pick up from the last open question,`
      + ` and check the item and any file you had started before assuming it is unchanged.`;
  }
  return `Next: draft a PRD for backlog item ${itemId}${title ? ` — "${title}"` : ''}.`
    + ` Same skill and the same conventions as the previous draft in this session.`
    + ` Read the item first, then ask what you need to know.`;
}

// ─── Create story ────────────────────────────────────────────────────────────
//
// The Create story button runs the `create_story` skill in THIS session, not a
// session of its own (owner request 2026-10-06): a story usually comes up while
// drafting a neighbouring one, and the conversation that just discussed that
// area is the one that should write it down. It shares the one-at-a-time rule
// too: while a draft is running the button is disabled, and the owner asks for
// a story in the terminal instead, which reaches the same skill.

/** Skill the Create story button runs. Shipped in templates/default. */
const CREATE_STORY_SKILL = 'create_story';

/**
 * Words the opening prompt always contains. For Codex and OpenCode the session
 * id is read back from the CLI's own records by finding the prompt that opened
 * it (draft-session-id.js); a Draft session is found by its item id, and a
 * session opened by Create story has none, so it is found by this phrase.
 */
const CREATE_STORY_MARKER = 'create a new backlog story';

function createStoryPrompt({ port }) {
  // Backticked-skill form, as draftPrompt explains.
  return `Use the \`${CREATE_STORY_SKILL}\` skill to ${CREATE_STORY_MARKER} with the owner.

This is an INTERACTIVE session. The owner is at the keyboard and will answer
questions. Interview them about the story, agree its position in the backlog
with them, and file it through Build Studio's backlog endpoint:
POST http://localhost:${port}/api/backlog/items

Start by reading the backlog order and the items related to what the owner
describes, then open the conversation by asking what the story is.`;
}

/** The same request, to a conversation that already knows how this project works. */
function continueCreateStoryPrompt({ port }) {
  return `Next: ${CREATE_STORY_MARKER} with the owner, using the \`${CREATE_STORY_SKILL}\` skill.`
    + ' Use what we have discussed in this session; do not ask what it already answers.'
    + ` File it through POST http://localhost:${port}/api/backlog/items.`
    + ' Start by asking what the story is.';
}

/**
 * Put the create_story skill in the project when it lacks one.
 *
 * Template skills are copied at onboarding only, so every project onboarded
 * before this skill existed would get a button whose skill is not there — and
 * an agent told to use a missing skill improvises one. A project that already
 * has the skill keeps its own: it may have been edited.
 *
 * @returns {string|null} the repo-relative path written, or null when nothing was
 */
function ensureCreateStorySkill(projectRoot, templateDir) {
  const rel = path.join('.claude', 'skills', CREATE_STORY_SKILL, 'SKILL.md');
  const dst = path.join(projectRoot, rel);
  if (fs.existsSync(dst)) return null;
  const src = templateDir && path.join(templateDir, rel);
  if (!src || !fs.existsSync(src)) return null;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return rel;
}

/**
 * The files a finished draft leaves behind, repo-relative, for committing.
 *
 * The draft_prd skill's handoff writes three things: the PRD, the backlog item
 * (status `Drafted`, `prd:` set) and the backlog row in project-state.md. None
 * of them were committed, so they sat on the default branch until the next
 * execution start refused the dirty tree (owner request 2026-10-01: commit the
 * PRD when the draft ends).
 *
 * Only files that exist are returned: `git add` fails on a missing path, and an
 * item whose PRD was never written still has its other edits worth keeping.
 * Clean files are harmless — scopedCommit commits nothing for them.
 */
function draftCommitPaths({ projectRoot, docsRel, itemIds, readItem, exists = fs.existsSync }) {
  const rel = (abs) => path.relative(projectRoot, abs);
  const out = new Set();
  for (const id of itemIds || []) {
    let item = null;
    try { item = readItem(projectRoot, docsRel, id); } catch (_) { continue; }
    if (!item) continue;
    out.add(path.join(docsRel, 'backlog', `${id}.md`));
    if (item.prd && exists(path.join(projectRoot, item.prd))) out.add(item.prd);
  }
  if (out.size && exists(path.join(projectRoot, docsRel, 'project-state.md'))) {
    out.add(path.join(docsRel, 'project-state.md'));
  }
  // The vision too: a draft that settles a project-level open question moves
  // it from "not decided" to decided in the vision's table, and leaving that
  // edit uncommitted blocked the next execution run (first real draft,
  // 2026-10-03). An unchanged vision is harmless: scopedCommit commits nothing
  // for a clean file.
  if (out.size && exists(path.join(projectRoot, docsRel, 'vision.md'))) {
    out.add(path.join(docsRel, 'vision.md'));
  }
  return [...out].map((p) => (path.isAbsolute(p) ? rel(p) : p));
}

/** Conventional-commit message for a draft, naming the items it covers. */
function draftCommitMessage(itemIds) {
  const ids = [...new Set(itemIds || [])];
  return `docs(${ids.join(',')}): draft PRD${ids.length > 1 ? 's' : ''}`;
}

module.exports = {
  DRAFT_STEP,
  draftCommitPaths,
  draftCommitMessage,
  STATE_FILE,
  draftSessionName,
  draftWindowName,
  ensureIgnored,
  IGNORE_RULE,
  loadDraftState,
  saveDraftState,
  recordSession,
  buildDraftCommand,
  quoteFlagValues,
  draftPrompt,
  continuePrompt,
  CREATE_STORY_SKILL,
  CREATE_STORY_MARKER,
  createStoryPrompt,
  continueCreateStoryPrompt,
  ensureCreateStorySkill,
};
