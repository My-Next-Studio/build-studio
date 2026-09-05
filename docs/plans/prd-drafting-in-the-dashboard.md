# Plan: PRD drafting as a first-class, interactive step

> **Status: proposed 2026-09-06.**
>
> Owner request: a **Draft** button on backlog items in status `Backlog`,
> alongside Review and Execute, opening a session the owner can talk to — and
> keeping context across drafts, since related stories touch related areas.

Drafting is the step where the owner shapes the product. Everything after it —
review, build, test, merge — is meant to run without them. It is also the only
step of the cycle that lives entirely outside the dashboard: today it happens in
a terminal the owner opened themselves, in a session the engine knows nothing
about.

The `draft_prd` skill made the *conversation* good. This plan is about making
the dashboard host it.

## Drafting is not a workflow, and should not be modelled as one

Every workflow in the engine has steps, gates, an approve/send-back transition
and a feedback contract: an agent runs, POSTs a structured report, and the step
advances. Drafting has none of those. It is one agent and one human talking until
a document exists, with no intermediate states worth gating.

Forcing it into the workflow machinery would mean inventing a step sequence for
something that has no steps, and a feedback contract for output that is a file.
The engine already has a second, lighter concept for exactly this reason —
`run-state.json` beside `workflow-state.json` — and a drafting session belongs
in that family rather than as a workflow type.

**This is the constraint that matters most.** A project allows one active
workflow at a time (`POST /workflow/start` answers 409 otherwise). The owner's
existing practice is to draft *with review and execution rounds in between*, so
a drafting session that consumed the workflow slot would forbid the very
interleaving it is meant to support.

## Concern 1 — an interactive session · mostly already built

The hub's agent terminal is not a log tail. It is a real pty (`node-pty`) over a
WebSocket, attached to the agent's tmux window through a **grouped view
session**, with keystrokes fed back through `ws.on('message')`. It already
solves the parts that are easy to get wrong: a grouped session shares the
windows but keeps its own current-window, so one viewer never flips what another
sees, and `destroy-unattached` reaps the view the moment the socket closes.

What is missing is small, and every piece has a working precedent:

| need | precedent in the codebase |
|---|---|
| launch `claude` **interactively** (not `claude "$(cat prompt)"`, which is one-shot) | the launch path already branches per CLI |
| deliver the skill invocation after boot | the `/goal` arming line: `tmux load-buffer` → `paste-buffer` → `send-keys Enter` |
| let the terminal attach to a non-workflow session | `resolveAgentTarget` needs to look in drafting sessions too |
| survive a project-server restart | tmux sessions already outlive the server |

## Concern 2 — context across drafts · the actual design question

The owner's current practice is one long-lived session that accumulates
knowledge of a work area across several PRDs. That should be the default, and
there is a cost argument for it beyond preference:

**Continuity is cheaper than freshness.** Cache reads are an order of magnitude
cheaper than fresh input. A resumed session re-reading the vision, the decisions
log and neighbouring PRDs pays cache rates; a fresh session pays full input
rates for the same material, every time. On a workload already measured at
roughly 200:1 cache-read-to-output, that difference dominates.

So: **one drafting session per project**, resumed by session id, with the id
stored durably so it survives restarts.

Three things make that safe rather than merely convenient:

### Re-ground on resume, with a delta

Before each new drafting prompt, inject what changed since the last one: ADRs
superseded, decisions added to the log, PRDs that completed review. Short —
a list, not a briefing.

This is the same lesson the re-review work paid for: **continuity plus a delta
beats either alone.** A session that began before an ADR was superseded will
otherwise draft confidently against the old one, and confidence is the problem.

### Make the boundary visible and cuttable

Surface the session's age, how many PRDs it has drafted, and its token usage.
Offer "start fresh". The natural boundary is a release or a phase.

Without this the session is an invisible input to every PRD — the same story
drafted in two different sessions yields two different documents, and nothing in
the artifact chain records which session produced what.

### Watch for cross-contamination

A session saturated with one implementation track's context, used to draft a
story from another, is the **same failure as building under the wrong role**:
wrong lens, plausible output, nothing errors. That failure has already been paid
for once at the builder level. It is the strongest argument for cutting at phase
boundaries rather than never cutting.

## LLM-agnostic by construction

Build Studio supports three agent CLIs and a fork may use any of them, so
drafting cannot be a Claude-only feature. It depends on two capabilities —
**resuming a session** and **invoking a skill** — and both turn out to be
universal. Verified against the installed CLIs:

| | session id | resume | skills |
|---|---|---|---|
| claude | **pinned at launch** (`--session-id`) | `--resume <id>` | `~/.claude/skills/` + project `.claude/skills/` |
| codex | assigned; printed in its banner | `codex resume <id> [PROMPT]` | `~/.codex/skills/` |
| opencode | assigned | `--session <id>`, or `--continue` for the last | `~/.config/opencode/skills/` |

Three differences, all mechanical:

- **Acquiring the session id.** Claude lets us choose one; the other two assign
  it and we read it back. That read-back already exists for Codex — the
  telemetry work parses the id out of the pane log to find its rollout, and
  drafting needs the same value for the same reason.
