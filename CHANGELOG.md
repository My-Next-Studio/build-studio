# Changelog

All notable changes to Build Studio.

Build Studio ships from `main` — there are no tagged releases — so entries are
grouped by date, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

**Read `Upgrade steps` first.** It lists what you must *do* after pulling, split
by where the work happens:

- **In Build Studio** — done once, in this repo (rebuild, inject, restart).
- **In each managed project** — done per project, in repos that are *not* this
  one. Build Studio writes into the projects it manages, so an update here can
  require a change there. This is the step most easily missed.
- **Nothing to do** — stated explicitly when that is the answer, so silence is
  never ambiguous.

Then read `Changed` — behaviour that shifts on an unmodified config, i.e. things
that move underneath you without your having edited anything.

---

## 2026-07-31 — Recover stuck agents, reap finished ones, and pause before thrashing

Four separate stalls this week traced back to the same shape: workflow state
asserting an agent was `running` when nothing was behind it, or an agent
finishing without telling anyone. Each was recoverable, and in each case the
obvious remedy — relaunch the step — was the one that destroyed the work.

### Added

- **Recover an agent's report from its transcript.** An agent can complete its
  work — write the files, make the commit, print the full report — and then end
  its turn without running the feedback POST. The workflow then waits forever on
  output that already exists: the Claude CLI writes every turn to a JSONL
  transcript, and Build Studio already records each agent's `cliSessionId`.

  When a run halts, the banner now offers **↩ Recover \<role\>'s report** if that
  output is sitting on disk, and delivers it verbatim as the feedback the agent
  failed to send — full fidelity, not a scrape of the reflowed terminal. It is
  routed through the normal feedback endpoint, so format gates, telemetry and
  auto-advance all run unchanged; recovery is not a second, weaker path into
  workflow state.

  This beats nudging the pane, which is what one would try first: under memory
  pressure the process stops accepting input altogether, so a nudge cannot land,
  while the transcript is unaffected. Two agents were recovered this way after
  being confirmed unreachable. New: `GET /workflow/recoverable`,
  `POST /workflow/recover`.

- **A memory guard before each fan-out.** Agents are not launched into a machine
  with no room for them. The budget scales with the batch — roughly 200 MB per
  agent plus 1 GB headroom — so a one-agent bugfix is not blocked by a ceiling
  that exists for six-agent review fan-outs.

  It deliberately does *not* gate on swap used, the obvious signal: swap
  occupancy is a **lagging** measure. Measured at 89% on an idle machine with
  1.5 GB of agents running, it would have deferred every launch on a healthy
  box. Available memory (free + inactive + speculative + purgeable, as Activity
  Monitor counts it) is current rather than historical. Fails open — memory that
  cannot be read never blocks a launch, so non-macOS hosts are unaffected.

### Changed

- **Agents are configured per STEP GROUP, not per role.** The Model page had a
  Default / Developer / Reviewer slot, which cut across the grain of the actual
  decision: what you want from a model depends on what the *step* is doing, not
  on the job title of the agent doing it. The `reviewing` step ran Security on
  the Reviewer slot and Brand on the Default slot purely because of their role
  names, though both were reviewing the same PRD.

  The page now shows one row per group, plus a Default row that a group
  inherits from when it sets nothing:

  | Group | Steps |
  | --- | --- |
  | **Plan & specify** | `ceo_synthesis` `pm_scoping` `pm_draft` `pm_revision` `pm_fix` `pm_synthesis` `discovery` `architect_backfill` `companion_specs` `planning` `fix_plan` |
  | **Build** | `task_execution` `fix_execution` `qa_tests` `devops_init` `devops_detect` |
  | **Review & verify** | `reviewing` `team_review` `code_review` `security_audit` `qa_validation` `ac_verification` `coverage_matrix` `final_review` `capture_learnings` |

  Steps that launch no agent are deliberately absent — the human gates
  (`owner_consultations`, `owner_signoff`, `demo_review`, `device_testing`) and
  the mechanical git steps (`merge_for_review`, `merge_to_main`). They have no
  model to pick, so offering one would have been a lie.

  **The grouping is not hardcoded.** It lives in config as `step_groups`, at
  the installation level (`~/.build-studio/config.json`) or per project, so you
  can split the expensive backstop out of Review, add a cheap bucket for
  mechanical steps, or regroup entirely — without touching code:

  ```yaml
  # .build-studio/config.yaml — optional; omit to use the shipped grouping
  step_groups:
    plan:   { label: Plan & specify, steps: [pm_draft, planning, fix_plan] }
    build:  { label: Build,          steps: [task_execution, fix_execution] }
    review: { label: Review,         steps: [code_review, qa_validation] }
    gate:   { label: Final gate,     steps: [final_review] }   # e.g. keep the backstop expensive
  ```

  A step listed in two groups belongs to the first. A step in no group runs on
  the Default row, so a step added by a newer Build Studio still works before
  anyone has grouped it.

