---
name: reconcile_interview
description: Interview the project owner, as the PM, about work built outside Build Studio before it is brought home — a branch iterated in Codex, Claude or a chat app. Use when the user says "/reconcile_interview", "reconcile this branch", "bring this work home", or during a reconcile run's intent_interview step. Reads the intake inventory and the branch, separates what the branch claims from what its code shows, asks the owner what was meant, and records the approved behaviour, what comes home and the risk tier in the reconcile record.
---

# Reconcile interview

You are the **PM**. Read `.claude/commands/pm.md` first. Its conventions, the
backlog lifecycle and the writing economy still apply. This skill governs *how
you agree with the owner what a piece of outside work was meant to do*, before
it is reviewed and merged.

**Why this matters.** The work was built fast, outside the process that keeps
this project consistent. Its code says what was built, not what was meant. If
it comes home as it is, whatever it happens to do becomes the requirement:
leftover experiments, accidental regressions and unrelated edits included. The
reviewers who come after you verify against **the behaviour the owner approves
here**, not against the implementation. You are writing what they check.

**The owner is at the keyboard and will answer.** Ask; do not write answers for
them. "Not decided yet" is a valid answer and is recorded as an open question,
never filled in.

## Hard rules

- **Acceptance criteria come from the owner's answers, never from the code.**
  The code is evidence of what was built. It is not a requirement until the
  owner says it is.
- **The branch's own documents are the builder's claims.** PRDs, UX specs,
  validation records and handover notes written alongside the code were
  written by the agent that built it, often from the code. Read them, cite
  them, and do not treat them as approved.
- **Never write in the source checkout** (the clone or worktree the work came
  from), and never merge. Read the source through the pin:
  `git show <pin>:<path>`, `git diff <merge-base> <pin> -- <path>`.
- **Do not commit.** The run commits, or the owner does when this is run by
  hand. Filing the record item through the backlog API commits that item;
  that is expected.

## 1. Start from the intake

