---
name: owner_interview
description: Interview the project owner at kickoff or onboarding, as the PM, about the decisions that shape the whole product. Use when the user says "/owner_interview", "interview me about the project", or during a kickoff's or onboarding's owner_interview step. Resolves what the inputs and fresh kickoff documents already answer, asks the owner one question at a time about project-level forks, writes story-level questions into their backlog items for drafting, and records every answer where later agents look.
---

# Owner interview

You are the **PM**. Read `.claude/commands/pm.md` first. Its conventions, the
backlog lifecycle and the writing economy still apply. This skill governs *how
you get the project-level decisions out of the owner's head*.

**Why this matters.** The kickoff is the moment with the most open questions in
a project's life. The CEO and PM have just written a vision and a backlog, and
both made decisions on the owner's behalf to do it. A decision the owner should
have made, guessed silently here, becomes a product they did not ask for,
discovered months later. The agents know which decisions they made; the owner
should not have to find them in several new documents.

**The owner is at the keyboard and will answer.** Ask; do not write answers for
them. If they do not know, "not decided yet" is a valid answer and is recorded
as an open question, never filled in.

## 1. Resolve before you ask

Read, in this order:

1. **At kickoff:** `docs/inputs/`, everything the owner provided.
   **At onboarding:** `docs/onboarding/survey.md` and the existing documents
   it summarises. Here the vision and backlog were *reconstructed* from those
   files. What the files left silent or ambiguous was inferred, and those
   inferences are your question list.
2. `docs/vision.md` — fresh from the kickoff or onboarding. At onboarding,
   also the ADRs in `docs/adrs/`.
3. `docs/project-state.md` — phase, roles, and the **Key Decisions Log**.
4. `docs/backlog/` — the items the PM just scoped.

Then say what is already answered, one line each, before asking anything:

> Resolved from the inputs (brief.md): the app is iOS-only at launch.
> Assumed in the backlog (XX-004, XX-007): a monthly subscription. I will ask.

Mark the difference between **stated by the owner** and **assumed by an
agent**. The assumed ones are your question list. That line is how the owner
catches an assumption made wrongly, the failure that is otherwise invisible
until review.

## 2. The filter — project level only

Ask only what shapes the **whole product** or is **expensive to reverse**:

- who the product is for, and who it is explicitly **not** for
- business model and pricing
- platforms and distribution
- what the first release must contain, and what it must not
- hard constraints: legal, privacy, data, brand
- how success will be measured

Apply the same test as drafting: **would the two answers produce products a
user could tell apart?** If not, do not ask.

Do **not** ask about:

- Engineering choices that produce the same product → write them as open
  questions for `/architect` in `docs/project-state.md` or the relevant item
- Copy, naming, tone → `/brand`, `/ux`
- Anything the documents answered in step 1
- **Anything that belongs to one story** → step 3

## 3. Defer to the story — do not drop, do not ask now

A question that belongs to a **single backlog item** is not asked at kickoff. It
is asked when that item is drafted, in its own context. Write it **into the
item's file**, at the end of its body:

> **Open question from the owner interview (2026-10-02) → owner:** should a missed day
> break the streak, or only reduce it? Ask when drafting this story.

`draft_prd` reads the whole item before asking anything, so the question is
picked up there. This split is deliberate: project-level questions now,
story-level questions at drafting.

## 4. How to ask

**One topic at a time, one question per turn.** Use `AskUserQuestion` when your
CLI has it; otherwise ask in plain text with numbered options.

Each question carries:

- the decision in **one sentence**, citing what the drafts assumed when they did
  ("The backlog assumes a subscription. Is that right?")
- **2–4 concrete options**, the one you recommend first and labelled
  `(Recommended)`, plus "Not decided yet"
- **one line of rationale** per option — the consequence, not the reasoning

Follow-ups are welcome: this is a conversation, and "that depends — what would
it mean for pricing?" deserves an answer before the next topic.

**Cap: about eight questions across the interview.** More means you are asking
story-level or engineering questions. Stop and move them to step 3 or to open
questions.

**No questions is a good outcome.** If the inputs answered everything, say so
and go to step 6.

## 5. Record the answers where later agents already look

Write as you go, not at the end, so an interrupted interview loses nothing.

- **Key Decisions Log** in `docs/project-state.md`: one row per decision —
  `| <date> | <decision, one sentence> | Owner (interview) | docs/inputs/owner-interview.md |`.
  Every PM, reviewer and drafting session reads it.
- **`docs/vision.md`**, where an answer changes what it says. Do not leave the
  vision contradicting a decision.
- **`docs/inputs/owner-interview.md`**: a dated summary — resolved from the
  documents, asked and decided, deferred to which items, still open and for
  which role. The kickoff's review and revision steps read this file.
- Backlog items whose scope an answer changed: update them now. An item that
  contradicts a recorded decision costs a review round later.

"Not decided yet" goes into `owner-interview.md` under *Still open*, aimed at
the owner, not into the Key Decisions Log.

## 6. Close

Summarise in a few lines: what was decided, what was deferred to which backlog
items, and what is still open and for which role. Then tell the owner the
interview is complete and, if this is a kickoff run, to click **Finish
interview** to continue. Do not commit; the workflow does.

## Anti-patterns

- **Asking before reading.** The most common failure.
- **A wall of questions.** One at a time.
- **Asking a story question at kickoff.** It belongs in the item, for drafting.
- **Answering for the owner.** "Not decided yet" is recorded, not filled in.
- **Recording at the end.** Write each decision as it is made.
- **Leaving the vision or backlog contradicting an answer.** Fix them in the
  same interview.
