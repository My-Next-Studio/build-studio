# Plan: watch a test suite's growth where it actually runs

> **Status: implemented 2026-11-19.**
>
> Owner request: alert when a project's test suite grows (test count, lines
> of test code, and time per suite, against a cap or a trend) and when flaky
> tests keep coming back, and remind to review the suite for overlap on a
> regular cadence. A managed project's test code had grown 60% in four days.

## Why the CI runtime watch was not enough

[test-suite-drift.md](test-suite-drift.md) judges the runner time of GitHub CI
on the default branch. That works for a project that pushes every merge. A
project that merges locally and pushes rarely gives it a handful of runs a
month, each covering dozens of stories, while its suite grows with every
merge. The signals that do exist for such a project are local:

- the merge gate, which runs every suite on every merge;
- the nightly run of the slow suite (Operations → Tests, `nightly:`);
- the test code itself, on the default branch.

Time alone also misses the growth the request was about. Copied helpers,
per-story fixture files and copy-deck assertions add tests and lines faster
than they add minutes.

## What is measured

Three metrics, each per suite:

| Metric | Gate steps | Nightly run | Test code |
|---|---|---|---|
| seconds | the step's time | the run's duration | — |
| tests | the step's count, when it reports one | passed + failed + flaky + skipped | — |
| lines | — | — | lines under `test_paths` on the branch |

- **The gate history is the project's.** Its gate appends one JSON line per
  run, with each step's seconds and, where the tool reports it, its test
  count. Build Studio cannot time a merge gate it does not run, and parsing
  each test runner's output in Build Studio would tie it to those runners.
  Only `ok: true` lines count: a failed gate stops early.
- **Test code is counted by Build Studio**, with `git grep -c ''` over the
  configured pathspecs at the branch head. It runs once per new head, so it
  costs nothing between merges. It counts the branch, not the working tree,
  so uncommitted work does not move it.
- **Only nightly runs that ran the suite count.** A run that could not start,
  or ran no tests, says nothing about the suite's size.

## The rule: the CI runtime rule, unchanged

Each metric is judged by `evaluateBudget` from `ci-runtime.js` as it stands: a
value more than 10% above the median of up to ten before it opens a flag. The
flag keeps that baseline until a value comes back within budget. It stays
quiet for the first three values after a baseline marker. **Keep watching**
and **Accept new size** behave exactly as they do there. Only the minimum
growth that counts differs per metric: one minute, 25 tests, or 1,000 lines.
That keeps a 10-second step growing to 12 seconds from raising a notice.

**Optional caps** sit beside the trend (owner decision). Slow, steady growth
of a few percent per story can stay under a rolling 10% line for a long time,
and more so after each Accept. A cap is a line the owner sets on purpose, for
example 35 minutes for the nightly suite. Crossing it raises a *moderate*
alert, where trend growth raises a *low* one. Caps are per series key in
`suite_watch.caps` and are never set by default.

Options considered:

- **Trend only.** Rejected as the whole answer, for the slow-growth reason
  above.
- **Caps only.** Rejected: every ceiling must be chosen and raised by hand,
  and nothing is flagged until one is hit.

## Recurring flaky tests

A test that was flaky (passed on retry) in some of the last seven nightly runs
that ran, and unstable (flaky or red) in at least three of them, raises one
*moderate* alert per project, listing the tests. Line numbers are dropped from
a test's identity, so editing a spec above a test does not reset its history.
Tests that were only ever red are failures, and the nightly failure alert
already covers them.

## The review: every ten stories

A review is due when `review_every` stories (default 10) have merged since the
last one (owner decision). A story is an execution workflow that completed, as
recorded in the scorecard. The count starts when the watch is first seen, so
switching it on for an established project does not open with a review due.

Options considered:

- **Per release.** Rejected: a project that tags every merge would review
  after every story.
- **Every two weeks.** Rejected: a calendar comes due after a quiet fortnight,
  and falls far behind in a busy one.
- **Only on growth.** Rejected: overlap that adds tests without adding much
  time, such as copied helpers or per-story fixtures, may never trip it.

**Start review** runs the same kind of pass as the CI maintenance pass. One
agent reads the suite and writes proposals, and changes nothing else. The
server files the proposals as a backlog Task at the top of the backlog. The
owner drafts a PRD from it, and that PRD goes through review, build and QA
like any other. The review is told:

- the measured numbers and any flags;
- the recurring flaky tests;
- the stories merged since the last review;
- where things are (gate history, nightly reports, test paths).

It looks for:

- tests a later story generalised;
- copied helpers;
- combinatorial matrices;
- copy-deck assertions;
- fixed waits;
- vacuous checks.

For every test it would remove, it names the test that still covers that
criterion.

**When the filed item reaches Implemented**, every series gets a new baseline
and the story count restarts. **Skip this round** restarts the count without a
review. A growth notice can also start a review directly; the review is then
told which metric flagged.

The review is a second pass type beside the CI one rather than a
generalisation of it. They share the shape (agent, result file, filed Task,
merged item resets baselines) but not their inputs or their store. Merging
them would have meant reworking a module that is in use, for no change in
behaviour.

## Where it shows

The Operations tab that held the nightly run is now **Tests**, with the suite
health above the nightly section (owner decision). It shows:

- one row per suite, with time, tests and lines: the latest value, its
  percentage over baseline, its cap and a sparkline;
- the notices, with their actions;
- the review counter;
- the recurring flaky tests.

Every alert also reaches Monitor and links back to the tab. The tab's red dot
still means only a red nightly run. Growth and review reminders are
low-severity and live in Monitor, like the CI runtime notice.

## Store

Stored per machine, at `~/.build-studio/suite-watch/<project>-<hash>.json`:
the test-code samples, the baseline markers, the watches and the review
state. Same reasoning as the CI runtime store. The samples are a cache of git
and the rest are the owner's decisions, so neither belongs in the project's
git.

## Open

- **Per-test durations from the nightly report.** These would let a notice
  name the specs that grew, as `grownSteps` does for CI jobs. For now the
  review reads `report.json` itself.
