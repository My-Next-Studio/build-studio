# Plan: evaluate and adapt agent configuration per project

> **Status: Tier 2 largely implemented 2026-09-13; Tiers 1 and 3 and the
> adaptation loop still proposed** (proposed 2026-09-01). See *Status by tier*
> below for what each turned out to mean, and for two places the build diverged
> from this plan.
>
> Owner request: a role behaves differently in different projects, and today
> nothing adapts it beyond a hand-written command file, nor measures whether
> that file is any good. Some adaptation could happen at kickoff; more could
> come from evaluating each project's agents against how they actually perform.

## Status by tier

**Tier 2 — built, and in daily use.** Each project appends one record per agent
to its own `.build-studio/scorecard.jsonl` when a run completes
(`lib/agent-scorecard.js`), the hub aggregates across projects
(`/api/scorecard`), and a Home tab groups the result by role so the same
role-and-step pair from different projects sits on adjacent rows
(`components/scorecard-tab.tsx`). Roles present in only one project are listed
separately, since there is nothing to compare them against.

A run now commits its own scorecard row, because the file is tracked and every
completed run otherwise left the working tree dirty with output it generated
itself — a manual commit between every pair of runs.

**Open decision 1 resolved in the build, both ways.** The log is per-project and
committed; the comparison is hub-side. The plan framed these as alternatives.
They are not: the per-project JSONL is the durable record a role-tuner agent can
read without new plumbing, and the hub reads all of them to do the only thing
Tier 2 exists for.

### Two divergences worth naming

**1. The convergence metric was not built.** This plan's central quantity is
*fix rounds to converge* — "2.5 in one project and 1.1 in another". What shipped
is a `max round` column: `max(round)`, the highest round the role appeared in.
That is a property of the RUN, not of the role, so it reads 4–6 on nearly every
row and discriminates nothing. The column looks like the metric this plan asked
for and is not it. Replacing it is the single highest-value piece of Tier 2 left.

**2. Cost columns landed early, and the blind spot this plan predicted arrived
with them.** The plan said fix-rounds, findings and gate trips should carry the
first version and cost should wait for token accounting. Cost shipped anyway.
The predicted consequence followed: rows are marked `(N gaps)` when agents were
unpriced or unmeasured, and a row can read six times cheaper than its neighbour
purely because two of its three agents were never priced.

Two causes were found and fixed — a pricing table that did not recognise the
bare model aliases the launcher actually stores (so any default-configured agent
priced null), and an unpriced agent crashing the whole project page on render.
A `model` column now makes a gapped row self-explanatory. Rows recorded before
the fix stay unpriced; they are historical records, not recomputed.

**The CLI-coverage blind spot this plan described is closed** (verified
2026-09-14). All three CLIs now record usage: Claude from its session
transcripts, codex via `lib/codex-telemetry.js`, and OpenCode via
`lib/opencode-telemetry.js`. The OpenCode path was checked end-to-end against a
live run — the event format is unchanged on 1.18.4, tokens and session id parse
correctly, and `opencode export` still resolves the model actually served behind
a routing alias.

OpenCode agents are in fact the best-measured of the three: their cost is the
provider's real charge, carried straight through, so it does not depend on the
rate table at all. Nothing in this installation currently runs on OpenCode, so
that path is exercised by tests rather than by use.

What remains is narrower than a CLI gap: an agent that errored before reporting,
or that ran before the fixes above, still counts as unmeasured. Read cost beside
the gap marker for that reason — not because a whole CLI is invisible.

**Tier 1 — not started.** No contract eval exists: nothing checks that a role
file still describes its project.

**Tier 3 — not started, and correctly deferred.** Its precondition was that
Tiers 1 and 2 exist and have identified a role file whose changes need guarding.
Tier 2 now exists but has not yet produced that finding, partly because the
metric that would produce it is divergence 1 above.

**The adaptation loop — not started.** Scorecards are read by a human today.
Nothing proposes a role-file change from them.

## The problem

A role's *identity* is shared and its *knowledge* is per-project:

```
build-studio/docs/agents/ios_dev.md      ← base role, one copy for everyone
<project>/.claude/commands/ios_dev.md    ← project role, hand-written
```

The project file is where all the adaptation lives — stack decisions, ADR
references, test venues, scope boundaries, build hygiene. It is also:

- **written by hand**, usually by copying a sibling project's file. One config
  in this installation still records that its role file was "initially cloned
  from" another project's, and the two have since diverged for reasons nobody
  wrote down.
- **never evaluated.** No check asks whether it still describes the project. A
  role file can reference an ADR that was superseded, a test target that was
  renamed, or a scope boundary three phases out of date, and nothing notices.
