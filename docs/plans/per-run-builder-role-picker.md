# Plan: pick the builder role per execution run, not by config-file order

> **Status: implemented 2026-08-29** (proposed 2026-08-23). All three parts;
> see *Status by part* for what each turned out to mean.
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

### Part 2 — the PRD names its track · **implemented 2026-08-29**

The PM records the track as a `**Role:**` line in the PRD's existing bolded
header block:

```markdown
# PRD-042 — Mobile foundation

**Backlog item:** `EX-101` — Mobile foundation
**Status:** Draft
**Owner:** PM
**Role:** Android Dev
```

`GET /workflow/builder-role?input=<id>` resolves the input the same way the
start handler does and answers what the documents name; the start view calls it
as the input is typed and **preselects** the picker, so the human confirms at a
gate they already attend rather than remembering an extra step.

**Open decision 1 resolved in favour of `role:`** over a separate `Track:`
vocabulary: backlog items already carry `role:`, `resolveBuilderRole` already
reads it, and `findRole` already matches a role name *or* its skill — so
`Android Dev`, `android_dev` and `/android_dev` all work with no track→role
mapping table to maintain per project. The cost is that the PM must know the
roster, which the PM already works from.

Decisions taken during implementation:

- **The hint applies server-side, not only in the picker.** Runs also start from
  the backlog tab and from raw API calls; a field that only worked from one
  entry point would be documentation, not a control. Precedence is
  picker → PRD → backlog item → `execution[0]`.
- **A hint that names a role the project lacks REFUSES the start**, rather than
  being ignored. Ignoring it starts the run under a silently different role than
  the document names, which is the failure the whole plan exists to remove. A
  header-line typo is cheap to fix and the error names the roster. The start
  view surfaces the same condition before the click, so the refusal is not a
  surprise.
- **Only the header is read.** Everything before the first `##` heading. A PRD
  body routinely contains prose about roles, and letting a sentence set the
  builder would reintroduce silent misrouting through a different door.
- **A picker choice always wins**, and the view says so when the two disagree
  rather than quietly overriding — the disagreement is information.

### Part 3 — report which lens produced the code · **implemented 2026-08-29**

Scoped differently from the original proposal, which said "persist the choice"
and treated the builder role as a run-level property. It is not one.

`fix_execution` derives its role independently, by counting role names in the
*fix planner's* output, and the fix-planner prompt explicitly instructs *"Do not
default to whichever role ran the previous task_execution"* — it routes by the
files a fix will touch. That is deliberate and correct: a cross-cutting fix
belongs to the role that owns those files. So a run genuinely has more than one
lens, and recording one name per run would have named the builder while
silently implying the fixes shared it.

`lib/run-roles.js` therefore reports **per step**, derived from the agents that
actually ran rather than stored — a second copy is one more thing that can
disagree with reality. The run header lists each implementation step's roles and
says when they differ, framing the difference as expected rather than as a
warning. `wf.builderRole` remains, meaning what it says: what was *chosen*.

One implementation trap worth recording: `task_execution`'s agents live in
`wf.taskExecution.taskStates[i].agents`, and `wf.steps.task_execution.agents` is
a mirror that only `updateStepAgents` fills — routinely empty mid-run. Reading
the step and not the task states loses the builder entirely.

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
   `**Role:**` line as a standard field, so PM role docs start writing it
   unprompted. The mechanism is live; nothing yet tells a PM to use it, so a
   project only benefits once someone adds the line by hand.
2. **Retiring the reorder ritual** — the affected projects' config comments and
   manual reordering can now be removed, but only for PRDs that carry the
   `**Role:**` line. Until a project's PRDs do, whichever role sits first still
   builds any run started without a selection, so the ordering remains a
   hand-maintained obligation *in both directions*. Sequence: add the line to
   the in-flight PRDs, then flip the roster to a stable order and delete the
   ritual from the config comment.
3. **Fine-grained runs** — the planner assigns roles per task and ignores the
   picker entirely, which is right. Whether a PRD's `**Role:**` line should
   constrain the planner's choices, or stay purely a monolithic-builder hint, is
   untested either way.

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