- **What the Model page shows is now what runs.** Precedence is reversed so the
  UI outranks `config.yaml`:

  ```
  per-run override  >  UI role slot  >  project config.yaml  >  preset  >  agent_defaults
                       (project Model page when "Use default" is unchecked,
                        otherwise the global Model page)
  ```

  `config.yaml` `step_models` / `step_efforts` used to outrank the role slots,
  so choosing a model in the UI silently did nothing on any step `config.yaml`
  named — and the agent card showed the `config.yaml` value with no hint the
  picker had been ignored. They are now a **fallback for what the UI has not
  configured**. A per-run override still wins over everything.

  **This will change how your steps run.** Because the global Model page always
  carries `default_model` and `default_effort`, and an empty per-role slot falls
  back to those, a project's `step_models` / `step_efforts` now only apply when
  the corresponding slots are *all* empty. A project running a deliberate
  per-step configuration — e.g. `task_execution: opus[1m]` at effort `xhigh` for
  whole-PRD monolithic work — will now get the role slot's model and effort
  instead. **Move that setting to the Model page** (uncheck "Use default" on the
  project and set the role slot) to keep it. `modelSource` on the agent card
  names the deciding layer in every case, so a value you did not expect says
  where it came from.

- **A global Model page change now reaches running project-servers.** The hub
  writes `~/.build-studio/config.json` and nothing told the servers, so each one
  kept the CLI slots it resolved at startup. Switching the global developer CLI
  and immediately starting a run launched agents on the **old** CLI while the UI
  showed the new one — the setting was right, the running server's copy was
  stale. Project-level edits never showed this, because saving them calls
  `reloadConfig()` directly; only the global path had no route back. The global
  file is now watched alongside `config.yaml` and `local.json`.

- **Finished agents are now closed instead of left running.** A CLI agent does
  not exit when it finishes; it sits at its prompt holding 100-200 MB
  indefinitely. Across a multi-round run this becomes the dominant memory cost —
  one 4-round review left 21 windows from rounds 1-3 resident, about 4 GB, long
  after the workflow had stopped referencing them (each round overwrites
  `steps[*].agents`, so nothing pointed at the old ones any more, and no sweeper
  could have found them either).

  An agent's tmux window is now closed the moment its feedback is recorded —
  which is also *before* the next round overwrites the record. On a 16 GB
  machine this is the difference between finishing a review and swapping hard
  enough that agents stop responding to input.

  **Its logs are not lost.** `pipe-pane` has always streamed each pane to
  `tmp/.logs/<window>-<workflow-id>.log`, and View Log now falls back to that
  file when the window is gone — so agent logs now outlive the session, which
  they previously did not. Set `reap_finished_agents: false` in a project's
  config to keep the old behaviour.

- **A launch that declines to do anything now says so.** The task-execution
  guard that refuses to start a second agent while one is in flight answered a
  bare `200`, indistinguishable from a successful launch. Auto-advance counted
  it as success and re-fired every 8 seconds forever, and a relaunch that hit it
  reported success while doing nothing. It now returns a `declined` reason,
  which auto-advance treats like any other refusal — surfacing it on the step
  after a few attempts instead of spinning silently.

### Fixed

- **A finished PRD review no longer skips companion specs and leaves the item
  Drafted.** A review had three ways to reach `completed`, and only one did the
  whole job:

  | Path | Companion specs | Item → Reviewed |
  | --- | --- | --- |
  | `companion_specs` approved | yes | yes |
  | round cap exceeded | **no** | **no** |
  | all reviewers approve cleanly in-round | **no** | yes |

  The backlog transition lived *inside* the `companion_specs` handler, so any
  path that skipped that step also skipped marking the item — the run reported
  success having silently dropped two phases. Observed on a review that ran its
  full four rounds: the item stayed `Drafted` and two of three **Required**
  companion specs were never written, while the PRD's own gate says every
  Required spec must exist before execution. The clean-approval path is the
  more insidious one: it *does* mark the item Reviewed, so the item looks ready
  while its preparation gate is unmet.

  Completion is now a single function that always marks the item, and no path
  reaches the end without passing through `companion_specs`.

- **The review round cap is now 5, up from 4.** With strict auto-advance on —
  where *any* finding, low severity included, sends the round back to PM —
  reaching four rounds before the last LOWs are cleared is ordinary rather than
  pathological, so the old cap was interrupting healthy runs. Projects that set
  `max_review_rounds` in `config.yaml` keep their own value.

  The number also had three spellings in code (`|| 4`, `|| 4`, `|| 2`), so a
  config that failed to supply it would cap the loop at 2 while the UI showed
  4. It now comes from one constant.

- **Hitting the review round cap now stops and asks, instead of ending the
  run.** Reaching the cap says the loop ran as long as you allowed — not that
  the PRD is finished — so the engine no longer decides for you. The run halts
  on a blocked `review_cap_reached` step (auto-advance will not act on it) and
  offers both ways out: **another review round**, or **move on to companion
  specs**. Neither is preselected, and the run cannot finish from there.