- **not derived from what the project already decided.** Kickoff produces a
  vision, ADRs and companion specs, then stops. The role file that should be
  the operational summary of those ADRs is written separately, later, by hand.

The failure mode is the same one the builder-role work was about: **silent**. A
role file that is subtly wrong for its project produces plausible work against
outdated guidance, passes review, and shows up as diffuse quality loss.

## What already exists — and it is more than it looks

One layer of per-project adaptation is already closed-loop, and it is the model
for everything below.

**Learnings.** `capture_learnings` writes project-local entries; `learning-scope.js`
filters them to the project's stack; a budget of six is injected per agent; and
each agent is asked to report `**Learnings applied:** <titles | none>`. That
report is parsed and accumulated into per-entry `timesInjected` / `timesApplied`
counters, with entries auto-archived after 30 injections without an application.

That is a **working per-project evaluation loop already in production**, and its
numbers are the argument for the rest of this plan. Measured across this
installation: framework-specific entries reaching projects that do not use the
framework ran at 831 injections / 0 applications, 711/0, 665/0 — while the three
best performers, all general engineering principles, sat at 18–29%.

The lesson is not "learnings are good". It is that **a cheap self-report,
accumulated over runs, was enough to find a large misallocation nobody had
noticed by reading**. Nothing else in the agent configuration has that.

| layer | per-project? | how it adapts | measured? |
|---|---|---|---|
| base role (`docs/agents/*.md`) | no | — | no |
| project role (`.claude/commands/*.md`) | yes | hand-written | **no** |
| CLAUDE.md / conventions | yes | hand-written | no |
| ADRs / companion specs | yes | agent-authored at kickoff + review | human review |
| **learnings** | yes | agent-authored per run | **yes** |
| config.yaml (roles, gates, strategies) | yes | hand-written | no |

## Three tiers of evaluation

Deliberately ordered by cost. Tier 1 needs no model calls at all, and most of
the value is there.

### Tier 1 — Contract evals: does the configuration still describe the project?

Static assertions over the *composed prompt* and the role file, run in CI and
before a run starts. No agent executes; these are unit tests over configuration.

Checks worth having:

- **Reference integrity.** Every path, ADR, spec and runbook a role file cites
  exists in that project. This is the single highest-value check: it catches
  clone-drift, renamed targets and superseded ADRs mechanically.
- **Cross-role contamination.** A role file does not carry another platform's
  vocabulary. The Android role should not be explaining SwiftUI; the iOS role
  should not mention Gradle. Cheap keyword assertions catch a bad clone on day
  one rather than in a diffuse quality review.
- **Config coherence.** Every role in `roles.execution` has a command file that
  exists; every command file corresponds to a configured role; the unit-test
  target named in config matches one the build system actually defines.
- **Prompt-shape invariants.** The properties whose absence has already cost
  real money: a re-review instruction carries a diff command when a base sha
  exists; a QA instruction names a polling interval; a companion-spec
  instruction never contains the PRD-review verdict format.

The last group is the direct answer to a defect this repo has already paid for
twice — a prompt block that shipped correct-looking and inert for a week, and a
polling instruction that turned into 116 requests and 10.8M cache-read tokens.
Both were found by forensics after the fact. Both are one assertion each.

### Tier 2 — Behavioural scorecards: which project-role pair is underperforming?

No new instrumentation and no eval runs — an aggregation over data that runs
already emit. The unit is the **(project, role, step)** triple.

Signals available today, per run:

| signal | where it already lives |
|---|---|
| fix rounds to converge | `wf.round`, `taskState.fixCycles` |
| findings raised against this role's output, by severity | review agent feedback (`**Blocking:** N` …) |
| gate trips | `step.status === 'blocked'`, `autoAdvanceError`, QA strict-gate overrides |
| learnings applied vs injected | the counters described above |
| token cost and turn count | `agent.tokenUsage` |
| wall-clock per step | agent `startedAt` / `completedAt` |

The interesting quantity is **variance across projects for the same role**. A
role averaging 2.5 fix rounds in one project and 1.1 in another is not a model
problem — it is a configuration problem, and the scorecard says which file to
open. That comparison is impossible today because nothing aggregates across
projects.

**Known blind spot, and it is large.** *(Closed since — see Status by tier.
Kept as written because it drove the sequencing this plan argued for.)*
`agent.tokenUsage` is populated only for
Claude agents: the usage reader keys on the CLI session id, and Codex and
OpenCode agents have none. Any cost or turn-count column is therefore blank for
whole roles depending on which CLI a project assigns them. Fix-round counts,
findings and gate trips are CLI-agnostic and should carry the first version of
the scorecard; cost columns wait for the token-accounting work.

