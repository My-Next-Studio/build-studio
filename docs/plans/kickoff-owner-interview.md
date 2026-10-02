# Plan: the kickoff interviews the owner

> **Status: implemented 2026-10-02** (proposed 2026-09-30). All four
> increments. See *Where this stands* at the end.
>
> Owner request: a new project has many open questions, and the PM should
> interview the owner about them during kickoff, the way the Draft button
> interviews them per story. Not every question has to be settled at kickoff.
> Questions that belong to a single story are settled when that story is
> drafted. The owner needs an interactive window to answer in.

The kickoff turns the owner's inputs into a vision, a backlog and a project
state. It is the moment with the most open questions in a project's life, and
today it asks none of them.

## What exists today

The kickoff runs `ceo_synthesis` → `pm_scoping` → `owner_consultations` →
`team_review` → `pm_revision` → `companion_specs` → `devops_init`.

`owner_consultations` is a manual gate with a free-text box. The owner is
expected to read everything the CEO and PM wrote, notice what was assumed,
and write notes, without being asked anything. The notes are saved to
`docs/inputs/owner-consultation-round-N.md` and passed to the review and
revision agents.

That puts the work on the wrong side. The agents know which decisions they
made on the owner's behalf; the owner has to find them in several new
documents. What is not noticed is decided silently and surfaces much later,
as a product the owner did not ask for. Drafting solved the same problem
per story (`prd-drafting-in-the-dashboard.md`); the kickoff needs the same
interview, one level up.

## The method: a skill, `kickoff_interview`

A skill, sibling to `draft_prd`, rather than instructions in the step's prompt:

- **It is a method, not an instruction.** What to ask, what not to ask, how to
  ask and where answers go must be written down, versioned and improved over
  time, as `draft_prd` has been.
- **It works on every CLI.** Skill definitions are already inlined into the
  prompt for agents whose CLI does not load `.claude/skills/`.
- **It can be run by hand.** An owner can type `/kickoff_interview` in any
  session, as with `draft_prd`.

The skill follows `draft_prd`'s structure, raised from a story to a project:

1. **Resolve before asking.** Read `docs/inputs/`, the fresh `docs/vision.md`,
   `docs/project-state.md` and the backlog. State what is already answered and
   where, one line each. That line is how the owner catches an assumption made
   wrongly, which is otherwise invisible until review.
2. **The filter, at project level.** Ask only what shapes the whole product or
   is expensive to reverse:
   - who the product is for, and who it is explicitly not for;
   - business model and pricing;
   - platforms and distribution;
   - what the first release must contain, and what it must not;
   - hard constraints: legal, privacy, data, brand;
   - how success will be measured.

   Engineering choices that produce the same product are not asked. They go
   to the architect as written open questions.
3. **Defer to the story, don't drop.** A question that belongs to one backlog
   item is written **into that item** as an open question, not asked now.
   When the owner later drafts the item, `draft_prd`'s *resolve before you
   ask* step reads it and asks it then, in context. This is the split the
   owner asked for: project-level questions at kickoff, story-level
   questions at drafting.
4. **Ask** one topic at a time, one to three questions per turn. Each question
   comes with concrete options and a recommendation, and "not decided yet" is
   always an acceptable answer. The owner is at the keyboard; the skill says
   so, because an agent that assumes it is unattended writes answers instead
   of asking for them.
5. **Record the answers where later agents already look.**
   - The **Key Decisions Log** in `docs/project-state.md`, which every PM,
     reviewer and drafting session reads.
   - `docs/vision.md`, updated where an answer changes it.
   - `docs/inputs/kickoff-interview.md`, a dated summary of the interview.
     This replaces the old consultation notes file, so `team_review` and
     `pm_revision` read it the same way.
6. **Close.** Summarise what was decided, what was deferred to which backlog
   items, and what is still open and for which role. Then report to the
   workflow, which continues to `team_review`.

## Where it goes in the kickoff

The `owner_consultations` step is replaced by an `owner_interview` step, in
the same place: after `pm_scoping`, before `team_review`.

It comes after scoping on purpose. By then the CEO and PM have read the inputs
and written drafts, so the questions are concrete: "the backlog assumes a
subscription; is that right?" rather than "how will you charge?". The review
and revision that follow then work from the owner's answers, not from guesses.

Rejected: interviewing before `ceo_synthesis`. The questions would be generic,
because nothing has been written yet to be wrong about.

## The UI: the interactive terminal

The interview runs as an interactive PM session in its own tmux window, on
the drafting feature's launcher (prompt file, pinned session id, pane log,
resume). In the workflow view, the `owner_interview` step card embeds the
live terminal, so the owner answers in place. The card offers:

- **minimise / maximise**, as the drafting panel does;
- **End session**, which exits the agent and keeps the conversation. Opening
  the step again resumes it, on CLIs that can resume;