- **Agent cards no longer label every Claude model "Sonnet".** The badge
  detected the model family with `model.startsWith('opus')`, which only ever
  worked for the short aliases (`opus`, `opus[1m]`). Since the Model page began
  writing full ids discovered from models.dev, `claude-opus-5[1m]` failed every
  branch and fell through to the Sonnet default — so an Opus agent displayed
  **Sonnet** while genuinely running Opus, and `claude-haiku-4-5` did too.

  Display only: the launch flag, the workflow state and the CLI transcript all
  carried the right model throughout. But it made a correct configuration look
  broken, which is worse than an honest gap. Family is now matched anywhere in
  the string, Fable is recognised, and an unfamiliar model shows its own name
  instead of being labelled as whichever family sat last in the chain.

- **The account-usage widget no longer reports 1% as 100%.** Any usage figure
  at or below 1 was treated as a fraction and multiplied by 100, so a barely
  used account showed a full red bar saying the budget was gone. It failed in
  the worst direction and only on small values, which is why it looked
  intermittent — and why the weekly window beside it stayed correct.

  Every field involved is already named as a percentage (Anthropic
  `utilization`, Codex `used_percent`), and one live payload settles it:
  `five_hour: 2` next to `seven_day: 49`. As fractions those would be 200% and
  4900%. Values are now taken as given and clamped to 100.

- **A config change no longer stops propagating after the first one.** The
  config watcher watched files, but every writer here saves atomically — write
  a `.tmp`, then rename over the target. A rename replaces the inode, and a
  file watcher follows the inode it opened, so it fired exactly once and was
  then attached to a deleted file. Measured against three atomic writes: a file
  watcher saw one, a directory watcher saw all three. It now watches the
  containing directories and filters by name, which also picks up a
  `local.json` that did not exist when the server started.

- **A halted step is reported even with auto-advance off.** "Every agent died"
  was only ever recorded by the auto-advance tick, so the identical dead step
  produced no signal at all when auto-advance was off. It is now derived
  directly, and reads the same to every consumer.

- **A stalled task-execution agent is now timed out.** The 15-minute idle
  watchdog read only `steps[currentStep].agents`, which is empty for
  task-execution runs, so it never examined them. An agent that died on a
  provider usage limit sat marked `running` with a shell prompt in its pane for
  40 minutes past the timeout, reporting nothing wrong. It now sweeps agents in
  both homes, and marks the step's copy and the task's copy together — marking
  only one left the launch guard still seeing a running task.

- **A killed tmux session no longer leaves a task-execution run stuck forever.**
  The stale-session sweep marked running agents as failed, but read only
  `steps[*].agents` — and task-execution agents live on
  `taskExecution.taskStates[i].agents`, mirrored onto the step only by a
  function the normal launch path never calls. So the mirror is routinely empty
  while a task runs, and the sweep skipped exactly the case it existed for.
  After a machine restart the run sat inert with an agent marked `running` and
  no process behind it, reporting nothing wrong, while the project's workflow
  slot stayed held so nothing else could start.

- **Relaunching a task-execution step now works.** It reset the step but not
  `taskExecution`, leaving every in-flight task still marked `running` — so the
  launch guard declined and the relaunch silently did nothing, ending with the
  step `pending`, the task `running`, and no process anywhere. In-flight tasks
  are now returned to pending (finished ones stay done), and `completedTasks` is
  no longer discarded by the reset.

- **A project could go permanently unstartable because `GET /workflow` crashed.**
  A fix planner is free to emit a numeric task id — the `WorkflowStep` type has
  always declared `id?: number` — but the findings matcher called `.split()` and
  `.includes()` on it. The `TypeError` took the whole endpoint down with a 500,
  so the Workflow tab rendered nothing, the finished run could not be closed
  out, and because it still held the project's single workflow slot, *every*
  Start button in that project stayed blocked with no visible cause. The two
  endpoints disagreeing was the only clue: `start-readiness` doesn't use the
  matcher, so it kept correctly reporting "blocked" while the tab showed an
  empty screen. Ids are coerced instead of assumed. Present since the initial
  release; it needed a run whose planner happened to number its tasks.

- **A blocked Start button now tells you why.** The tooltip was on the `disabled`
  button itself, and Chromium dispatches no mouse events on a disabled element —
  so the explanation appeared only on buttons that weren't blocked, which is
  exactly backwards. It now lives on a wrapper, so hovering any blocked button
  gives the reason.

### Upgrade steps

**In Build Studio** — hub and project-server both changed, so a full inject, not
`--sync-only`: `cd packages/hub && npx next build`, then
`cd packages/desktop && node inject-resources.js`. Restart the app, and restart
the project-servers — the reaper, the memory guard and the stale-session sweep
are all server-side.

**Your existing agent settings migrate themselves — nothing to type.** The old
role slots are rewritten onto groups the first time a config is read:

```
developer_cli / developer_model / developer_effort   →  Build group
reviewer_cli  / reviewer_model  / reviewer_effort    →  Review group
default_*                                            →  unchanged; still the
                                                        fallback every group
                                                        inherits from
```

