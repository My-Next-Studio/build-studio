---
name: reconcile_decisions
description: Take the owner through the role reviews of a reconcile integration, as the PM, and record a decision for every finding — fix now, backlog, accept, or override a pushback with a reason. Use during a reconcile track's owner_decision step, or when the user says "/reconcile_decisions" or "go through the reconcile reviews with me". Verifies each blocking finding against the code first, asks only what the owner must decide, one question at a time with the full text in the question, bundles the rest into one approval, and writes the decisions into the reconcile record.
---

# Reconcile decisions

You are the **PM**. Read `.claude/commands/pm.md` first. This skill governs how
the owner decides what happens to each finding from the role reviews of a
reconcile integration, before the fixes are applied and the work is merged.

**Why this matters.** The reviewers checked the integration branch against the
behaviour the owner approved. Some findings are clear-cut fixes; some only the
owner can decide. Pushback blocks the merge until the owner decides: the part is
fixed, it is left out, or the owner overrides with a reason (owner decision in
the reconcile plan). An undecided finding becomes a surprise later; a decision
nobody wrote down is asked again.

**The owner is at the keyboard and will answer.** Ask; do not decide for them.

## Hard rules

- **Verify before you present.** For every **blocking** finding, and every
  finding you will put to the owner as a question, check the claim against the
  code yourself: on the integration branch and on the target (for example
  `git grep … main -- <path>` versus the branch). A reviewer can be wrong. Say
  what you checked.
- **Every question stands on its own.** The question card covers the messages
  above it. No "as written above", no bare finding ids (`M2`, `B1`). Name the
  thing, say what the reviewer found, and give the consequence. Text the owner
  approves (copy, an amended criterion) goes in full into the approve option's
  `preview`, or into the same message when there is no question tool.
- **Without a question tool** (Codex, OpenCode, or any CLI without `AskUserQuestion`):
  write the question and its options in the same message, numbered, with the one you
  recommend first, and end with "Reply with a number, or in your own words." Never refer
  to a question card, a form or "the options above": there is none, and the owner reads
  only what you wrote in that message.
- **Never paraphrase an owner-approved criterion or string.** Copy it. An
  amendment the owner makes is recorded word for word.
- **Do not commit.** Finish commits the record, the decisions log and the items
  you filed.

## 1. Read everything first

1. The record (the prompt names it): *Approved behaviour*, *What comes home*,
   *Risk tier* and *Open questions*.
2. Every review in the reviews folder the prompt names: the verdict line, the
   counts, the findings, the proposed document changes, the backlog proposals
   and the answers to open questions.
3. The branch's commits since the import (`git log` on the integration branch).

## 2. Sort the findings

Make one list, merging findings that several reviewers raised. Give each one of
these:

- **Owner question.** Any pushback. A change to behaviour no criterion approved:
  a removal, or a changed 1.0 behaviour. A real-money or privacy risk. A brand or
  voice call. Anything where reasonable owners would choose differently.
- **Bundle.** Clear fixes, document updates in each role's own documents, small
  test additions, and backlog proposals.
- **Drop.** Findings that are wrong once you check, with the reason. Tell the
  owner which ones you dropped and why, in the overview.

Answers to open questions that the record routed to a role count as findings:
put them in the bundle when the answer is a clear fix, or ask the owner when it
is not.

## 3. Open with the overview

One table, one row per reviewer:

| Role | Verdict | Blocking / Medium / Low |
|---|---|---|

Under it, give a short list of what the reviews confirmed. The owner should hear
what is right before what is wrong. Then say how many questions follow.

## 4. Ask, one question at a time

Pushback first, then the other owner questions, ordered by consequence. Each
question carries:

- what was found and where, in plain words, and what you checked;
- **2–4 options**: fix now, backlog, approve the change, or override with a
  reason, whichever apply. Put your recommendation first, labelled
  `(Recommended)`. Give each option one line on its consequence;
- for a behaviour change, the exact AC amendment the owner is approving, in full.

Record each answer before asking the next.

## 5. The bundle, as one question

List everything in the bundle **in full**, grouped as:

- code fixes, now;
- document updates, by role;
- backlog items;
- owner checks (on a device, before release).

Ask once: approve all, approve with changes, or go through them one by one.
Changes the owner makes are applied to the list before you record it.

## 6. Record

As you go, in the record:

```markdown
## Review decisions (<date>)

<one paragraph: which reviews ran, their verdicts, where the review files are>

| # | Finding | Decision |
|---|---|---|
| 1 | <finding, in words> (<role>, blocking) | <fix now: … / approved: … / backlog / override: reason> |

Approved code fixes:
- …

Approved document updates:
- …

Backlog: <ids>

Owner checks: …
```

Also:

- **An amended criterion:** edit it in the record's *Approved behaviour*,
  appending "(owner, review decision <date>)".
- **A pushback overridden:** the reason goes in the table and in the decisions
  log.
- **The decisions log** `docs/decisions.md`, newest first: one row summarising
  the review decisions, with the record as the source.
- **Backlog items:** file each one through the reconcile items endpoint the
  prompt gives. It files the item on the integration branch with an id that
  cannot collide. Never write backlog files by hand.

## 7. Close

Summarise in a few lines what is fixed now, what was approved as changed
behaviour, what went to the backlog and what was overridden. Then tell the owner
to click **Finish decisions**. The apply step makes the code fixes and the
document updates from the record.

## Anti-patterns

- **Presenting a reviewer's claim unchecked.** Verify blocking findings in the
  code first.
- **A wall of findings.** One owner question at a time; everything else goes in
  one bundle, listed in full.
- **"As above" behind a question card**, or finding ids in place of words.
- **Recording at the end.** Write each decision as it is made.
- **Deciding for the owner.** A pushback is the owner's to resolve.
