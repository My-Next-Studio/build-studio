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

## 2026-08-05 — Close the project-server to other browser tabs

### Security

Read this one even if you skip the rest: it changes who could reach your
project-servers, and the answer was wider than the README claimed.

- **The API no longer answers every website you visit.** Each project-server
  sent `Access-Control-Allow-Origin: *`, and it has no authentication of any
  kind. Binding to `127.0.0.1` — which it does — keeps out other *machines*, not
  other *tabs*: any page open in your browser could call
  `http://localhost:<port>/api/...` and read the response. That reaches project
  and PRD file contents, config, git operations, and agent session control. The
  wildcard paired with `Allow-Headers: Content-Type` also cleared the preflight
  for JSON bodies, so writes were reachable too, not only reads.

  The header is now echoed back only for an allow-listed origin — by default the
  hub, `http://localhost:18080` and its `127.0.0.1` spelling. Anything else gets
  no CORS headers and the browser refuses the response. Requests carrying no
  `Origin` at all are still served, because those are non-browser callers (the
  Electron health poll, the overseer's loopback call, `curl`) and were never the
  exposure.

- **The terminal WebSocket now checks its origin.** This is the half that CORS
  could not have fixed. WebSockets are exempt from the same-origin policy, so no
  response header stops a page from opening `ws://localhost:<port>` — and that
  socket hands every client the project's persistent pty and writes whatever it
  sends straight to the shell. Any page you visited could open an interactive
  shell as you, in your project directory. The handshake is now rejected with
  403 unless the origin is allow-listed.

  Had only the CORS half shipped, the boundary would have looked closed while
  the more direct path stayed open — which is why both landed together.

- **File routes no longer accept a sibling directory whose name extends the
  allowed one.** `files.js`, `status.js` and `runbooks.js` each checked
  containment with `abs.startsWith(base)`, which is a string test, not a path
  test: with `docs/` allowed, `docs-private/secret.md` passes it, because the
  characters do in fact match. A `path-guard.js` helper that gets this right has
  been in the tree — and tested against precisely this — since it was written;
  it was simply never wired into these four call sites. It is now.

  The `/chat` route is the one to notice. It writes nothing, but whatever it
  reads is pasted into the model's system prompt and streamed back, so an
  escape there was a way to read a file out through the response.

- **The document-write route stops accepting paths that end in code
  execution.** `PUT /api/file` checked only that the target was somewhere under
  the project — and carried none of the directory or file-type limits its
  read-side twin had. Writing `.git/hooks/pre-commit` was therefore allowed by
  the guard behaving exactly as designed, and ran as you on that repository's
  next commit. Writes are now confined to `.md`/`.markdown`/`.txt`, outside a
  blocked set of directories.

- **Sensitive directories are matched per path segment, not by string prefix.**
  The old `/^(\.git|node_modules|dist|\.next|\.env)/` test was wrong in both
  directions: it refused `.github/` for merely starting with `.git`, and it only
  ever examined the first segment, so `docs/.git/config` walked straight past
  it. Matching segments also let the list grow to the things that actually
  decide behaviour — `.github/` (runs in CI), `.claude/` (steers future agents),
  `.build-studio/` (ports and model selection), and `.env.*` variants.

- **Widening is possible, but now deliberate.** Set
  `BUILD_STUDIO_ALLOWED_ORIGINS` to a comma-separated list to replace the
  default allowlist, mirroring how `BUILD_STUDIO_LISTEN_HOST` works. A literal
  `*` in that variable is treated as an origin named `*` and matches nothing —
  the old behaviour cannot be restored by accident.

No evidence any of this was exploited; it is reachable-in-principle, found by
review, not by an incident.

### Added

- **A Rebase button on the CI/CD tab**, shown only when your branch is behind
  its remote. Merging a Dependabot PR on github.com — which the Monitor tab now
  actively encourages, one advisory at a time — moves the remote and leaves your
  local branch behind, so the next Push from this tab is rejected as
  non-fast-forward. The remedy was always a terminal away; the point is not to
  need a terminal in the middle of a flow that otherwise happens here.

  It appears directly above Push, because it is the step that unblocks it. What
  it does:

  - Fetches first, then rebases your branch onto the ref a push would update —
    the branch's own upstream, or the remote's default branch.
  - **Stashes and restores uncommitted work** (`--autostash`), so edits in
    flight are not a reason to be sent away.
  - **On conflict, aborts and puts everything back**, reporting which files
    clashed. Nothing is left half-done, and you choose whether to resolve it
    yourself or hand it to an agent.
  - **Refuses to act if a rebase is already in progress.** It will not abort a
    rebase it did not start — that is somebody's half-finished conflict
    resolution, and it is not this button's to discard. The refusal names
    `git rebase --abort`, because you can land in that state without having done
    anything: stopping or redeploying a project-server kills the `git` child
    along with it, parking the repository mid-rebase.

  A rebase can succeed and still leave you work: restoring the stash can itself
  conflict. That case is reported as a warning rather than a success, because
  "rebased 3 commits" over a conflicted working tree is how a broken tree gets
  pushed. A zero exit status is likewise not taken as proof the rebase finished
  — the route re-checks for a parked rebase afterwards and says so plainly.

  **Do not stop or redeploy a project-server while a rebase is running.** The
  `git` process is a child of that server and dies with it, leaving the
  repository parked mid-rebase — clean working tree, no conflict, but detached.
  `git rebase --abort` restores it and loses nothing. This is worth knowing
  because the symptom reads like a conflict and is not one.

- **Advisory rows now say what they need from you.** Previously a row you could
  clear by merging a waiting PR looked identical to one needing an afternoon's
  judgement, so a long list was untriageable and the honest response was to stop
  opening it. Each advisory now carries one of:

  - **merge** — Dependabot has a fix PR open and it is not a major. The row
    links to the PR rather than the advisory, because the PR is the action.
  - **major — review** — a PR exists, but a green build is not sufficient
    evidence to merge a major.
  - **pinned — decide** — a patched version exists upstream and no PR appeared,
    which almost always means a transitive pin. A decision, not a merge.
  - **no fix yet** — nothing to take.
  - **updates off** — security updates are disabled, so no PR was ever
    attempted and nothing can be concluded until they are on.

  Within a severity, rows needing a decision sort above rows you can merge, and
  the header splits the count — "18 ready to merge · 3 need a decision" rather
  than "21 open".

- **A row for "alerts are on but nothing acts on them."** A repository can see
  advisories and have no mechanism to fix them, which is how thirteen piled up
  on one project here when nine needed only a version bump. That state is now
  reported rather than left to be inferred from a list that quietly grows.

### Changed

- **"pinned — decide" is split into a fix you can run and a wait you cannot.**
  That one badge was covering two situations with opposite answers, and the
  common one was not a decision at all:

  - **run one command** — a fix is reachable without a breaking change. The row
    prints the exact command (`npm audit fix`, or a `uv lock --upgrade-package`
    for Python).
  - **breaking bump — review** — a fix exists, but only by moving a parent
    across a major version. A real decision, and the row names which parent and
    to what version.
  - **blocked upstream** — no fix is reachable at all until someone upstream
    ships a release.
  - **no PR — decide** — the honest remainder: a patch exists, no PR appeared,
    and we could not determine which of the above applies. This is the old
    behaviour, now confined to the cases that earn it.

  **For npm the verdict comes from `npm audit`, not from reading the lockfile.**
  That distinction is the whole feature. Asking "does every current parent
  permit the patched version" gets the wrong answer whenever the fix arrives by
  updating an *ancestor*: `miniflare` pins `undici` to an exact version, but
  `miniflare` comes in via `wrangler`, and a wrangler within the range already
  in your `package.json` ships a miniflare carrying the patch. Reading the
  lockfile sees a hard pin and reports a dead end; npm sees a one-command fix.
  Every "blocked upstream" row on this installation was of that shape.

  The lockfile analysis is kept only for the direction it is still sound in — if
  every current parent already permits the patch, regenerating really does fix
  it — and is consulted only when `npm audit` is unavailable. Its "blocked"
  answer is no longer trusted at all.

  Measured here, every advisory previously filed under "pinned — decide" turned
  out to be clearable: 15 npm ones with a single `npm audit fix`, and a
  `cryptography>=42.0` whose lockfile simply pinned an older build. Demanding
  judgement where the answer is one command is how a list teaches you to stop
  opening it.

  **The analysis refuses to guess.** An ecosystem it has no reader for (only npm
  and pip today), an unreadable manifest, an `npm audit` entry that does not
  mention the specific advisory — each falls back to the vaguer label rather
  than asserting something wrong. A false "run one command" costs you a command
  that does nothing; a false "blocked upstream" hides a fix, which is worse.
  Saying *"I could not tell"* is cheaper than either.

  Sorting changed with it: **blocked upstream now sorts last**, below even "no
  fix yet". It is the one row that re-reading cannot change, and it is excluded
  from the "needs a decision" count — a number that stays non-zero no matter
  what you do is a number you stop believing.

- **Build Studio now runs `git fetch` on your projects.** It never did before,
  which meant the CI/CD tab's "behind: N" was only as current as the last time
  *you* fetched in a terminal. Two managed projects here were displaying
  **behind: 0** while their remotes had genuinely moved on — and that is the
  normal state immediately after merging a PR on github.com, which is exactly
  when the number gets read.

  The fetch is cached with a 60-second TTL and runs in the background off the
  CI/CD tab's poll, so the tab still answers instantly and a corrected count
  appears on the following poll rather than the current one. A repository whose
  fetch fails backs off to five minutes instead of retrying every poll.

  `git fetch` only updates remote-tracking refs — it does not touch your branch,
  your working tree, or your stash. But it is network traffic against your
  projects' remotes that did not happen before, so it is worth knowing about if
  you work offline or on a metered connection.

  Hovering "behind" now tells you when origin was last checked, so a zero can be
  told apart from a zero nobody has verified since yesterday.

- **The back button from a project now reads "← home", not "← projects".** The
  cross-project view holds four tabs — Projects, Demos, Model, Monitor — so
  labelling the container after one of its own children read as a loop: you
  clicked "projects" and landed somewhere whose first tab was also Projects.

  "Home" names the view's position rather than its contents, which is what
  "projects" got wrong and what any contents-based name would get wrong again
  the next time a tab is added. It also matches what the source has always
  called it (`home-tabs.tsx`, `HomeContent`, `HomePage`).

- **Enabling dependency alerts also enables security updates.** The button on a
  not-enabled row now switches on both. Enabling sight without action is the
  trap the row exists to close — turning on alerts alone produces a repo that
  watches advisories accumulate.

### Fixed

- **Push on a detached HEAD said "fatal: invalid refspec ''".** `git branch
  --show-current` is empty when HEAD is detached, and that empty string went
  straight into `git push origin ''`. The message named neither the cause nor
  the cure, and one managed project here hit it.

  The CI/CD tab now says HEAD is detached before you click, disables Push and
  Rebase (neither has a branch to act on), and leads with the part that actually
  matters: **a commit made while detached belongs to no branch**, so it becomes
  unreachable the moment you check one out. The warning gives the command to
  save it first. Detached HEADs are easy to reach by accident — checking out
  `origin/main` directly does it — and the old error gave no hint that anything
  was at risk.

- **The CI light no longer tracks whichever branch pushed last.** CI status
  considered every push run regardless of branch, so a push to a feature branch
  became "the latest run" and the light reported that branch's result. It is now
  scoped to the repository's default branch.

  Latent for most projects today, and it would have become permanent the moment
  Dependabot started opening PRs — those push constantly. The same scoping is
  correct for scheduled-job alerts, since GitHub only runs `schedule` workflows
  on the default branch.

- **Leaving the hub and coming back no longer drops you on Projects.** The home
  view never persisted its tab, so every return from a project reset it — which
  went unnoticed while Projects was where you wanted to be anyway, and became
  obvious as soon as there was a Monitor tab worth returning to. Per-project
  dashboards have persisted their function and tab for a while; home now does
  the same, in `localStorage` under `build-studio:home-tab`.

  A stored tab that no longer exists falls back to Projects rather than
  rendering nothing, and a first launch (`?onboarding=1`) still lands on
  Projects whatever was stored.

- **The Monitor tab no longer says "nothing to handle" before it has looked.**
  Between mount and the first poll returning, an empty list was reported as
  all-clear. It now says "checking…" until it actually knows.

### Upgrade steps

**In Build Studio** — `cd packages/hub && npx next build`, then
`cd packages/desktop && node inject-resources.js`, then restart the app.

**Restart every running project-server** — unlike the rest of this day's
entries, the security fixes live in `project-server/`, so a server that keeps
running keeps serving the wildcard and the old path checks. Stop and start each
one from the hub, or restart the Electron app. Until a given server is
restarted, that project is still reachable from any browser tab.

**In each managed project** — nothing to do.

**If you run the hub somewhere other than `http://localhost:18080`** — set
`BUILD_STUDIO_ALLOWED_ORIGINS` to that origin before restarting, or the hub's
SSE connections and terminals will be refused. The default covers the standard
Electron setup, where nothing is needed.

### Notes for forks

- **New containment guards must go through `assertInside`
  (`lib/path-guard.js`), never `abs.startsWith(base)`.** The latter reads as
  correct and is not. The helper and its tests predate this release; four call
  sites simply never used it, which is most of why this entry exists.
- **`PUT /api/file` is stricter than it was, and has no in-tree caller.**
  Nothing in the hub calls it — which is why the write restrictions could be
  drawn tightly without breaking a screen. If your fork writes through it, the
  limits are: text extensions only, and no path segment in `BLOCKED_SEGMENTS`.
  Widen those constants deliberately rather than removing the guard.
- **`fix-reachability.js` fails closed, and that is the design.** Every function
  returns null the moment it meets a version range, operator or manifest it does
  not confidently understand, and the caller keeps the vaguer label. It carries
  no semver dependency for the same reason — a hand-checked narrow grammar that
  opts out loudly is safer here than a broad one that always answers. If you add
  an ecosystem, preserve that: return null rather than a plausible guess.

- **Ask the package manager before reading its lockfile.** The npm path went the
  other way first and was wrong on every row: reading the lockfile answers "can
  the patch be installed given the parents' *current* versions", when the
  question is "given their *allowed* versions" — and the two differ exactly when
  the fix comes from bumping an ancestor. `npm audit --json` answers the real
  question with the registry behind it. If you add an ecosystem, look for its
  equivalent (`pip-audit`, `cargo audit`) before writing range arithmetic.

- **`npm audit --json` exits non-zero whenever it finds anything**, which is the
  only case it is ever called in — read the report off the rejected exec's
  stdout, not from a success path that will never run.

- **The CORS allowlist and the WebSocket check must stay in step.** They read
  the same allowlist from `lib/allowed-origins.js` on purpose. If you add an
  origin for one, you have added it for the other — and if you relax only the
  CORS half, you have reopened nothing, while relaxing only the WebSocket half
  reopens everything, since that socket is a shell.

---

## 2026-08-04 — A Monitor tab, and CI that tells you when it breaks

Two monitoring gaps closed together, because both came down to the same missing
piece: nothing polled GitHub unless you already had the right tab open. You
could not be told about a failure you were not already watching.

### Added

- **A Monitor tab** on the home view, beside Projects / Demos / Model. It lists
  cross-project conditions that nobody triggered and that can go red days after
  your last commit: scheduled workflows whose latest run failed, and open
  dependency advisories. Grouped worst-first, since that is how a morning triage
  actually reads.

  Nothing is stored. Every row is derived on each poll, so an alert is visible
  exactly as long as its condition holds — fix the advisory, or let the nightly
  job go green, and the row disappears on its own. There is no dismiss button by
  design: a stored acknowledgement drifts, and a Monitor tab still showing a
  vulnerability that was patched last week is one you learn to ignore.

- **Desktop notifications on CI failure and recovery.** Push, go do something
  else, and the app tells you when the run turns red — and again when it goes
  back to green, so you do not have to check to learn a fix landed. They fire
  from the Electron main process, so they arrive with the app in the background.

  Notifications are for *transitions*, never conditions: an unchanged red run
  never re-announces itself, and the first poll after launch only establishes a
  baseline. Otherwise every start-up would greet you with alarms about failures
  that may be a week old.

- **A red CI pulse** on the CI/CD tab, the function that owns it, and the
  project button in the status bar. It shares the existing pulse mechanic but
  not its colour — orange still means one thing only, "a human is blocking the
  machine, go unblock it", and that signal was worth protecting.

### Changed

- **The CI light now tracks your push CI, not whichever workflow ran most
  recently.** With no `deployment.ci_workflow` configured, CI status came from
  the single most recent run of *any* workflow — so on a project whose most
  frequent runs are nightly cron jobs, the CI/CD tab reported the cron's result.
  One managed project here showed a red CI light for a failing staleness gate
  while its actual push CI was green the whole time.

  CI now considers only `push` and `workflow_dispatch` runs. **If a project's CI
  light changes colour after this update, the new colour is the correct one** —
  and the scheduled job it used to be showing you has moved to the Monitor tab,
  where it belongs. Nothing to configure; `ci_workflow` still narrows the light
  if you have set it.

- **`deployment.ci_workflow` accepts a filename, a path, or the workflow's
  display name.** All three now resolve: `deploy-pages.yml`,
  `.github/workflows/deploy-pages.yml`, or `Deploy Pages`. Previously the value
  was handed straight to `gh run list --workflow`, which accepts the first two
  but not reliably the third; the value is now mapped through the repository's
  real workflow list before anything is filtered.

  Worth knowing because the two spellings are not derivable from each other — a
  workflow displayed as "Deploy to Pages" can live in `deploy-pages.yml` — so if
  you ever saw a blank CI light on a project with `ci_workflow` set, a mismatch
  between the two was the likely cause and is no longer possible.

- **`GET /api/deployment/ci-status` is served from cache.** It used to shell out
  to `gh` twice, synchronously, on every request. That was survivable while it
  only ran with the CI/CD tab open; now that CI state feeds the tab selector,
  the status bar and notifications, it is read continuously across every
  project. GitHub is queried on a backoff — fast while a run is in flight,
  every five minutes when nothing is happening — and one `gh run list` serves
  both the CI light and the Monitor tab's scheduled alerts.

  Projects without `deployment.repo` make no GitHub calls at all.

### Known issues

- **Dependency alerts start out enabled on very few repositories.** A repo
  without them returns a 403 and shows an *"alerts are not enabled"* row on the
  Monitor tab instead of advisories. That row is information rather than an
  error, and carries an **enable** button that turns the feature on through the
  same `gh` credential Monitor already uses.

  The button exists because linking to GitHub's settings page is a trap on a
  **private** repository: GitHub answers an unauthenticated request with 404
  rather than a sign-in prompt — it will not confirm the repo exists — so a
  browser session that is not signed in looks exactly like a dead link. Doing it
  server-side removes the browser, and the question of which browser profile
  answered, from the loop.

  If you debug that 403, ignore `gh`'s advice that it *"needs the
  `admin:repo_hook` scope"*. It is misleading: the same token reads alerts fine
  on the repository where the feature is on. The scope is not the problem.

- **A scheduled job is reported on its first failure**, at moderate severity,
  escalating to high once it has failed twice running. One failure may be flaky
  infrastructure — but suppressing it hides a real break for a full day, since
  the next data point is 24 hours away. If that proves noisy, the threshold is
  the thing to change.

### Upgrade steps

**In Build Studio** — full rebuild, since both hub and project-server changed:
`cd packages/hub && npx next build`, then
`cd packages/desktop && node inject-resources.js`, then restart the app *and*
the project-servers (the cached poller lives in the project-server).

If you are pulling this day and 2026-08-05 together — which is likely, as they
were published in one go — do the 2026-08-05 steps instead. They are the same
rebuild plus a mandatory project-server restart, and they cover this section.

macOS will ask permission the first time a notification fires.

**In each managed project** — nothing to do, but two things are worth knowing.
A project needs `deployment.repo` in `.build-studio/config.yaml` to appear on
Monitor at all; that is already set on the projects with CI. And dependency
advisories need Dependabot alerts enabled on the repository — see Known issues.

### Notes for forks

- **Alerts are derived, never stored, and that is load-bearing.** The auto-clear
  behaviour is not a feature that was built; it is what you get by keeping no
  state. If you add a source, make it queryable for its current condition rather
  than a fire-and-forget event, or you will need reconciliation logic that
  drifts. If you add acknowledgement, key it on a stable per-alert identity
  (GitHub's Dependabot `number`, never the package name) — keying on the
  package means acknowledging one advisory silently swallows the next one for
  that dependency, which is the one you most want to see.

- **New API surface.** On each project-server: `GET /api/monitor/alerts`,
  `GET /api/monitor/summary`, `POST /api/monitor/enable-alerts`. On the hub:
  `GET /api/monitor` (fans out across projects) and
  `POST /api/monitor/enable-alerts`. `GET /api/global-status` gained `ci` and
  `alerts` fields on each project — both optional and independently fetched, so
  a monitor failure cannot cost you the workflow status that route existed for.

- **Never poll GitHub from a UI cadence.** `lib/github-cache.js` exists so the
  hub can poll every 6 seconds while GitHub is queried once per TTL. Reading
  `gh` directly from a route puts a subprocess on every request, and once that
  route feeds a status bar rather than a single open tab, it is a continuous
  stream of authenticated calls against the same credential the push button and
  the CI-investigate agent depend on.

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

- **An agent that exits after committing is no longer reported as "stalled",
  and its work can be recovered.** Two gaps, both hit by the same run.

  The idle watchdog reported every silent agent as *"Stalled — may be stuck,
  waiting for input, or context exhausted"*. For a CLI with no resumable session
  (codex, opencode) that is systematically wrong: the dead-process check is
  deliberately downgraded for those, because the shell-pane heuristic false-fired
  on a healthy agent at two minutes — but the downgrade only means "not
  confident enough to auto-resume", not "alive". Observed on an agent that had
  committed 557 lines of tests and quit a quarter of an hour earlier. At the
  15-minute mark the pane is re-read, and an exited process is now named as one.

  Recovery previously required a Claude transcript, so those same CLIs had no
  route back at all. Where no transcript exists, Build Studio now reconstructs a
  report **from the commits** — and is careful about the difference. It is
  labelled `RECONSTRUCTED, not agent-authored`, states that it describes what is
  on disk rather than a conclusion the agent reached, raises any uncommitted
  leftovers as a caveat that the agent may have stopped mid-task, and closes by
  naming what it does *not* assert: correctness, completeness, or whether
  anything passes. The step's own gate still does the real validating.

  The agent's own words are always preferred when they survive; the git
  reconstruction is the weaker fallback and the UI says which one you are about
  to file.

- **A CI investigation survives leaving the CI/CD tab.** The run id lived only
  in the browser tab that started it, so navigating away and back discarded the
  only handle to a running investigation — the DevOps agent carried on, wrote
  its proposal, and nothing could ever surface it. The tab now rediscovers an
  investigation on mount via `GET /deployment/ci-investigate/active`, resuming
  the poll if it is still running or showing the proposal if it finished while
  you were elsewhere.

  Resolution deliberately does not trust the in-memory run record, which is the
  weakest of the three signals because it dies with the server. The **proposal
  file and the working tree** are durable, so a finished investigation is
  recoverable even when the run that produced it has been forgotten — which is
  precisely the case worth recovering. A run that vanished leaving no proposal
  reports itself as lost rather than spinning forever.

  Accepting or dismissing a fix now clears the record, so a proposal you have
  already dealt with stops re-appearing.

- **The CI/CD DevOps card no longer clips its own buttons.** The card was capped
  at 560px with `overflow: hidden` while the column holding Commit, Push and the
  deploy targets refused to shrink. A long target label — "iOS → App Store
  metadata (fastlane deliver)" — therefore pushed past the card edge and was cut
  off, and the info column beside it collapsed toward zero width, wrapping
  "versioning: semver" over the deploy descriptions. The card now uses the
  width available to it, matching the CI Health / Changelog / Working Tree
  sections below, and long labels wrap instead of setting the column's width.

- **A failing watchdog tick no longer kills the project-server.** The 30-second
  agent watchdog ran with no error handling, so any throw inside it became an
  uncaught exception and exited the process — the project simply disappeared
  from the hub, offering "Start server" with no indication why, while its agents
  carried on in tmux. The watchdog is advisory; it decides whether to nudge a
  stalled agent, and it must never be able to take down the server it watches.
  A failing tick is now logged and skipped.

- **A usage-limit block is now recognised as waiting, and resumes itself.** An
  agent parked on a provider usage limit looks exactly like a stalled one to an
  idle timeout — no output either way — and was reported as *"Stalled — no log
  activity for 15 minutes … may be stuck, crashed, or context exhausted"*. It
  was neither stuck nor crashed: the processes sat alive at their prompts, and
  the notice they printed says precisely when they resolve:

  ```
  You've hit your session limit · resets 10am (Europe/Stockholm)
  ```

  That notice is now read, the agent is marked **blocked** rather than errored,
  the Workflow tab shows *"N agents are waiting on the usage limit — resuming
  automatically at 10:00"*, and the run resumes on its own once the reset lands.
  Capped at three attempts per block, so a limit that keeps re-blocking surfaces
  instead of being hammered the moment each reset arrives. Nothing to click; the
  live terminal still works if you would rather push them along.

  The detection reads the **pane**, not the log tail: an idle TUI keeps
  repainting, so the notice ends up far back in the file — measured 140 KB of
  redraw after it in a real agent log, which any fixed tail would miss.

  Not marking these agents `error` is the load-bearing half, and it is what the
  next two entries are about.

- **Silence from a reviewer is no longer read as consent.** A reviewer that
  errored *without reporting* has not said "no objection" — it has said nothing.
  `error` counted as a terminal state, so when one reviewer returned and
  approved while five others were blocked, the round advanced on that single
  verdict, ran companion specs, and completed the run with five reviews missing.
  An approve now refuses while any reviewer failed without reporting, naming
  them, and takes an explicit `override` for the case where one is genuinely
  never coming back.

- **Feedback can no longer be filed against a step it was not written for.**
  Reports are matched to an agent by role *within the current step*, so a review
  arriving after the run moved on landed on whatever same-named agent now sat
  there. Four PRD reviews were recorded as companion-spec deliverables that way,
  marking that step complete without a single spec being written — the item
  reached `Reviewed` with all four Required specs missing from disk. Agents now
  stamp the step they were launched for into their feedback call, and a mismatch
  is refused with an explanation rather than misfiled. The content stays in the
  agent's transcript, where the recovery path can deliver it deliberately.

- **The paid-LLM test gate now blocks `openrouter.ai`.** It matched the three
  first-party endpoints but not the gateway, which mattered more than the
  omission suggests: one OpenRouter key fronts every model behind it, so a test
  calling it bills exactly like a direct provider call while naming none of the
  hosts the gate knew about. Found on a file that named both OpenRouter and
  Anthropic — the scan flagged the Anthropic line and walked past the OpenRouter
  one directly above it.

- **A step no longer fails to launch when the previous agent's window was the
  last one.** Reaping a finished agent's window (new in this release) ends the
  tmux session if nothing else is open, and tmux shuts the server down
  asynchronously — so a step launched in the same request as the reap could see
  the session alive and then hit `no server running` a moment later. The step
  was left half-started: an errored agent, no process, and a `dead_step` halt.

  Window creation now recovers by re-creating the session, and only when the
  session has genuinely vanished — a failure with the session still standing
  still surfaces. This was a regression introduced by the reaper in this same
  release; if you are pulling both at once you will not have seen it.

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