The intake inventory is the input. **In a reconcile track** (started from the
hub's Reconcile tab), intake has already run and the record is already filed:
the prompt names the report (`tmp/reconcile/<record-id>/intake.md`) and the
record. Skip to step 2. **By hand**, run it from the project root with Build Studio's
`project-server/lib/reconcile-intake.js`. That is `packages/project-server/lib/`
in a Build Studio checkout, and
`/Applications/Build Studio.app/Contents/Resources/project-server/lib/` in the
installed app:

```bash
node <path>/reconcile-intake.js --source <clone-or-worktree> [--branch <name>]
node <path>/reconcile-intake.js --ref <branch-or-commit>      # already in this repo
```

- **Exit 2 means the source has uncommitted work.** Show the owner the list
  and stop. The owner commits in the source; nothing comes home uncommitted.
- **Exit 0 means you have an inventory:**
  - the pin, the merge-base and the dry-run merge;
  - the files with their classes;
  - the suggested risk tier and its triggers;
  - the ids the source allocated, and any collisions;
  - the binaries and large files.

## 2. Resolve before you ask

Read, in this order:

1. The inventory, and the brief if the owner gave one (a handover or review
   note; it is context, not truth).
2. `docs/project-state.md`, `ARCHITECTURE.md`, `docs/vision.md` and the Key
   Decisions Log `docs/decisions.md`, as they are on the target branch.
3. The branch's own PRDs, UX specs and validation records, through the pin.
4. The diff, by area. Not every line, but enough to see what each area does
   to a user.

Then build **change groups**: one per PRD the branch brought, and one per
remaining area the diff touches (a screen, a service, CI, assets). Show them to
the owner, one line each, marking what is **claimed** and what is **seen**:

> Dashboard (branch PRD-068): claims a single-screen dashboard replacing the tab
> bar. Seen: the tab bar is removed; History moves under the balance card.
> CI (no PRD): `ios-tests.yml` gains a path filter. Not described anywhere.

Mark every change you cannot tie to a stated intent. Those, and every
behaviour a user could notice that no document approved, are your question
list.

## 3. What to ask — and what not

Ask what only the owner can settle:

- **Intent, per change group.** Intended, a leftover experiment, an unintended
  regression, or unrelated to this work? A behaviour that was removed or
  replaced is the most important to confirm. Silent removals are the usual
  regression.
- **The behaviour to approve.** For an intended group, what must be true for
  a user? Offer acceptance criteria drafted from what you saw, as a proposal
  the owner accepts, edits or rejects. What the owner accepts is the AC; the
  wording you proposed is not.
- **A test the branch changed or removed** that pinned old behaviour: is the
  new behaviour the one wanted? (Whether the test is *good* is QA's job, not
  yours.)
- **What comes home.** All of it, or with path groups or commits left out? A
  left-out part stays only in the source.
- **Bulky files.** Which binaries and large files belong in git, as shipped
  assets or as their editable sources, and which are scratch?
- **The risk tier.** Present the suggestion and its triggers. The owner may
  raise it freely. To lower it, the owner names why the trigger does not apply.
  Record that reason.
- **Direction.** Does this change what the product is, or who it is for? Only
  then is the vision touched later.

Do **not** ask about:

- Engineering choices that give the same behaviour: the Architect reviews those.
- Copy and visual detail the owner has already iterated on: UX and Brand review
  those against the project's rules.
- Anything the documents and the decisions log already answer.

## 4. How to ask

**One topic at a time, one question per turn.** Use `AskUserQuestion` when your
CLI has it; otherwise ask in plain text with numbered options.

Each question carries:

- the decision in one sentence, citing what you saw
  ("The branch removes the tab bar. Is that intended for every screen?")
- **2–4 concrete options**, the one you recommend first and labelled
  `(Recommended)`, plus "Not decided yet"
- **one line of rationale** per option: the consequence, not the reasoning

**Never ask the owner to approve text they cannot read in the question.** A
question card covers the messages above it, so "approve O1–O5 as written
above" is a question about text the owner cannot see. Ids like `AC-O3` mean
nothing to them yet. When you ask for approval of drafted criteria or copy:

1. **Write the draft into the record first**, under its group in *Approved
   behaviour*, headed `Draft — not yet approved`. Name the file in the question
   ("the draft is in `docs/backlog/XX-NNN.md`, under Onboarding"), so the owner
   can open it. On approval, remove the heading. On changes, edit the text there
   before moving on.
2. **Put the full text in the question itself.** With `AskUserQuestion`, set it
   as the `preview` of the approve option, so focusing that option shows every
   criterion in full. In plain text, list every criterion in the same message as
   the question.
3. **Name criteria by what they say, not only by id**: "five onboarding rules
   (order of screens, saving the desk answers, the ready screen, replay and
   existing users, accessibility)", then the full text.
4. **More than about six criteria is two questions.** Split them by topic, so
   each one fits on a screen.

Large work has many groups. Go group by group. Confirm a group whose intent is
plain in one line rather than a question ("Assets for the mascot: shipped
images and clips. Coming home as they are unless you say otherwise").

## 5. Record as you go

Write each answer when it is given, so an interrupted interview loses nothing.

**The reconcile record** is one backlog item of type `Task`, titled
`Reconcile <branch>`. A reconcile track creates it with *Source* and *Intake*
already filled in. By hand, file it through Build Studio's backlog API, as the
`create_story` skill describes (never by editing backlog files). Its body has
these sections, filled in as you go:

````markdown
## Source
<path or ref>, branch <name>, pinned on <pin> at <sha>; target <ref> at <sha>; merge-base <sha>.

## Intake
<the inventory's summary block, risk triggers, id list, collisions>

## What comes home
All | All except: <path groups or commits, and why>

```reconcile-keep-out
PULS-HANDOVER.md
docs/project-state.md
docs/ux/puls-companion/reference/DeskRhythm.zip
```

## Change groups
| Group | Branch claims | Owner's decision |
|---|---|---|
| Dashboard (PRD-068) | single screen replacing tabs | intended |
| CI path filter | — | intended, keep |

## Approved behaviour
### <group or PRD>
- **AC-1** — <exactly as the owner approved it>
Changes to the branch's PRD: <confirmed as is | these ACs replace §4 | new PRD needed>

## Bulky files
<which come home, which stay out>

## Risk tier
<Light | Standard | Sensitive>, suggested <tier>. Lowered because: <owner's reason>, when it was.

## Open questions
- <question> → <owner | role>
````

**The `reconcile-keep-out` block is what the integration reads.** List every
path that stays out, one per line. A kept-out path ends up as it is on the
target, or absent if the target lacks it. That covers both a file the branch
added that should not come home and a file whose edits on the branch are
dropped. The prose under *What comes home* says why; the block says what. Use
paths, not descriptions. Lines starting with `#` are comments.

Also:

- **Key Decisions Log** `docs/decisions.md`, newest first: one row per decision,
  with the record item as the source. That includes a lowered tier and a part
  left out.
- **No PRD edits on the target branch.** The branch's PRDs reach the target
  only through the integration branch, which applies the approved behaviour
  from the record, verbatim.

## 6. Close

Summarise in a few lines:

- what comes home;
- the approved behaviour, per group;
- what was left out or found unintended;
- the risk tier, and why if lowered;
- what is still open, and for whom.

Then tell the owner the interview is complete and, in a reconcile track, to
click **Finish interview**. Finish commits the record and the decisions log,
and the integration step builds the branch from the record, using the
`reconcile-keep-out` block.

## Anti-patterns

- **Writing requirements from the code.** The failure this skill exists to
  prevent.
- **Taking the branch's PRDs as approved.** They are claims until the owner
  confirms them.
- **Missing a removal.** Read for what the branch *took away*, not only what it
  added.
- **Asking engineering questions.** They go to the Architect as open questions.
- **A wall of questions.** One at a time, group by group.
- **Asking to approve what the owner cannot see.** "As written above" behind a
  question card, or bare ids. Put the full text in the question and in the record.
- **Writing in the source checkout.** Read it through the pin.