- **Finish interview**, which completes the step when the owner is done,
  whether or not the agent has posted its summary;
- **Skip interview**, which continues without one.

The step waits for the owner. Auto-advance never acts on it, and nothing
times out, so an interview can span days.

Rejected, for now: a structured questionnaire (question cards with answer
buttons). It would look better, but it needs a question format shared by the
agent and the UI, and it loses the back-and-forth ("that depends; what would
it mean for pricing?") that makes these interviews worth doing. The terminal
is already proven by drafting and needs almost no new UI. If owners mostly
pick from offered options, answer buttons can be added over the same skill
later.

## Increments

1. **The skill.** `kickoff_interview` in `templates/default/.claude/skills/`
   and in Build Studio's own copy, including the defer-to-the-story rule.
2. **The step.** Replace `owner_consultations` with `owner_interview` in the
   kickoff sequence and preset, launched as an interactive session through
   the drafting launcher. A run already parked on `owner_consultations` keeps
   working. The old gate stays accepted for runs started before the change.
3. **The step card.** Embedded terminal, End and resume, Finish, Skip.
4. **Close the loop in `draft_prd`.** One line in *resolve before you ask*:
   open questions deferred from the kickoff are in the backlog item. Ask them
   now, in the story's context.

Each is useful alone: the skill works by hand before the step exists, and
the step works before the card is polished.

## Explicitly out of scope

- Interviewing in review or execution workflows. Those are meant to run
  without the owner. Drafting is where story decisions happen.
- Answering on the owner's behalf. When the owner doesn't know, "not decided
  yet" is recorded as an open question, not filled in.
- A cross-project interview. Each project's kickoff is its own.

## Decisions taken (2026-10-02)

1. **Who asks: the PM, in one session.** CEO-level questions (business model,
   positioning) are asked by the same session with the vision open, rather
   than handing the owner between two agents.
2. **Re-running: kickoff only, for now.** A re-kickoff (a new phase, a pivot)
   is a separate workflow question and gets its own plan when needed. The
   skill can be run by hand in any session meanwhile.

## Verification

- A kickoff reaches `owner_interview` and opens a terminal the owner can type
  into, with no other step running.
- The interview's first message states what was resolved from the inputs and
  where.
- A story-level question is written into its backlog item, not asked. A later
  Draft on that item asks it.
- Answers appear in the Key Decisions Log, and `team_review` reads
  `docs/inputs/kickoff-interview.md`.
- Ending the session and reopening the step resumes the same conversation.
- Skip and Finish both advance the kickoff. Auto-advance never does.

## Where this stands (2026-10-02)

All four increments are built.

- **The skill:** `templates/default/.claude/skills/kickoff_interview/`.
  Kickoff runs once, in new projects, which get the template's skills at
  onboarding, so no copy is distributed to existing projects.
- **The step:** `owner_interview` replaces `owner_consultations` in the presets
  that had it (`web-app`, `mobile-app`, `solo`). Routing is by sequence: scoping
  hands over to the interview only when the project's kickoff sequence names
  it. Everything else keeps the old routing, including a run already parked on
  the old gate and a custom sequence that still names it.
- **Not a workflow agent.** The session is stored on the step
  (`step.session`), in its own tmux session, outside `step.agents`. Otherwise the
  watchdogs (dead process, stuck, finished but not reported) would treat a person
  thinking for an hour as a stalled agent. The launcher is drafting's, so
  resume works on all three CLIs; Codex and OpenCode ids are read back by the
  interview prompt's marker phrase.
- **Finish commits** the interview summary, `project-state.md`, `vision.md` and
  the backlog, before `team_review` starts, so the reviewers see the answers.
  Skip commits nothing. Auto-advance never acts on the step, server or client.
- **The card:** Start / Resume, End session, Finish, Skip, and the embedded
  terminal with minimise.
- **`draft_prd`** asks the questions deferred from the kickoff, which are written
  into the backlog item as `Open question from kickoff … → owner`.

### Found while building, then fixed (2026-10-02)

- **The kickoff ignored its preset's sequence.** It always started at
  `ceo_synthesis` and walked one fixed chain, so `fast-track` ran CEO synthesis,
  an owner gate and companion specs that its preset explicitly leaves out, and
  `api-only` / `static-site` went through an owner gate their timeline did not
  show. The kickoff now starts at its sequence's first step and moves to the
  next listed step on every approve. A step the sequence does not list (a
  custom config) falls back to the old chain, so such configs are unchanged.
- **`stepSequence()` returned the execution sequence for a kickoff**, so the
  first version of this step's routing could never reach the interview. Found
  before it shipped; covered now by tests that walk each preset's kickoff.
- **Owner decision:** `api-only` and `static-site` get the interview. Both run
  CEO synthesis and scoping, so their agents make the same assumptions the
  interview exists to catch. `fast-track` stays without an owner step, as its
  preset says.