That mapping is exact for the steps each slot used to drive, so most steps run
on precisely what they ran on before. **Three shift**, because grouping unifies
steps the old slots split apart — all three move from the Default slot's values
to the group's:

| Step | Was | Now |
| --- | --- | --- |
| `reviewing` (Brand, Marketing, UX, Architect) | Default slot | Review slot — Security already used it |
| `capture_learnings` | Default slot | Review slot |
| `qa_tests` | Default slot | Build slot |

If your Default and Review slots differ, check `reviewing` and
`capture_learnings`; if Default and Build differ, check `qa_tests`. Anything you
dislike is one edit on the Model page, or a `step_groups` block moving the step
elsewhere.

**In each managed project** — **check any project that sets `step_models` or
`step_efforts` in `config.yaml`.** Those entries no longer outrank the Model
page, so a per-step model or effort you rely on will be replaced by the role
slot's value unless you move it to the Model page (uncheck "Use default" on the
project, then set the role slot). To find them:

```
grep -l -E '^(step_models|step_efforts):' */.build-studio/config.yaml
```

The two new config keys are optional and default to on:

```yaml
# config.yaml — both optional
reap_finished_agents: true    # false keeps finished agent windows open
memory_guard:
  enabled: true
  per_agent_mb: 200           # working-set estimate per agent
  headroom_mb: 1024           # left for the app, servers and OS
```

### Known issues

- Auto-advance is still implemented twice, client-side and server-side. Both
  now carry the dead-step guard, but a fix to one still has to be mirrored by
  hand into the other.

### Notes for forks

- **Agents live in two places.** Step agents are on `steps[key].agents`;
  task-execution agents are on `taskExecution.taskStates[i].agents` and only
  *mirrored* onto the step by `updateStepAgents`, which the normal launch path
  does not call. Any sweep over "all agents" must read both, or it will silently
  skip every task-execution run — use `agentRecovery.allAgentsOf(wf)`. The
  mirror is a shallow copy, so both views need marking to stay consistent.

- **Reaping is hooked to feedback, not to a timer.** That is deliberate: a
  periodic sweeper cannot find agents from earlier rounds, because each round
  overwrites `steps[*].agents` and the records are gone. The moment feedback is
  recorded is the last moment the agent is still addressable.

- **The memory guard fails open by design.** A guard that blocks work because it
  could not take a measurement is worse than no guard. If you extend it, keep
  unreadable input returning "allow".

- **The step grouping is data, not code.** `packages/shared/step-groups.js`
  supplies only the DEFAULT; the live mapping comes from config. If you add a
  workflow step, add it to a group there — or leave it, and it runs on the
  Default row rather than failing.

- **The per-role resolvers are gone.** `resolveCliForRole`,
  `resolveModelForRole`, `resolveEffortForRole` and `resolveAgentLaunchSettings`
  were removed from `shared/cli.js`; `resolveStepLaunchSettings(stepKey, wf,
  cliConfig, groups)` replaces all four. `isDeveloperRole` / `isReviewerRole`
  remain — the auto-reviewer rule still uses them. A fork calling the old
  functions should switch to the step-based one rather than reinstate them,
  since role-based resolution no longer matches what the UI shows.

- **One validator for both Model pages.** `validateCliPatch` in `shared/cli.js`
  is used by the project route and the installation-wide route. Two
  hand-written validators for one shape is how a value comes to be accepted in
  one place and rejected in the other.

## 2026-07-29 — Say why a run is stopped, and stop overruling the model picker

### Added

- **One derived answer to "can this proceed without me?"**
  (`project-server/lib/needs-attention.js`). The engine already halted correctly
  in half a dozen places, but each recorded itself differently — a stashed
  `autoAdvanceError`, a `blocked` step, a `review_cap_reached` step, a manual
  gate, a finished run still holding the slot. Nothing named the *condition*, so
  every consumer re-derived it from a different subset and they disagreed.

  Now derived (never stored — a stale "needs you" is worse than none) and served
  on `GET /workflow` and `GET /workflow/start-readiness` as
  `{ reason, step, title, detail, action }`. The Workflow tab shows one banner
  covering every halt, saying what happened and what clears it, replacing a
  banner that only knew about `autoAdvanceError`.

- **`modelSource` on each agent**, recording which layer chose its model —
  `step`, `role`, `preset`, or `default` — surfaced in the agent card's model
  tooltip. A model that isn't the one picked in the Agents tab now explains
  itself instead of reading as a broken picker.

### Changed