- **The resume invocation** differs per CLI. `codex resume` conveniently takes
  the follow-up prompt as an argument, which is exactly the drafting shape.
- **Where a skill is installed.** The **SKILL.md format is identical** across all
  three — same frontmatter, same body — so the file this plan depends on is
  already portable. Only the directory differs.

All three belong in `shared/cli.js`, which is already the single source of truth
for the claude/codex/opencode switch and is where every other per-CLI spelling
lives.

**The real gap is distribution, not capability.** `draft_prd` is installed today
into each project's `.claude/skills/`, which only Claude Code reads. A Codex or
OpenCode user gets the Draft button and no skill behind it. Build Studio already
scaffolds skills into projects; it needs to place them for whichever CLIs are
enabled, not only for Claude.

### Configured, not picked per run

Workflow runs get a per-run CLI picker because each run is independent. Drafting
is the opposite: it is one continuing conversation, and switching model
mid-conversation is not a feature. So it is **configuration**, in the same
`{cli, model, effort}` slot shape the rest of the cli block already uses:

```yaml
cli:
  drafting:
    cli: claude
    model: claude-opus-5[1m]
    effort: medium
```

A sibling of `cli.groups`, not a member of it: groups are keyed by *step group*,
and drafting is not a step. Reusing the slot shape means it inherits the
existing validation and can appear in the Model tab beside the others.

**Changing it is a session boundary.** Switching CLI or model — at a new model
release, say — should offer to start a fresh drafting session rather than
resuming the old one under a different mind. That is the same reason the owner
wants consistency in the first place: a conversation half-reasoned by one model
and half by another is worse than either. It also gives the "visible and
cuttable boundary" above a natural, meaningful trigger instead of an arbitrary
one.

## Other considerations

- **Abandonment.** A session walked away from leaves the item in limbo. Rule:
  the item's status flips to `Drafted` only when the PRD file exists on disk —
  never on drafting *starting*. Drafting is resumable and interruptible by
  design, so an interrupted draft should look like an un-drafted story.
- **Idle sessions.** One long-lived session per project, across many projects, is
  a lot of resident context. Needs at least a listing of which sessions are
  alive, and probably an idle-reap policy.
- **The working tree.** Drafting writes documents while an execution run may hold
  a branch. Different files, so likely benign — but it should be a stated
  decision rather than something discovered.
- **Telemetry.** A drafting session is a long-lived agent with real cost, and it
  is not a workflow agent. Whether it appears in the scorecard, and under what
  role, is an open question — it is the owner's own reasoning as much as the
  agent's.

## Increments

Each is useful on its own, and each proves the next.

1. **Draft button → interactive session.** Launches the configured CLI in a tmux
   window outside the workflow slot, delivers the skill invocation, opens the
   terminal panel. No continuity. Proves the plumbing end to end.
2. **Session persistence.** Store the drafting session id per project, resume
   it, show age and usage, offer "start fresh". This is where the per-CLI
   resume spellings land in `shared/cli.js`.
3. **Skill distribution** to whichever CLIs a project has enabled, so the Draft
   button is not Claude-only in practice.
4. **Delta re-grounding** on resume.

Increment 1 can ship Claude-first without foreclosing the rest, provided the
launch goes through the CLI switch rather than hard-coding `claude` — the
mistake would be building the button against one CLI's spellings and
retrofitting later.

## Explicitly out of scope

- Making drafting a workflow type, with steps and gates.
- Automating the owner out of drafting. The skill's whole design is that this is
  where a human belongs; the dashboard should host the conversation, not replace
  it.
- A shared drafting session across projects. Cross-project contamination is the
  failure mode above, with the blast radius widened.

## Open decisions

1. **Session boundary.** Per project indefinitely, per release, or per phase?
   Indefinitely is what the owner does today and works; the risk is a stale,
   drifted session nobody thinks to cut.
2. **Where the session lives in state.** Extending `run-state.json`, or a third
   file beside it. A third file is cleaner; one more state file is one more
   thing that can be orphaned.
3. **Whether the Draft button is available on items that already have a PRD.**
   Re-drafting is legitimate (a story whose scope changed), but it silently
   replaces a reviewed document.
4. **Whether drafting sessions appear in the scorecard**, and if so under which
   role — they are a joint product of the agent and the owner, which none of the
   existing rows are.
5. **What a CLI or model change does to a live session.** Offering a fresh
   session is proposed above, but forcing one is also defensible, and so is
   resuming under the new model with a visible marker on the PRD that it
   happened mid-conversation.
6. **Whether OpenCode's inability to pin a session id at launch matters here.**
   Reading it back after the fact is enough for resumption, but it means a
   session that dies before announcing itself is unrecoverable — the same
   asymmetry the telemetry work hit, where an unlinkable agent yields null
   rather than a guess.

## Verification

- Draft on a `Backlog` item opens a terminal that accepts input and reaches the
  skill, with no workflow started and the workflow slot still free.
- A review workflow can be started **while** a drafting session is open.
- Closing the terminal panel leaves the session running; reopening reattaches to
  the same conversation.
- Restarting the project-server leaves the drafting session alive and
  reattachable.
- Abandoning a draft leaves the item in `Backlog` with no PRD reference.
- A second draft in the same session shows the delta since the first, and names
  any ADR superseded in between.
