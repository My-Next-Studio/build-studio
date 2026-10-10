# Plan: do injected learnings make runs better?

> **Status: proposed 2026-10-08. Starts once the lean execution default has more mileage (see *When to start*).**
>
> Owner request: decide whether the learnings feature is worth keeping. A
> learning that stops a bug from recurring is one kind of value, but not the
> only one: it can also shape a design, sharpen a review or save a
> rediscovery. So the test should be whether runs that get learnings turn out
> better, not only whether specific bugs repeat.

## What the feature does

Every agent's prompt gets up to six learnings from the project's
`docs/learnings/`, the shared `~/.build-studio/learnings/`, and the built-in
set. They are filtered to the role's domains and the project's stack, and
ranked by keyword relevance to the task. The capture_learnings step at the end
of a run writes new ones. Agents report in their feedback which learnings they
applied. An entry injected 30 times without being applied is archived, and one
applied three or more times is proposed for promotion into AGENTS.md or
ARCHITECTURE.md.

## What the data says (2026-10-08)

- **Self-reported use.** Across the installation, 118,412 injections and 5,276
  reported applications (4.5%). The lifetime figure includes an early period
  when prompts carried about 25 mostly irrelevant entries. In the three active
  projects the rate is 12% to 24%.
- **What gets applied.** General engineering rules, not framework tips. The
  top entries, about gates that pass green while enforcing nothing, derived
  values that must share one source, and fixtures that don't mirror
  production, were applied 531, 294 and 277 times.
- **Curation works.** One project has 130 live entries and 246 archived.
- **Cost.** Over 30 days the capture step was about 2% to 3% of execution and
  bugfix run cost, and 1% to 3% of agent time, in each active project. Injection adds six short
  bullets per prompt. Upkeep is the larger cost: about 80 learnings commits a
  month in each of the two busiest projects, and the link rewriting that
  archiving needs.

## Why the data cannot answer it

"Applied" is the agent's own claim. An agent handed a list of pitfalls tends to
say it used one, and nothing checks that the run went better for it. The old
recurrence counter was retired in 2026-08 because its keyword matching was
mostly coincidence, and nothing measures recurrence now. So the data shows the
feature is cheap and used, not that it helps.

## The comparison

- **Two arms per run: learnings on, learnings off.** Off means no Known
  Learnings block in any prompt of that run. Capture still runs in both arms,
  so the library stays the same for both, and so do the archive and promotion
  rules, which only count runs that received learnings.
- **Assignment.** Alternate on and off per execution run, within each project.
  The owner can override a run, and the override is recorded so it can be
  excluded or read on its own.
- **Size.** About twenty runs per arm per project, in the projects busy enough
  to reach it in a few weeks. Fewer is anecdote.
- **Measured per run**, from the scorecard unless noted:
  - findings at review, by severity, per round;
  - fix rounds per run, and runs that hit the round cap;
  - owner interventions: approve overrides, manual fixes, re-runs;
  - cost and wall time, so a better arm that is also slower is visible;
  - escaped defects (bugs filed later against the story), once Bug items carry
    the `found_in` link the lean plan proposes. Until then, reported as
    unavailable rather than left out.
- **Read together, not one number.** Learnings earn their place if the on arm
  has fewer findings or fix rounds, or fewer interventions, at similar cost. If
  the arms are indistinguishable, injection and capture go, and what has been
  promoted into AGENTS.md and ARCHITECTURE.md stays.

## When to start

The lean default changed execution on 2026-10-08, and its prompts and gates
will be adjusted as quality problems turn up. A learnings comparison running
alongside would mix the two effects. Start when both hold:

- lean has been the default for at least three weeks, with about twenty lean
  runs in each project that will take part;
- no change to the lean prompts or gates has landed in the previous week.

During the comparison, a lean change that has to land is noted with its date,
so the runs before and after it can be read separately.

## What it needs built

1. **A per-run learnings arm.** `learnings.enabled` exists today, but per
   project, not per run. The run needs its own flag, set at start by the
   alternation and shown in the Workflow tab, and the launcher must honour it
   for every agent in the run, fix rounds included.
2. **The arm on every scorecard row**, the same way `preset` is recorded, so
   rows can be split by arm.
3. **A small report**: per project and arm, the measures above, with the run
   count beside every figure.

## Out of scope

- Changing how learnings are captured, ranked or archived during the
  comparison. A change there would move the on arm mid-trial.
- Bugfix, review and kickoff runs. They stay on their current setting, so the
  comparison covers execution only.

## Open decisions

1. **Strict alternation or owner choice per run.** Alternation is proposed;
   owner choice is more convenient but biases the arms.
2. **Which projects take part.** Proposed: every project that reaches the run
   count in a few weeks; the rest stay on.
