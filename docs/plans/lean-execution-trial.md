# Plan: does the execution workflow still earn its overhead?

> **Status: proposed 2026-10-06; measurement increment 1 started 2026-10-07; lean preset core implemented 2026-10-07 (see *Where this stands*).**
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

A **lean run** — one orchestrating builder that delegates where it pays
(always including a spec-only test writer), one independent review, fix rounds
whose re-reviews read only the fix, and the same gates — delivers stories of
the same quality as the full chain. It should cost substantially less time and
money, most of all where the chain runs six overlapping reviews and re-reviews
everything each round.

## The lean preset

An execution preset, selectable per run, next to the full one. **Claude only**
to start (owner decision 2026-10-06): the builder orchestrates subagents
through Claude Code's Agent tool, which Codex and OpenCode do not share. A
lean run is refused, with the reason, when the builder's step group does not
resolve to Claude; it does not quietly fall back to the full chain.

1. **task_execution** — monolithic, with the goal harness, and the configured
   model as an **orchestrator** that may delegate. Its prompt says:
   - **Plan the work**, then decide what to delegate, "where it sees fit".
     Delegate parts that are independent and sizeable; do small stories
     yourself, because every subagent re-reads the code it needs.
   - **Tests from the spec, by a separate subagent** (required). It is given the
     PRD and never the implementation. This keeps most of the independence
     qa_tests gave, inside the step, and replaces it.
   - **Implementer subagents** at the orchestrator's discretion, on a simpler
     model for routine parts and the stronger one for hard parts. Each is given
     an explicit file or module boundary, and the suite is run only while no
     other subagent is editing. The harness already refuses an edit to a file
     that changed since it was read; what it does not catch is two valid edits
     that disagree, or a test run against someone's half-finished change.
   - **A review subagent** before reporting. A useful first pass, but inside the
     orchestrator's framing, so it is not the independent review.
   - The goal's test requirement as today: unit tests and every non-UI suite in
     full, plus the UI tests the branch adds or changes.
2. **One review step** combining code review and QA validation, on the
   reviewer model the project's step groups configure. The workflow never
   overrides that choice. When the configured reviewer is the same model as the
   builder, the hub shows it, because that is when the independent review is
   weakest.
3. **Fix rounds** (see below).
4. **merge_to_main** and **capture_learnings**, unchanged, with all their gates.

Dropped: qa_tests, planning (lean runs are monolithic), coverage matrix, AC
verification, security audit and final review as separate steps. Their checks
are named in the review step's prompt instead, so each concern is still
covered once, not six times.

### Fix rounds

- **Strictness is a setting: loose, normal or strict.** Loose runs fix rounds
  for blocking findings only, normal for blocking and medium, strict for low
  findings too. A per-project default set in the hub, overridable at Start for
  one run. Correction (2026-10-07): today's auto-advance in an execution run
  starts a fix round only for blocking findings or failing tests, and approves
  past mediums. So today's behaviour is loose, not normal. Medium fix rounds
  happen only when the owner sends them back by hand. The trial's "same
  strictness in both arms" holds either way, as long as both arms use the
  same setting.
- **No fixed number of rounds.** If two rounds do not clear the bugs, that is
  worth finding out. The existing round cap and its manual override (continue,
  or accept the open findings) stay as the backstop.
- **A re-review reads only what the fix changed** — the fix round's diff — and
  confirms that each finding it was meant to address is resolved. This is also
  what lets strict converge: a fresh full review almost always finds another
  low, so with full-scope re-reviews strict would reach the cap nearly every
  run. Scoped to the fix, new findings can only come from the fix itself.
- **The full test suite still runs** on every fix round, in the gates. A fix can
  break something outside its own diff; the scoped review would not see that,
  the suite does.
- **A fix round works like the implementation:** the configured model
  orchestrates, with the same guidance on tests, review and subagents. It is
  given the findings and the PRD, not just the findings. A two-line fix should
  not delegate, and the "where it sees fit" rule says so.

### Seeing what the orchestrator does (Claude only)

The main transcript records every subagent launch: description, type, model,
start, and result. The hub shows that as a timeline under the step — which
subagents ran, on which model, how long, done or failed — so a lean run is not
a single opaque pane.

### Prerequisites the orchestrator brings

- **The watchdog** must recognise an orchestrator waiting on running subagents,
  as it now does for background shells and goal mode, or a waiting lean run
  reads as stalled.
- **Subagent cost from the start** (owner decision 2026-10-06). Subagent
  transcripts are stored apart from the main session's. If the scorecard reads
  only the main one, lean runs look cheaper than they are, and the trial's cost
  verdict is wrong. So subagent tokens are counted from the first lean run.

The bugfix workflow is already close to this shape, so much of the preset is
step configuration and prompts; the orchestration guidance, the strictness
setting, diff-scoped re-review and the timeline are new.

## The comparison

- **Assignment.** Alternate lean and full on comparable stories, as each one is
  started. The owner may override for a story that clearly needs the full chain
  (a security-sensitive surface, a data migration), and the override is
  recorded so it can be excluded or analysed on its own.
- **Size.** About ten stories per arm per project before reading the result.
  Fewer is anecdote.
- **Same strictness in both arms: normal.** A lean run on loose against a full
  run on normal would measure the strictness as much as the preset.
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

