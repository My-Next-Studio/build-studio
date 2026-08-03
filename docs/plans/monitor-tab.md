# Plan: a Monitor tab for alerts that need handling

> **Status: proposed 2026-08-03.** Owner request: scheduled-job failures and
> GitHub vulnerability alerts do not belong on the CI/CD tab — that tab is for
> taking an action (push, deploy) and watching its outcome. They want a separate
> cross-project **Monitor** tab, alongside Projects / Demos / Model, listing
> alerts that need handling, with room for external sources such as an uptime
> monitor later.
>
> Independent of any single project. Every managed project with GitHub Actions
> is a candidate source.

## Why the split is real, not cosmetic

The CI/CD tab answers *"did the thing I just did work?"* — it is opened after a
push, and its status panel is scoped to that push. A nightly staleness gate and
a dependency advisory answer a different question: *"has something rotted while
I was not looking?"* Nobody triggered them, and they can go red days after the
last commit.

The distinction is also exact in the data, not a matter of taste.
`gh run list --json event` labels every run, and the three kinds separate
cleanly:

```
schedule   failure   <nightly gate workflow>
push       success   <CI workflow>
dynamic    success   Dependabot Updates
```

So the routing rule is one field:

- **CI/CD tab** — `event: push` (and `workflow_dispatch`)
- **Monitor tab** — `event: schedule`, plus alert sources that are not runs at all

**This also fixes a live mis-attribution.** `GET /deployment/ci-status` currently
takes the most recent run of *any* workflow when `deployment.ci_workflow` is
unset. On a project whose most frequent runs are cron jobs, the CI/CD light
therefore tracks the cron, not the code: at the time of writing, one managed
project shows a red CI light that is a scheduled staleness gate, while its
actual push CI is green. Filtering the CI/CD panel to `event: push` corrects
that without any per-project configuration.

## The load-bearing finding: these sources are STATE, not events

This is what makes the auto-clear question easy, so it is worth stating plainly
before any design follows from it.

None of the candidate sources is a fire-and-forget notification that would have
to be captured, stored and later matched against a resolution. Each is
**queryable for its current condition**:

| Source | Query | Clears when |
|---|---|---|
| Dependency advisories | `GET /repos/{owner}/{repo}/dependabot/alerts?state=open` | the alert leaves `open` (fixed or dismissed) |
| Scheduled-job failures | `gh run list --json event,conclusion,workflowName` | a later run of that workflow succeeds |
| External uptime monitor | its monitors/incidents REST API | the incident resolves |

So **auto-clearing is not a feature to build — it is what you get by not storing
anything.** Derive the list on each poll and a resolved alert simply stops
appearing on the next one.

This is the same rule `project-server/lib/needs-attention.js` already follows,
and for the same reason: *derived, never stored, because a stored flag goes
stale the moment the underlying condition changes, and a stale "needs you" is
worse than none.* A Monitor tab that stored alert rows would need reconciliation
logic, would drift, and would eventually show a vulnerability that was patched
last week — the one failure mode that would make the tab worth ignoring.

### What genuinely does need storage: acknowledgement

The only state worth persisting is *"I have seen this, stop showing it"* — and
it carries a trap worth designing against up front.

Acknowledgement must be keyed to a **stable identity of the specific alert**,
not to its human description. GitHub gives each Dependabot alert a per-repo
`number`; use that. Keying on the package name instead means acknowledging one
advisory silently swallows the *next* advisory for the same package, which is
precisely the alert you most want to see.

An acknowledgement should also expire when the thing it refers to changes — a
scheduled job that fails again after a green run is a new event, not the one
that was dismissed.

Open question for whoever builds it: whether v1 needs acknowledgement at all. If
the list is short and every entry is genuinely actionable, "fix it and it
disappears" may be the whole interaction, and ack is machinery that exists to
manage a list nobody is keeping short.

## What already exists

- **Tab structure** — `packages/hub/components/home-tabs.tsx` is a single array
  (`['projects', 'demos', 'model']`) plus a ternary. Adding a fourth entry and a
  component is the entire structural change.
- **Per-project GitHub access** — `deployment.repo` in a project's config, used
  today by the CI/CD tab. Already set on the projects that have CI.
