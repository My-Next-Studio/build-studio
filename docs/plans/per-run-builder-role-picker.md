# Plan: pick the builder role per execution run, not by config-file order

> **Status: Part 1 implemented 2026-08-29** (proposed 2026-08-23). Parts 2 and 3
> remain proposals; see *Status by part* below.
>
> Owner request: when the PRD being executed is an app story, the run should
> build under the mobile role; a web story under Frontend/Backend — chosen at
> run start, not by editing role order in config.yaml.

Under the monolithic execution default, one builder agent implements the whole
PRD — and which *role* that agent plays (which command file it loads, which
domain rules and toolchain habits it carries) was decided by nothing more than
**array position**: the synthesized single-task plan hardcoded
`config.roles.execution[0]`, complete with a literal role-name fallback from its
example-project origins. Nothing about the PRD's content participated.

## The cost of not having it

Two projects motivated this: one with two implementation tracks, one with three
(backend, web, mobile). Their configs documented the standing workaround —
put the current track's role first, and move it back afterwards.

Two properties make this worse than ordinary friction:

- **The failure is silent.** An agent will happily build another track's story —
  wrong lens, wrong domain rules, no error. It surfaces only as diffuse quality
  loss, which is the expensive kind of defect to notice.
- **It scales with track count.** Two roles is a two-state ritual; three makes
  it three-state, and each added platform adds another.

**It then happened, which is why Part 1 shipped.** A project executed a native
mobile foundation story — build system, UI toolkit, platform sources — under a
*different* platform's role, because that role was `execution[0]` and the right
role did not exist in the roster at all. Nothing failed and nothing errored: the
agent carried 239 lines of the wrong platform's domain guidance while writing
the other platform's code, and the run passed code review. The mismatch was
noticed by a human reading the dashboard, not by any check.

## What already existed — most of the mechanism

This was a small plan because the engine already had both halves; they were just
not connected for PRD runs:

1. **Bugfix runs already resolved the builder per item.** `resolveBuilderRole(config, item)`
   honors an `item.role` field via `findRole`, falling back to `execution[0]`. A
   bug that names its role builds under that role. PRD execution never called
   it — the monolithic planning shortcut read `execution[0]` directly.

2. **Per-run overrides at workflow start are an established pattern.** The start
   view already POSTed `developerCli` / `reviewerCli`, validated inline in the
   same handler. A `builderRole` parameter sits in the same request body, the
   same validation shape, and the same UI row.

## Status by part

### Part 1 — the picker · **implemented 2026-08-29**

On the execution start view, a **Builder role** selector listing
`roles.execution`, default = current behaviour (`execution[0]`). The start
request carries `builderRole`; the monolithic planning shortcut routes through
`resolveBuilderRole(config, { role: wf.builderRole })` instead of reading
`execution[0]` inline — one resolution path for bugfix and PRD runs — and the
hardcoded role-name fallback is gone. Fine-grained (planner) runs ignore the
parameter: the planner already assigns roles per task.

Two decisions taken during implementation that the original plan did not state:

- **An unresolvable selection is refused, not defaulted.** `resolveBuilderRole`'s
  fallback to `execution[0]` is right for a bugfix's frontmatter `role:` — a
  best-effort hint where a typo should not stop a run. It is wrong for an
  explicit picker choice: silently building under a role the owner did not pick
  recreates the exact failure the picker exists to remove, and does it while the
  UI claims otherwise. `validateBuilderRole` returns an error and the start
  request 400s, naming the valid options.
- **A review-only role cannot be selected as the builder.** `findRole` treats a
  category as a *preference*, not a filter, so a review role resolves to a valid
  role object and would otherwise launch as a builder with no branch prefix. The
  match is confirmed against the execution list.

The picker renders only when a project has more than one execution role — with
one there is nothing to choose and the row is noise.

### Part 2 — the PRD names its track · **proposed**

The PM records the implementation track in the PRD; the start view reads it and
**preselects** the picker; the human confirms at the gate they already attend. A
PRD whose track disagrees with the picked role is a visible mismatch at start
time instead of a silent one at review time.

**Open decision 1 is now resolved in favour of `role:`.** The original plan
offered `Track: backend | web | ios | android | fullstack` as an alternative.
Prefer a `role:` line naming the project's own role, because:

- backlog items already carry `role:`, and `resolveBuilderRole` already reads it
- `findRole` already matches on role name *or* skill, so `role: iOS Dev` and
  `role: ios_dev` both work with no new code
- a `Track:` vocabulary needs a track→role mapping table maintained per project,
  which is a second namespace to keep in sync with the roster

The cost is that the PM must know the project's role names — but the PM already
works from the roster.

### Part 3 — persist the choice · **partially implemented**

`wf.builderRole` is recorded and surfaced in the run header, so "which lens
built this?" has an answer in the UI rather than in tmux logs.

**What remains, and it is not what the original plan assumed.** The plan treated
the builder role as a run-level property. It is not: the `fix_execution` step
derives its role independently, by counting role names in the *fix planner's*
output, and the fix-planner prompt explicitly instructs *"Do not default to
whichever role ran the previous task_execution"* — it routes by the files a fix
will touch. That is deliberate and correct (a cross-cutting fix belongs to the
role that owns the files), but it means a run genuinely has more than one lens.
Recording one name per run is therefore incomplete: **Part 3 should record the
resolved role per step, not per run.**

## Explicitly out of scope

- Automatic classification of PRD content. The `role:` field is authored by the
  PM and confirmed by the owner — no classifier.

  Worth stating why, since the engine already contains one: the fix planner
  carries a hardcoded extension mapping (platform sources → the platform role,
  web assets → frontend, migrations → backend) and applies it every fix round.
  The asymmetry is real — fixes route by content, builds by array index — and
  closing it is what Part 1 does. But the two venues differ in what they can
  see: at fix time there is a diff to classify, at build time only prose. The
  signal is much weaker where the classification would have to happen.

- Multi-role monolithic builds. A cross-track story is split per track, or run
  fine-grained — that remains the answer.
- Any change to review or kickoff flows.

## Remaining open decisions

1. **Cross-project convention** — whether the shared PRD conventions gain the
   `role:` line as a standard field (so PM role docs start writing it), or it
   stays opt-in per project until Part 2 proves it.
2. **Retiring the reorder ritual** — after Part 2 lands, the affected projects'
   config comments and manual reordering should be removed in the same change
   that flips each config back to a stable role order. Until then the ordering
   remains a hand-maintained obligation *in both directions*: whichever role
   sits first builds everything, so a roster reordered for one track silently
   mis-builds the next story from another.

## Verification

- Start an execution run for a web PRD in a project whose `execution[0]` is a
  mobile role, pick the web role: the builder session loads the web role's
  command file, the branch prefix is the web role's, and the config file was
  never edited.
- Same run started with no selection: identical to before the picker
  (`execution[0]`).
- A `builderRole` naming a role that does not exist, or naming a review-only
  role: the start request fails with an error listing the execution roles,
  rather than starting under a different role.
- Bugfix runs: unchanged behaviour, sharing the single resolution path
  (existing `resolveBuilderRole` tests keep passing).