1. **Record findings on every review round. Done 2026-10-07.** The cause was
   not the parser. A re-run step replaces its agents, and the scorecard was
   written at completion from the agents the run still held, so only each
   step's last, clean round was ever recorded. Its earlier rounds' findings,
   tokens and time were lost. Replaced agents are now kept in the workflow's
   agent history, and every round is written. Rows written before this keep the
   gap; the trial starts after it.
2. **Link a bug to the story it came from.** Add a `found_in: <story id>` field
   to Bug items. Fill it when it is known: support triage, review findings
   filed after merge, and Create story / "Add issue" when the owner names the
   story. A bug with no link counts as unattributed and is reported as such,
   not silently dropped.
3. **Tag each run with its preset**, so every scorecard row can be split by
   arm. Done 2026-10-07: every execution row carries `preset` (`full` or
   `lean`).
4. **Count subagent tokens** in the lean arm (above). Done 2026-10-07, for
   every Claude agent, not only the lean arm. A subagent's transcript is
   stored beside its parent session's, and was never read. Its tokens are now
   added to the agent's usage and priced at the subagent's own model, with the
   breakdown kept. The full chain delegates too (a code review with parallel
   subagents), so counting only the lean arm would have biased the comparison.
   First measurement: one test-sweep subagent of a QA-tests agent used 19.9M
   cache-read tokens that the scorecard had never seen.

## Increments

1. Measurement (above). Useful on its own even if the trial never runs.
2. The fix-round strictness setting and diff-scoped re-review. Useful to the
   full chain too, and independent of the preset.
3. The lean preset, Claude only, behind a per-run choice, with the subagent
   timeline, the watchdog's subagent awareness and subagent cost. The full
   chain stays the default.
4. The trial, until the size above is reached.
5. A written result in this file, and a decision: keep both, make lean the
   default, or retire it. The result includes the failures.

## Out of scope

- The review workflow (PRD review), kickoff and onboarding. Not in question.
- Removing the gates or bookkeeping (item 3 above) in any variant.
- Choosing between builder models. The trial holds the builder model constant
  within a project, or the comparison confounds the two.

## Decisions taken (2026-10-06)

1. **Spec-first tests:** kept, as a required test-writer subagent that sees the
   PRD and not the implementation.
2. **Reviewer model:** whatever the step groups configure; never overridden;
   same-model review shown in the hub.
3. **Fix rounds:** loose / normal / strict, no fixed round count, the existing
   cap and override kept, re-review scoped to the fix, the full suite always.
4. **Claude only** to start, with a subagent timeline in the hub.
5. **Subagent cost** measured from the first lean run.

## Open decisions

1. **Assignment.** Strict alternation (proposed) or owner choice per story.
   Owner choice is more convenient but biases the arms.
2. **Where strictness is set** in the hub: the Start dialog, the project's
   settings, or both (proposed: a project default plus a per-run override).

## Verification

- A lean run and a full run of the same small story, side by side, before the
  trial starts: both reach merge, both update the backlog and the scorecard,
  and the preset is visible on every row.
- The severity fix checked against a run with known findings.
- `found_in` checked end to end: a bug filed from support triage against a
  merged story shows up under that story in the trial's report.

## Where this stands (2026-10-07)

### Built

- **The lean preset, behind a per-run choice.** The Start form on the
  Workflow tab has a Chain picker: Full (the default, unchanged) or Lean
  (trial). A lean run is refused at start, with the step and CLI named, when
  `task_execution` or `fix_execution` would not run on Claude. The backlog's
  Execute button still starts the full chain, until assignment is decided
  (open decision 1).
- **Sequence:** planning (synthesised, no planner agent), task_execution,
  merge_for_review (the existing merge gates), qa_validation, merge_to_main,
  capture_learnings. Lean is monolithic whatever `step_strategies` says.
- **The builder's prompt** adds the orchestration section: plan, a required
  spec-only test-writer subagent, optional implementers with file boundaries,
  no suite runs while a subagent edits, a review subagent before reporting, and
  a `### Subagents` line per subagent in the feedback.
- **The one review is hosted on qa_validation**, not code_review. That step
  carries every QA gate (the server-run native suite, the test-count gates,
  strict mode), and moving them was riskier than giving its agent a second
  job. In a lean run its header changes to "tests and code review in one step",
  and a Part 2 after the test run covers what the dropped steps checked: ACs,
  variants, silent failure, test quality, security, hygiene, and design
  conformance when the PRD has an approved design. The timeline names the step
  "Review (tests + code)".
- **Fix rounds skip the fix planner.** The review's findings go to the
  builder's role as one task, with the PRD, and the builder orchestrates the
  fix under the same rules. The round's starting commit is recorded, and the
  re-review reads only `git diff <that commit>..HEAD` while the suite still
  runs in full. A finished fix round returns to the review that raised it.
- **Measurement:** every execution scorecard row carries `preset`; subagent
  tokens are counted for every Claude agent (measurement item 4).
- **Prices for the current Claude models**, from the published rates, so a
  subagent on one of them is costed rather than null.

### Not yet

- The strictness setting (increment 2). Both arms currently use today's
  routing, which is loose (see the correction under *Fix rounds*).
  Diff-scoped re-review exists in the lean arm only.
- The subagent timeline in the hub. The data it needs is recorded: each
  agent's usage now lists its subagents with type, task description, model,
  start, end and tokens.
- The watchdog's awareness of an orchestrator waiting on background subagents.
- The same-model notice when the reviewer resolves to the builder's model.
- `found_in` on Bug items (measurement item 2).