- **A run-listing path** — `GET /deployment/ci-status` in
  `project-server/lib/api/deployment.js` already shells out to `gh run list`; the
  Monitor sources are additional queries in the same shape, not new plumbing.

## The gaps

### G-1 — no cross-project poll exists

Identical in shape to G-1 in [cicd-tab-ci-monitoring.md](cicd-tab-ci-monitoring.md):
CI status is polled from inside a tab component and torn down on unmount. A
Monitor tab needs project-level polling for the same reason, and **the two plans
should share one mechanism rather than grow a second poller.** Whichever is built
first should build it for both.

The cadences differ enough to be worth separating as parameters of one poller,
not as two pollers:

- CI-after-a-push is minutes-fresh and only matters briefly.
- A nightly gate changes once a day; an advisory changes rarely.

**Cost is not a constraint here, unlike the CI plan.** Nine managed projects × 2
requests × 4 polls/hour ≈ 72 requests/hour against GitHub's authenticated limit
of 5000/hour. A 5–15 minute cadence is generous. This is the cheap sibling of the
CI-monitoring problem; the expensive one is the push-triggered CI poll, and that
is where backoff discipline actually matters.

### G-2 — dependency alerts are disabled on most repositories

Measured at the time of writing: **one of nine** managed repositories has
Dependabot alerts enabled. Every other repo returns:

```
403 — Dependabot alerts are disabled for this repository.
```

This is a prerequisite, not a detail: without enabling the feature per
repository, the tab's most valuable source is empty almost everywhere.

Two implementation notes that follow from it:

- **Treat 403-disabled as information, not as an error.** "Dependency alerts are
  not enabled for this project" is itself actionable, and is different from "we
  could not reach GitHub". They should not render the same way.
- **Do not trust the `gh` CLI's hint on that 403.** It appends
  *"This API operation needs the `admin:repo_hook` scope"*, which is misleading:
  the same token reads alerts successfully on the repository where the feature
  is enabled. The scope is adequate; the feature is off. Anyone debugging this
  will otherwise spend time refreshing scopes that were never the problem.

### G-3 — external sources need a credential story

An external uptime monitor is a token in a config or the existing secrets store,
and a per-source adapter. Nothing structural, but it is the point at which
"alerts" stops meaning "things GitHub told us" — so the internal shape should be
source-agnostic from the first commit rather than retrofitted.

A minimal alert shape that all three sources satisfy:

```
{ source, project, id, severity, title, detail, url, since }
```

`id` is the stable per-source identity that acknowledgement keys on.

## Scope

- A Monitor tab in the home view, listing derived alerts across all managed
  projects, grouped by project or by severity (decide which; see below).
- Two sources to start: scheduled-run failures and dependency advisories. Both
  are GitHub, both are already reachable with the existing credential.
- Filter the existing CI/CD status panel to `event: push` so the two tabs stop
  overlapping and the cron mis-attribution goes away.
- Share the project-level poll with the CI-monitoring plan.
- **Not in scope:** notifications (that decision lives in the CI plan and should
  be made once, for both), changing the CI-investigate agent, and any write path
  — Monitor reads and links out; it does not dismiss alerts on GitHub's side.

## Open decisions

1. **Acknowledgement in v1 or not** — see above. Defaulting to *not* is
   defensible and keeps the tab honest.
2. **Does a cleared alert leave a trace?** Purely derived means it vanishes, and
   you never learn that the nightly gate recovered. The same question is open in
   the CI plan for notifications; answer it once for both.
3. **Grouped by project, or by severity?** By project matches how the rest of
   the hub is organised; by severity matches how someone triages a morning list.
4. **What counts as an alert at all** — a scheduled run that has failed once may
   be flaky infrastructure; failing twice consecutively is a signal. Consider
   whether the first failure belongs on the list.

## Verification

- A scheduled job fails → it appears on Monitor, and the project's CI/CD light
  is unaffected (it tracks push runs only).
- That job's next scheduled run succeeds → the entry disappears with no
  interaction. This is the whole premise; if clearing needs a click, the derived
  model was not actually implemented.
- A dependency advisory is fixed by a merged bump → the entry disappears on the
  next poll.
- A project whose repository has alerts disabled shows a distinct "not enabled"
  state, not an error and not a silent empty list.
- Polling continues while the Monitor tab is closed — an alert raised overnight
  is present when the hub is next opened, without visiting the tab first.