- **Workflow preset `step_models` / `step_efforts` no longer override the
  Agents-tab role slots.** They predate UI model configuration and encode a cost
  trade-off (`reviewing: 'sonnet'` — *"near-Opus at code analysis, far
  cheaper"*), and they silently outranked an explicit UI selection on every step
  a preset happened to name. Precedence is now:

  ```
  per-run override  >  project config.yaml  >  UI role slot  >  preset  >  agent_defaults
  ```

  A project's own `step_models` still wins over a role slot — it is a current,
  deliberate, more-specific choice. Only the *shipped* half was demoted, and it
  remains the fallback for a project nobody has configured, including a slot
  momentarily cleared mid-reconfig. `agent_defaults` is still the last resort, so
  an agent can never launch without a model.

  This was only possible after splitting the merge in `resolvePreset`, which
  flattened preset and project entries into one object with no provenance.

- **A completed-but-unfinished run no longer reads as "Busy" on the Backlog
  Start button.** It holds the workflow slot until closed, so a start still
  fails — but nothing is running and it will never clear on its own. It now shows
  red **Finish** with the reason, matching the rule that amber resolves itself
  and red waits for you.

### Fixed

- **The fix-task counter no longer shows a fraction that cannot move.** Under the
  monolithic fix builder one agent takes every task in a single pass, so
  `fixTaskIndex` stays at 0 and `completedTasks` stays empty until both jump to N
  at the end — the panel read `Fix 1/7` and `0/7 fix tasks completed` for the
  whole run, then completed. Worse, `Fix 1/7` named a specific task the agent was
  not working on. Monolithic runs now read `7 fixes in one pass`; the sequential
  path keeps its counter, where the count is real.

### Upgrade steps

**In Build Studio** — hub and project-server both changed: `cd packages/hub &&
npx next build`, then `cd packages/desktop && node inject-resources.js`. Restart
the app **and the project-servers** — `needsAttention` and the precedence change
are server-side.

**In each managed project** — nothing to do. But **check your agent cards after
the first run**: if a step was previously running a preset's model, it will now
run whatever the Agents tab says. That is the intended fix, and it may be a
stronger and more expensive model than before. To pin a step regardless of the
slot, set it in that project's `config.yaml` under `step_models` — project
entries still win.

## 2026-07-28 — Start a run from the Backlog tab

### Added

- **A Start button on every backlog row**, so a run can be kicked off from the
  item instead of retyping its id into the Workflow tab. The run type is derived
  from the item, mirroring the server's own start guardrails:

  | Item | Status | Starts |
  | --- | --- | --- |
  | Bug | `Backlog` or `Blocked` | `bugfix` |
  | Feature / Task | `Drafted` | `review` |
  | Feature / Task | `Reviewed` | `execution` |

  Anything else hides the button rather than offering a click that would 409.
  Run options are fixed per type, matching how these are run in practice:
  review goes out auto-advance + strict, execution and bugfix go out
  auto-advance + skip-demo-review.

- **`GET /workflow/start-readiness`** — reports `activeWorkflow`, `branch`,
  `onDefaultBranch` and `dirty`, so the button can show *why* it is blocked
  before the click. Read-only; it runs the same git reads the start guardrail
  does. The server remains authoritative — this only avoids offering a
  click that would be rejected.

  The two blocked states are coloured differently on purpose, because they ask
  different things of you: **amber "Busy"** (a run is already active) clears by
  itself when that run ends; **red "Blocked"** (uncommitted changes, or not on
  the default branch) waits for you to commit, stash, or switch back. A dirty
  tree blocks execution and bugfix only — review creates no branch and commits
  to the default branch, so it runs fine alongside uncommitted drafts, exactly
  as the server guardrail allows.

### Upgrade steps

**In Build Studio** — hub and project-server both changed, so a full inject, not
`--sync-only`: `cd packages/hub && npx next build`, then
`cd packages/desktop && node inject-resources.js`. Restart the app, and restart
the project-servers too — the readiness endpoint is server-side.

**In each managed project** — nothing to do.

## 2026-07-28 — Auto-advance no longer walks past a dead step

### Fixed

- **Opening the app could advance a workflow past a step whose agents all died,
  marking unreviewed work `completed` and merging it.** Auto-advance is
  implemented twice — a server-side tick and a client-side loop in
  `workflow-view.tsx` that runs whenever the workflow view is mounted. Only the
  server had the guard for a step where every agent errored with no feedback; the
  client counted `status: 'error'` as done, found no blocking verdict (there was
  no feedback at all to find one in), and approved the step forward. The server
  would halt and stash `step.autoAdvanceError`, and the next time anyone opened
  the app the client walked straight past it.

  Seen on fazon `faz-197`: a Codex reviewer died three seconds in on an MCP
  authorization error, the server correctly halted for seven hours, and opening
  the app advanced `code_review` through `merge_to_main` — merging five fix
  commits whose round-2 review never ran. The client now mirrors the server's
  guard. Note the guard is deliberately narrow: a step where *some* agents
  reported still advances on those reports; only a step where *nothing* reported
  is treated as dead.

### Known issues

- **Auto-advance still exists in two places.** This fix brings the client back in
  line, but two implementations of one policy will drift again. The durable fix
  is to delete the client loop and let the server tick own advancement.

### Upgrade steps

**In Build Studio** — hub-only change: `cd packages/hub && npx next build`, then
`cd packages/desktop && node inject-resources.js`, then restart the app. The
project-servers can keep running; the guard is client-side.

**In each managed project** — nothing to do. But if a workflow of yours ever
advanced past a step whose agents all died, its later steps ran on unreviewed
work — worth checking any run that reported success while an agent shows
`status: error`.

## 2026-07-27 — Next.js 16.2.12 (nine advisories)

### Fixed

- **`next` 16.2.10 → 16.2.12**, closing nine advisories published that day — four
  high, five medium. They cover SSRF in rewrites and in Server Actions on custom
  servers, a middleware/proxy bypass, unauthenticated disclosure of internal
  Server Function endpoints, denial of service in Server Actions and in the image
  optimization API via SVG, and two cache-confusion issues. All are fixed in
  16.2.11; `packages/hub/package.json` already declared `^16`, so this needed no
  override. Most require network reach to the hub, which the loopback change
  above independently limits to the local machine.
- **`postcss` override tightened to `^8.5.18`** (top-level resolves to 8.5.23).
  The previous `^8.5.10` still permitted 8.5.10–8.5.17, which are vulnerable to a
  path traversal in source-map auto-loading.

### Known issues

- **`next` bundles its own `postcss` 8.4.31**, which is vulnerable to the three
  postcss advisories. `next` pins that version exactly, and unlike 16.2.10 it no
  longer dedupes to the root override — `npm dedupe`, a tightened range, and a
  scoped `next: { postcss }` override all failed to collapse it, so no override
  is left in place pretending to fix it. It is build-time only: `postcss` appears
  in neither the standalone build output nor the shipped `.app`, it processes
  only this repo's own stylesheets during `next build`, and all three advisories
  require attacker-controlled CSS. Expected to resolve when `next` bumps its pin.

### Upgrade steps

**In Build Studio** — `npm install` to pick up the lockfile change, then rebuild
and inject. A Next version change lives in the standalone bundle, so this needs
the full `node inject-resources.js`, not `--sync-only`.

**In each managed project** — nothing to do.

## 2026-07-27 — Security: bind to loopback, patch `fast-uri`

### Added

- **`SECURITY.md`** — private vulnerability reporting (enabled on the repo), plus
  an explicit scope: what counts as a vulnerability versus what follows from the
  design. The unauthenticated local API on its loopback binding and agents
  executing code are deliberate; escaping those boundaries is not.
- **A "Security & intended use" section in the README**, above the install
  instructions. Build Studio is a local single-developer tool, not hardened for
  shared or production environments, and it runs AI agents that execute code —
  worth knowing before the first run rather than after.
- **`license: "Apache-2.0"` in every `package.json`.** The repo has always been
  Apache-2.0 via `LICENSE` and `NOTICE`, but the package metadata declared no
  licence at all, which is the kind of inconsistency that matters for anyone
  consuming or redistributing the packages.

### Fixed

- **The hub and every project-server listened on all network interfaces.** The
  hub set `HOSTNAME: '0.0.0.0'` explicitly and project-server called
  `server.listen(port)` with no host, which Node defaults to `0.0.0.0`. On any
  shared network — café, coworking space, hotel, client office — anyone could
  reach the dashboard and every project-server API, none of which require
  authentication: they start and stop workflows, write project config, read
  project files, and proxy tmux sessions. The only client is the Electron app on
  the same machine, over `localhost`, so nothing was gained by binding wide.
  Both now bind `127.0.0.1`. `next dev` was doing the same in dev mode and is now
  pinned too.

  Set `BUILD_STUDIO_LISTEN_HOST=0.0.0.0` to opt back in deliberately — e.g. to
  reach the hub from a phone on the same network. Treat that as exposing an
  unauthenticated API, and prefer an SSH tunnel where you can.

- **`fast-uri` bumped to 3.1.4** (CVE-2026-16221, GHSA-v2hh-gcrm-f6hx, CVSS 7.5)
  via a root `overrides` entry. It arrives through
  `electron-builder → app-builder-lib → ajv`, all build-time, so the vulnerable
  code never shipped in the app — but the patch is within `ajv`'s declared
  `^3.0.1` range, so there is no reason not to take it.

### Known issues

- **`sharp` 0.34.5 (GHSA-f88m-g3jw-g9cj) is still present**, pulled in by
  `next@16.2.10`. The libvips CVEs require processing untrusted image input, and
  no such path exists today: `images.remotePatterns` is unset so every remote URL
  is rejected, the only same-origin sources are repo-shipped files under
  `public/` and the `/avatars/[...path]` route (locked to
  `^\d+\/[\w-]+\.png$` with a traversal guard), and nothing in the app accepts an
  image upload. There is no clean fix yet — even `next@16.2.12` pins
  `sharp: ^0.34.5`, so the first patched release (0.35.0) is outside the range
  Next declares. **Re-evaluate before adding any image upload, any
  user-supplied avatar, or an `images.remotePatterns` entry.**

### Upgrade steps

**In Build Studio** — `npm install` for the `fast-uri` override, then rebuild and
inject. **Restart the project-servers, not just the app** — the loopback bind is
project-server code, so any server left running from before stays on `0.0.0.0`
and the fix appears not to have worked. Confirm with:

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(18080|300[0-9])'
```

Every line should read `127.0.0.1`, not `*`.

**In each managed project** — nothing to do. But if you have been running Build
Studio on untrusted networks, note that the dashboard and every project-server
API were reachable by anyone on that network, unauthenticated, until this change.

## 2026-07-27 — Demo recorder: output folder, narration, signature re-seal

### Added

- **The demo recordings folder is configurable** from the Demos tab. Precedence:
  `DEMO_RECORDINGS_DIR` env → your setting → a folder next to your managed
  projects → `~/Movies/build-studio-demos`. The panel shows which tier won, and
  goes read-only when the env var overrides. Backed by
  `GET`/`PUT /api/demos/settings`, which writes `demoRecordingsDir` into
  `~/.build-studio/config.json`.

### Fixed

- **Narration was dropped from rendered demos.** The EDL render passed `-an`, so
  microphone audio on manual segments never reached the output. Segments with an
  audio stream now keep it, speed-matched to the video via an `atempo` chain
  (ffmpeg clamps `atempo` to 0.5–2.0, so larger factors chain), and silent
  clips — automation timelapses have no audio — are padded with `anullsrc` so
  everything concatenates uniformly.
- **Injecting into the `.app` broke its code signature and silently revoked
  Screen Recording.** Writing files into an already-signed bundle invalidates the
  sealed-resource hashes; macOS then treats the app as tampered and drops its TCC
  grants, so `desktopCapturer` fails with "Failed to get sources".
  `inject-resources.js` now re-seals after every inject, auto-detecting an Apple
  Development identity (override with `BUILD_STUDIO_SIGN_IDENTITY`) and falling
  back to ad-hoc signing. Added `NSScreenCaptureUsageDescription` so the prompt
  explains itself.
- **The recorder and the hub resolved the recordings folder with two separate
  copies of the same logic**, which could drift and have the recorder write where
  the hub does not look. Both now call
  `@build-studio/shared/demo-recordings`.

### Upgrade steps

**In Build Studio** — **re-grant Screen Recording once** if you injected before
this landed: macOS may still hold a revoked grant for the tampered bundle.
System Settings → Privacy & Security → Screen Recording, toggle Build Studio off
and on, then restart the app. With a cert-signed build the grant is keyed to the
designated requirement, so it survives all later rebuilds; an ad-hoc fallback
needs a re-grant after each rebuild.

**In each managed project** — nothing to do.

Existing recordings are unaffected: the default resolution order is unchanged,
so a folder that resolved before still resolves the same way.

## 2026-07-27 — Model catalog auto-discovery, uniform role slots

Claude model list auto-discovery, uniform role slots, and per-step overrides
that reach every CLI.

### Added

- **Claude models are discovered from models.dev** instead of a hand-maintained
  list — the same source that already backed the Codex and OpenCode pickers. New
  Anthropic releases appear without a code change. `[1m]` variants are
  synthesized only for models whose context window is actually 1M, so Haiku 4.5
  and Opus 4.1/4.5 correctly don't get one.
- **Per-model Claude effort options**, read from models.dev `reasoning_options`.
  Replaces the static ladder plus a `model.startsWith('opus')` heuristic that
  stripped `xhigh` from Fable. Where models.dev has no entry the documented
  ladder is still offered — its Anthropic coverage is partial (`claude-sonnet-5`
  reports none despite supporting the full range), and hiding a real control is
  worse than offering one the CLI ignores.
- **`step_models` / `step_efforts` accept a per-CLI map**, so a step can pin a
  model on any CLI rather than Claude alone:

  ```yaml
  step_models:
    code_review:
      claude: sonnet5
      codex: gpt-5.6-sol
      opencode: openrouter/moonshotai/kimi-k3
  ```

- `buildCliFlags(cli, model, effort)` in `@build-studio/shared/cli` — the single
  place mapping a resolved triple to command-line fragments, now used by both the
  pure resolver and the workflow launcher.

### Changed

Behaviour that shifts on an unmodified config:

- **The Reviewer slot applies in every workflow type**, not just `execution`.
  Reviewers in bugfix / review / kickoff / demo_review runs now follow
  `reviewer_cli` / `reviewer_model` / `reviewer_effort` instead of the Default
  slot. The legacy per-run `wf.reviewerCli` knob stays execution-scoped so
  in-flight runs keep their assignment.
- **`Final Reviewer` follows the Reviewer slot** (was the Default slot).
- **`developer_model` / `developer_effort` inherit the Default slot when unset**,
  matching the Reviewer slot. Previously an unset Developer model meant "let the
  CLI pick its own default" — if that was deliberate, pin the Developer row
  explicitly to restore it.
- **`step_efforts` and `agent_defaults.effort` apply to every CLI.** The token
  vocabulary is shared (`claude --effort`, `codex model_reasoning_effort`,
  `opencode --variant`), so these were Claude-only by accident. Note not every
  model accepts every level — older Codex models stop at `high`; use a per-CLI
  map to narrow. `step_models` values stay Claude-only in their bare string form
  by design, because those are Claude short names.
- **One-shot and run-task agents change model.** `lib/oneshot.js` and
  `lib/api/run.js` each carried a private map pinned to `claude-opus-4-6` /
  `claude-sonnet-4-6`; both now use the shared `MODEL_IDS`, so those paths move
  to whatever `opus` / `sonnet` resolve to (currently Opus 4.8 / Sonnet 5).
- **The Claude picker lists CLI aliases plus full model ids** (`claude-opus-5`,
  `claude-sonnet-5[1m]`). Version-pinned legacy keys (`opus4.7`, `sonnet4.6`,
  `sonnet5`, …) still resolve in stored configs but are no longer offered as
  options. Nothing breaks; the spelling in the dropdown changes.
- **Per-project catalog endpoints are backed by the shared `getCatalog`.**
  `/api/opencode/models` and `/api/opencode/model-efforts` no longer hand-roll
  their own fetch, TTL and stale-fallback logic; they share one
  `.build-studio/cli-catalog-cache.json` instead of two separate files.
- `opus` still resolves to Opus 4.8 — deliberately **not** promoted to Opus 5,
  which is selectable explicitly as `claude-opus-5`.

### Fixed

- **A catalog cache written before a field existed satisfied the TTL check and
  served that field as `undefined` for up to 24h after an upgrade**, which made
  the Claude picker silently fall back to its static list. Cache reads are now
  schema-guarded: a payload missing any currently-read field forces a refetch,
  while still serving as the offline fallback.
- **An inherited Developer/Reviewer CLI rendered identically to an explicitly
  chosen one**, so moving the Default row looked like it silently moved the
  others. Inherited picks now render dashed/outlined, and re-clicking a pinned
  CLI hands the slot back to Default.
- **Per-step overrides never reached Codex or OpenCode agents.** The launcher
  hand-rolled its own flag strings for Claude and reused the shared resolver only
  for the other two, so the step layer existed on one path only.
- **`.gitignore` enumerated cache files by name and missed
  `opencode-model-efforts-cache.json`**, which was committed into managed
  projects. Now a `.build-studio/*-cache.json` glob covering present and future
  cache files.
- Model/effort resolution validates on the way out: a model incompatible with its
  CLI, or an effort that isn't a plain token, yields no flag rather than reaching
  a shell command line.

### Upgrade steps

**In Build Studio**

1. **Rebuild, inject, restart.** Both `hub/` and `project-server/`+`shared/`
   changed, so `--sync-only` is not enough:

   ```bash
   cd packages/hub && npx next build
   cd packages/desktop && node inject-resources.js
   ```

   Then restart the app — **and this time restart the project-servers too.**

   Project-servers are detached `node` processes that deliberately outlive the
   app, so an update can land without interrupting in-flight workflows or their
   tmux sessions; the app re-adopts them on launch. That property is usually what
   you want, but it means a surviving server keeps running the code it started
   with. This change lives in project-server, so any server left running stays
   bound to `0.0.0.0` and the fix looks like it silently failed.

   `inject-resources.js` lists servers on stale code after every run. Either stop
   and start each project from the hub, or:

   ```bash
   node inject-resources.js --restart-projects
   ```

   To confirm nothing is left on the old build:

   ```bash
   lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(18080|300[0-9])'
   ```

2. **Review the `Changed` section above** — several items alter agent behaviour
   without any config edit.

**In each managed project** — run this in every repo Build Studio manages, not
just in Build Studio itself:

1. **Untrack any committed cache file.** This is the one thing that fails
   silently, because the efforts cache was never in the gitignore list, so it was
   committed into managed projects:

   ```bash
   git ls-files '.build-studio/*-cache.json'    # anything listed is tracked
   git rm --cached <anything listed>
   ```

   Re-onboarding adds the `.build-studio/*-cache.json` glob automatically;
   otherwise add it to that project's `.gitignore` by hand.

2. **Delete the two orphaned caches** (optional, ~350KB each). A new
   `.build-studio/cli-catalog-cache.json` replaces
   `opencode-models-cache.json` and `opencode-model-efforts-cache.json`; the old
   two are no longer read.

3. **Nothing to migrate in `config.yaml`.** Bare `step_models` / `step_efforts`
   values keep working unchanged.

The hub's own `~/.build-studio/opencode-catalog-cache.json` needs no action — it
refetches itself on schema mismatch.

### Notes for forks

- `CLAUDE_MODELS` is no longer the picker source; it now serves only as the
  offline fallback. A fork reading it directly will silently get the old static
  list.
- If you add a field to the catalog cache payload, add it to
  `isCurrentCatalogSchema()` too — and never the reverse. A field in the schema
  check that the payload never produces makes every read miss the TTL and refetch
  on every request.