### Tier 3 — Replay evals: would the agent still catch what it caught?

The expensive tier, and the one to defer. Past review rounds are a labelled
corpus: each recorded finding is a known-good detection with the exact document
that produced it. Re-running a reviewer against a historical PRD and scoring
whether it re-finds the known blocker is a real regression test for a role file.

It costs a model call per case, the labels are noisy (a finding not re-found may
be a legitimate judgement difference), and it needs a frozen corpus that does
not drift as PRDs are edited. Worth building only once Tier 1 and 2 exist and
have identified a role file whose changes need guarding.

## The adaptation loop

Evaluation is only half of the request. The loop:

1. Runs emit signals — already true.
2. Aggregate into per-(project, role) scorecards — Tier 2.
3. Rank by cost or pain; surface the worst pair.
4. A **role-tuner** agent reads the role file, the findings raised against that
   role's recent output, its applied and never-applied learnings, and the
   project's ADRs — and proposes a **diff to the role file**.
5. A human approves it. This is a prompt change, and prompt changes have shipped
   broken here before; it gets a review gate, not an auto-merge.
6. Tier 1 evals run against the proposed file; the scorecard trend confirms or
   refutes the change over subsequent runs.

**Learning promotion is the cheapest instance of this loop and should be built
first.** A learning with a high application rate over many injections is not an
episodic lesson — it is a durable project convention that happens to be stored
in the wrong place. Promoting it into the role file frees a slot in the
six-entry budget and makes the convention unconditional rather than
budget-dependent. The counters to decide this already exist.

## Adaptation at kickoff

The other half of the owner's request: more could be settled when a project is
created, rather than left to hand-editing later.

Kickoff already produces the material a role file should summarise — the tech
stack ADR, the persistence ADR, the design adaptation, the runbook. The role
file is downstream of those and is currently the one artifact nobody generates.

Proposal: after `companion_specs` in the kickoff flow, generate each execution
role's project command file **from the ADRs just written**, with the base role
as the template and the ADR cross-cutting requirements as the non-negotiable
section. The owner reviews it like any other kickoff artifact.

Two properties matter:

- **Generated, not cloned.** The current practice of copying a sibling project's
  file imports that project's decisions silently. A generated file cites this
  project's own ADRs, and Tier 1's reference-integrity check then keeps it
  honest.
- **Regenerable.** When an ADR is superseded, the role file is stale by
  construction. The same generator, re-run, produces the diff — which is
  Tier 1 telling you it is time.

## Explicitly out of scope

- **Auto-applying role-file changes.** Every proposal goes through a human. The
  failure mode of a bad prompt edit is silent and diffuse, which is precisely
  the case for a review gate.
- **A shared cross-project learning pool.** Stack filtering already exists for a
  reason; pooling would re-create the 831/0 misallocation.
- **Scoring individual agent runs as pass/fail.** The unit is the configuration,
  not the run. A single bad run is noise; a role that needs three fix rounds in
  one project and one in another is signal.
- **Replacing human review of PRDs or code.** This evaluates the agents'
  configuration, not their output.

## Open decisions

1. **Where scorecards live.** Per-project (`docs/agent-scorecard.md`, committed
   and reviewable) versus installation-wide (hub-side, cross-project comparison
   possible). The cross-project comparison is the whole point of Tier 2, which
   argues for hub-side — but a project-local artifact is the thing a role-tuner
   agent can read without new plumbing.
2. **What counts as "this role's output" for finding attribution.** A review
   round's findings are raised against the PRD or the diff, not against a role.
   Attribution needs a rule — probably the role that ran `task_execution` for
   that PRD, which is now recorded per step.
3. **Whether Tier 1 blocks or warns.** Reference integrity failing is
   unambiguous and could block a run start. Cross-role contamination is a
   heuristic and should warn. The existing gate ladder — advisory instruction,
   deterministic refusal, review gate — is the right frame for deciding
   per-check.
4. **Base-role drift.** If several projects' role files independently grow the
   same section, that is a signal the *base* role should carry it. Detecting
   that is a cross-project diff nobody currently does.

## Verification

- A role file citing a path that does not exist in its project fails Tier 1,
  naming the file and the missing reference.
- A role file containing another platform's vocabulary is flagged, and the
  check does not fire on a legitimate cross-reference ("the iOS analogue is …").
- A configured execution role with no command file, and a command file with no
  configured role, are both reported.
- The scorecard shows the same role in two projects side by side, with fix-round
  and finding counts, and is honest about which columns are unavailable because
  the role runs on a CLI whose token usage is not recorded.
- A learning above the promotion threshold is proposed for the role file, and
  approving it removes the entry from the injection pool.
