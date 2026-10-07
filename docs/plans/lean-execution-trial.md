# Plan: does the execution workflow still earn its overhead?

> **Status: proposed 2026-10-06.**
>
> Owner request: models have improved a lot since the execution workflow was
> designed. Question whether its steps still add enough to justify their time
> and cost, compared with letting one strong agent implement the story. The
> review workflow and the backlog are not in question; the execution workflow
> is.

## The question

An execution run today is a chain of agents. QA writes tests from the spec
first. A builder implements. Then several review-type steps check the result,
and fix rounds repeat until the reviewers stop finding blocking or medium
issues, or the round cap is hit. Each step was added to catch something an
earlier, weaker model got wrong.

If a current model gets most of that right on its own, the chain is mostly
overhead. If it does not, the chain is what stands between a story and a
regression. Neither is obvious, and the current data cannot settle it (below).
This plan is a way to find out, not a decision.

## What the data says (30 days to 2026-10-06, two managed projects)

| | Project A (56 runs) | Project B (33 runs) |
|---|---|---|
| Implementation step | 64 h | 18 h |
| Every other step | ~31 h | ~34 h |
| Runs with at least one fix round | 32 (57%) | 30 (91%) |
| Runs that reached the round cap | 1 | 14 |
| Findings recorded | 14 blocking, 35 medium | 6 blocking, 126 medium |

- In A the rest of the chain costs about half the implementation time; in B,
  about twice. B runs six review-type steps (coverage matrix, AC verification,
  security audit, final review, code review, QA validation). They overlap, and
  14 of its 33 runs went the full six rounds.
- Independent review does catch real defects. Examples from one week:
  - a test fixture that would have broken CI once real data existed;
  - a CI failure the change itself introduced;
  - a focus ring outside the brand palette, caught by pixel check;
  - an E2E teardown failure.
- **The data measures cost well and benefit badly.** Two gaps:
  - Project A recorded no findings for 27 of its 32 fix runs, so its totals
    undercount.
  - Nothing records **escaped defects** — bugs found after a story shipped. So
    there is no way to see what a run without the chain would have let
    through, which is the number the question turns on.

## What the workflow provides, separated

Four different things are bundled together. They do not stand or fall together:

1. **Independent review.** A different agent, with a fresh context and ideally
   another model, checks the work. The builder reviewing itself shares its own
   blind spots. Better models narrow this, but they do not remove it, because the
   issue is the author checking their own assumptions.
2. **Spec-first tests** (qa_tests). Tests are written from the PRD before the
   code exists, so they cannot be shaped to fit it. This is valuable but
   expensive: the single largest non-build step in project A.
3. **Deterministic gates and bookkeeping.** The paid-API test gate, clean-tree
   and branch discipline, the merge, backlog status moving forward, learnings
   captured, the scorecard. These are nearly free and keep the backlog
   trustworthy. A bare agent session does them inconsistently.
4. **Unattended operation.** The watchdog, nudges and auto-advance let a run
   finish without the owner present.

Items 3 and 4 stay in any variant. The question is really about 1 and 2: how
much review, and whether tests are written first.

## Hypothesis

A **lean run** — one strong builder, one independent review, fix rounds only
for blocking findings, and the same gates — delivers stories of the same
quality as the full chain. It should cost substantially less time and money,
most of all where the chain chases medium and low findings to the cap.

## The lean preset

An execution preset, selectable per run, next to the full one:

1. **task_execution**, monolithic, with the goal harness on. The builder runs
   unit tests and every non-UI suite in full, plus the UI tests its branch adds
   or changes (as the goal does since 2026-10-06).
2. **One review step** that combines code review and QA validation. It runs on
   the other CLI or model family from the builder where the project has both
   (cross-model review already exists as a step-group setting).
3. **Fix rounds on blocking findings only.** Medium and low findings are
   reported, and the owner can file them with the existing file-findings
   action; they do not send the run back. Round cap 2.
4. **merge_to_main** and **capture_learnings**, unchanged, with all their gates.

Dropped: qa_tests, planning (lean runs are monolithic), coverage matrix, AC
verification, security audit and final review as separate steps. Their checks
are named in the single review step's prompt instead, so each concern is still
covered once, not six times.

The bugfix workflow is already close to this shape, so most of the preset is
step configuration and prompt changes, not new engine code.

## The comparison

- **Assignment.** Alternate lean and full on comparable stories, as each one is
  started. The owner may override for a story that clearly needs the full chain
  (a security-sensitive surface, a data migration), and the override is
  recorded so it can be excluded or analysed on its own.
- **Size.** About ten stories per arm per project before reading the result.
  Fewer is anecdote.
- **Measured per story:**
  - wall time and cost per step (already in the scorecard);
  - findings at review, by severity (needs the fix below);
  - **escaped defects** — bugs filed later against the story, within 30 days
    of merge (needs the link below);
  - owner interventions — Approve overrides, manual fixes, re-runs.
- **Read together, not one number.** Lean "wins" if escaped defects are not
  worse and time and cost are clearly lower. If escaped defects rise, the
  breakdown says which dropped step was carrying weight, and that step comes
  back.

## Measurement it needs first

1. **Record findings on every review row.** The scorecard's `severity` was
   missing for most fix runs in one project. Find out why (parser, step type,
   feedback format) and fix it, or the comparison measures nothing.
2. **Link a bug to the story it came from.** Add a `found_in: <story id>` field
   to Bug items. Fill it when it is known: support triage, review findings
   filed after merge, and Create story / "Add issue" when the owner names the
   story. A bug with no link counts as unattributed and is reported as such,
   not silently dropped.
3. **Tag each run with its preset**, so every scorecard row can be split by
   arm.

## Increments

1. Measurement (above). Useful on its own even if the trial never runs.
2. The lean preset, behind a per-run choice. The full chain stays the default.
3. The trial, until the size above is reached.
4. A written result in this file, and a decision: keep both, make lean the
   default, or retire it. The result includes the failures.

## Out of scope

- The review workflow (PRD review), kickoff and onboarding. Not in question.
- Removing the gates or bookkeeping (item 3 above) in any variant.
- Choosing between builder models. The trial holds the builder model constant
  within a project, or the comparison confounds the two.

## Open decisions

1. **Keep spec-first tests in lean?** Dropping qa_tests is the biggest saving
   and the biggest risk. A middle option: the builder writes tests first, in the
   same session, before implementing. That is cheaper, but it is not independent.
2. **Reviewer model.** Cross-model where available, or the same model in a fresh
   session, for projects that have only one CLI configured.
3. **Medium findings.** Report-only (proposed), or one fix round for mediums
   before the cap.
4. **Assignment.** Strict alternation (proposed) or owner choice per story.
   Owner choice is more convenient but biases the arms.

## Verification

- A lean run and a full run of the same small story, side by side, before the
  trial starts: both reach merge, both update the backlog and the scorecard,
  and the preset is visible on every row.
- The severity fix checked against a run with known findings.
- `found_in` checked end to end: a bug filed from support triage against a
  merged story shows up under that story in the trial's report.
