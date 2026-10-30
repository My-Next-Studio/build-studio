# Plan: catch test-suite drift, and prune it through the normal pipeline

> **Status: implemented 2026-10-27.**
>
> Owner request: a managed project's CI suite had grown to two to three hours
> for a small site, and the reason was that each PRD added its own gate or
> performance test and nobody ever pruned or consolidated them. Find a way
> to keep a suite in good shape as stories and PRDs pile up.

## The problem

Every step of a workflow is scoped to one PRD. The builder is told not to
refactor outside its task, QA checks that this PRD's acceptance criteria are
covered, and the reviewers read this PRD. No step owns the suite as a whole,
so tests are only ever added. Each addition is reasonable on its own: a
performance gate for the page the PRD built, a Lighthouse pass in the test
that covers it. Together they make a suite where the same pages are audited
several times per push, and one that nobody would have designed.

The cost is real and slow to notice: CI minutes on a private repository, and
a deploy that waits hours behind a run already in progress.

## Options considered

1. **Make every workflow consider the whole suite.** Rejected as the main
   mechanism. A PRD's builder cannot redesign the suite on every run: it would
   cost a full read of the suite each time, and a run building one feature is
   the wrong moment to delete another feature's tests. A narrow version of it
   is kept as a guardrail (below).
2. **A periodic maintenance job.** Chosen, triggered by measured growth
   rather than by a calendar, so it runs when there is something to fix.

## The guardrail inside every run

One rule, in `lib/suite-guardrail.js`, worded for each agent that meets it:

- **Builders and the test writer:** before adding a gate, performance,
  Lighthouse-style audit, snapshot sweep or any other check that runs across
  many pages, look for one that already covers the surface and extend it.
  Add a new one only when none can take the cases, and say why.
- **Code reviewers and the final reviewer:** a new suite-wide check or CI
  step that duplicates an existing one is a MEDIUM finding naming the check
  to extend. It is not BLOCKING, because it costs CI time, not correctness.
- **PRD reviewers:** the same, for a PRD that asks for a new gate where one
  exists. PRDs are where most of these gates were first asked for.

Unit tests are left out on purpose. They are cheap and per-feature by
nature, and the cost in the original case was in suite-wide gates.

The same idea could apply to code (dead code, duplication, slow builds). It
is left for later: an open-ended "review the code for improvements" job is a
finding generator, and tests are where the cost is concrete enough to start.

## Measuring: CI runtime on the default branch

**Measured on CI, not in QA.** QA usually runs only part of the suite (the
UI tests a branch touches, the JS tests related to changed files), so its
runtime is not comparable from run to run. CI on the default branch runs the
full suite every time. Pushes are not made for every PRD, so a flag cannot
name the PRD that caused growth, only the range merged since the last
measured run. The goal is drift over weeks and months, not single stories,
and that is the right level for it.

- **Source.** The CI monitor already lists runs with `gh run list`.
  `gh run view --json jobs` adds each job's and each step's duration, so a
  gate step that is not a test file (a site-wide Lighthouse pass, say) is
  measured as well.
- **Runner time, not wall clock.** A run's duration is the sum of its jobs'
  own durations. Time spent queued behind another run is not growth.
- **Only successful runs** count: a failed or cancelled run stops early.
- **Per CI workflow.** A web workflow and an iOS workflow are separate series.
- **Seeded from history.** GitHub keeps past runs, so the median starts from
  the last ten successful runs on the day the feature ships, not empty.
- **Stored machine-wide**, in `~/.build-studio/ci-runtime/<repo>.json`. The
  timings are a cache of GitHub, and the markers are the owner's decisions
  about that repository. Neither belongs in the managed project's git, and
  writing there would mean a `.gitignore` change and a commit in every
  project. Each completed run costs one `gh run view` in its lifetime, and
  the run lists refresh every 30 minutes.

## The budget: 10% over the median

A workflow is over budget when a successful run's runner time is more than
10% above the median of the up to ten successful runs before it since the
last **baseline marker**. The check stays quiet until three runs since the
marker precede the one judged. Growth under two minutes is ignored whatever
the percentage: a 40-second check that takes 50 seconds is 25% over and
costs nothing. All three numbers can be overridden per project in
`deployment.ci_runtime_budget`, and `false` turns the check off.

**The flag keeps its baseline.** Once a run is over, later runs are judged
against the same baseline, not the rolling median. Otherwise a suite that
grew and stayed grown would lose its notice after about five runs, once the
median caught up, with nothing done. A run that comes back within budget
closes the flag: a noisy runner, or a fix, leaves nothing to act on.

**Derived, not remembered.** The state is computed by replaying the runs
since the marker in order, every time it is read. Nothing can stay stuck
over budget after its cause is gone, and changing the rule needs no
migration.

The marker is needed in both directions:

- **After a maintenance pass shrinks the suite**, the median of the older,
  slower runs would stay high for several runs, and the suite could grow back
  by a third without any run looking 10% over.
- **After growth the owner accepts** (a PRD that legitimately adds a large
  suite), every run would be flagged until the median caught up.

A marker is set when a maintenance PRD's first green CI run lands, and when
the owner accepts a flagged increase.

## The notice

An over-budget workflow shows a notice under the project's CI light in the
CI/CD tab, for example *"Web CI is 18% over its baseline (2h50 against
2h24), since the push of 10-14"*, followed by the steps that grew most. It
also appears as a low-severity row in the Monitor tab, so it is visible
across projects. Below the notice, a table lists each workflow's median and
latest runner time. The notice carries two actions:

- **Start a maintenance pass** (below).
- **Accept the new size**, which sets a baseline marker.

Nothing is filed automatically. A backlog item filed on every breach piles up
when the first one is not acted on; the notice simply stays until one of the
two actions is taken. To keep it for later, the owner asks the PM to file it.

## The maintenance pass: an analysis that ends in a PRD

The button starts one agent (`lib/ci-maintenance.js`). It is given the
runner time against the baseline, the steps that grew, and where the time
goes in the latest run. It reads the workflow file, the gates and tests the
expensive steps run, and the commits and PRDs they came from. Its proposals
say which tests or gates to merge, cut, scope down or move to a scheduled
run. For every test a proposal removes, it names the test that still covers
that acceptance criterion. It changes nothing in the project, and writes its
result to a file.

**The server files the result as a backlog Task**, and the owner clicks
Draft on it. The PM then writes the PRD with the owner in the drafting
session, and from there it is an ordinary PRD: review, execution, QA, merge.
Two alternatives were rejected:

- **The agent writes the PRD itself.** One step fewer, but each project has
  its own PRD conventions (numbering, header lines, docs lint) that drafting
  already handles. It would also leave the owner to push back on cuts in
  review instead of choosing them first.
- **A separate maintenance workflow type.** It would duplicate the gates
  that already protect a change, and the review panel is exactly what should
  catch a cut that loses coverage.

The server files the item, not the agent, so the item's wording and its link
back to the pass do not depend on an agent remembering them. The item goes to
the top of the backlog (owner request: the most visible place), and the owner
moves it from there. If filing fails, the result stays on disk and a retry
files it without running the analysis again. One pass runs
at a time: a second is refused while one is analysing or filed and not yet
implemented. **When the item reaches Implemented (its PRD merged), the
baseline marker is set for every workflow**, since the PRD may touch any of
them. Any push run created after that point carries the merge, so the marker
has the same effect as waiting for the first green run.

## Open

- **Code maintenance** as a second kind of analysis, once a test pass has
  shown what such a pass produces.
