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

## 2026-09-28 — AC verification accepts a commit as evidence

### Fixed

- **AC verification blocked with "(no path cited)" on a MANUAL criterion
  that is about a commit.** A criterion such as "the commit message lists
  each change not taken, and why" is evidenced by the commit itself, and the
  verifier checked it with `git log`. The evidence gate only accepted file
  paths, so it treated the row as having no evidence. A MANUAL row may now
  cite `commit <hash>`. The gate accepts it when that commit exists in the
  project's repository, and reports it by hash when it doesn't. Only a hash
  introduced by the word "commit" counts, so a stray hex string such as a
  colour value is never mistaken for one.

### Upgrade steps

**In Build Studio** — project-server only:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

Then restart the project-servers.

**In each managed project** — nothing to do.

---

## 2026-09-27 — Desktop apps can show QA their screens: `features.screenshot_command`

### Added

- **`features.screenshot_command`: the project renders its own screens for
  QA and for the builder.** Visual smoke needs a rendered screen, and Build
  Studio could only get one from a browser (`playwright_cli`) or an iOS
  simulator. A desktop app has neither, so QA declared visual smoke "not
  applicable" and no agent ever looked at a screen it had built. For an
  Electron project that meant layout defects surfaced only when the owner saw
  them. A project can now name a command, with this protocol, run from the
  project root:

  ```
  <command> list                  # one view id per line ("id<TAB>description" allowed)
  <command> <view-id> <out.png>   # render that view to a PNG, exit 0
  ```

  With it set, QA captures every view the PRD adds or changes into
  `docs/pr-evidence/<PRD>/visual/`, opens each PNG, and reports layout defects
  as findings. A command that fails is reported as a gate that could not run,
  not as a defect. Roles that build UI (frontend, fullstack) are told to
  render and inspect their screens before reporting done, and to add a view id
  for any changed screen the harness lacks.

### Upgrade steps

**In Build Studio** — project-server only:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

Then restart the project-servers.

**In each managed project** — nothing, unless it is a desktop app without a
browser or simulator. Such a project writes a capture harness (for Electron,
on Playwright's `_electron`) and sets `features.screenshot_command` in
`.build-studio/config.yaml`.

---

## 2026-09-27 — A QA suite run no longer undoes changes made during it; owner-directed fix rounds

### Fixed

- **Switching auto-advance off while QA's test suite ran turned it back on by
  itself, and any other change made during the run could be reverted too.**
  The server-run suite kept the copy of the workflow it loaded when it started
  and saved that copy on every progress update, which on an iOS suite means
  every few seconds for up to hours. Anything changed in between went back to
  how it was at the start: the auto-advance switch, a relaunch, or a step the
  run had since moved on to. Progress and completion now re-read the current
  workflow before writing. A suite whose step was relaunched or moved on is
  recorded as finished without applying its result or starting a QA agent.

### Added

- **An owner-directed fix round from QA without a QA report.** If you stop a QA
  run on purpose (for example, the suite is moot until a change you want is
  made), `send_to_devs` used to refuse for lack of a QA report, and the only
  way on was to run the suite you had just stopped. It now accepts
  `{"action":"send_to_devs","override":true,"notes":"<what to fix>"}`. The notes
  become what the fix planner works from, the override is logged on the step,
  and the next QA round re-tests as normal. Without both the override and
  non-empty notes, the old refusal stands.

### Upgrade steps

**In Build Studio** — project-server only:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

Then restart the project-servers. A project-server restart stops a suite
that is running at that moment.

**In each managed project** — nothing to do.

---

## 2026-09-26 — A PRD referenced without the docs/ prefix is found

### Fixed

- **"VK-… references a PRD ("prds/PRD-….md") that does not exist on disk" when
  the file was there.** The `prd:` field is resolved from the repository root.
  An agent writing it from inside `docs/` tends to drop the `docs/` prefix, and
  the review then refused to start. When the path as written names nothing,
  Build Studio now also tries it relative to the docs directory, then by file
  name in `docs/prds/`, and takes the first one that exists. A path that
  matches nothing is still reported as missing. The `draft_prd` skill template
  now spells out the expected form (`docs/prds/PRD-042-short-name.md`).

### Upgrade steps

**In Build Studio** — project-server only:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

Then restart the project-servers.

**In each managed project** — nothing required: the resolver accepts both
forms. To give the skill the clearer wording anyway (per project, then commit):

```bash
sed -i '' 's|and its `prd:` field to the new file\.$|and its `prd:` field to the new file'"'"'s path from the repository root, e.g. `docs/prds/PRD-042-short-name.md`.|' .claude/skills/draft_prd/SKILL.md
```

---

## 2026-09-26 — The Publishing tab shows the queue before publishing is switched on

### Added

- **`content_publishing.after_push_command`: start a deploy after a publish.**
  For a project whose push does not deploy (production behind a manual
  `workflow_dispatch`), a scheduled post used to be pushed on time and then wait
  for someone to press Deploy, while the live check raised an alert. The new
  command runs from the project root after a successful push, for example
  `gh workflow run ci.yml --ref main`. It cannot go in `command`: that runs
  before the commit, so a deploy started there would ship the previous commit.
  It receives `BUILD_STUDIO_PUBLISH_ID`, `_SHA` (the pushed commit), `_BRANCH`
  and `_URLS`, and has its own timeout, `after_push_timeout_minutes` (default
  5). If it fails, the post stays published, since it is committed and pushed.
  The tab shows "deploy failed" with the log, and Monitor raises a
  `deploy-failed` alert that says to start the deploy by hand rather than
  publish again.

### Changed

- **Operations → Publishing now appears as soon as `content_publishing` is
  configured, whether it is on or off.** It used to need `enabled: true`, so the
  first time you saw the queue was after flipping the switch, and anything due
  was published within the minute. While off, the tab lists the staged posts
  with the state each would have and an "off" banner. Nothing is published,
  and `Publish now` is disabled. Projects with no `content_publishing` block
  still see no tab.

### Fixed

- **Resuming a paused draft of the same item told the agent to start a new
  one.** A draft ended before its PRD was written, then resumed from the same
  item, opened with "Next: draft a PRD for …". It now says to continue where the
  conversation left off and to re-check any file it had started.

### Upgrade steps

**In Build Studio** — hub and project-server changed:

```bash
cd packages/hub && npx next build
cd packages/desktop && node inject-resources.js
```

Then restart the app and the project-servers.

**In each managed project** — nothing to do.

---

## 2026-09-26 — A PRD renamed mid-run no longer blocks companion specs

### Fixed

- **A review run blocked on "No §10 Companion Specs section found in the PRD"
  when the PRD had one.** The run records its PRD path when it starts. If the
  PRD is renamed while the run is in flight (renumbered after colliding with
  another PRD, say) and the backlog item's `prd:` field is updated, the run
  kept reading the old path, found no file, and reported it as a missing
  section. Every workflow action now follows the backlog item's `prd:` field
  when the recorded file is gone. When there is nothing to follow, the step
  says the file does not exist instead of blaming the PM for a missing table.

### Upgrade steps

**In Build Studio** — project-server only:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

Then restart the project-servers.

**In each managed project** — nothing to do.

---

## 2026-09-26 — A resumed draft is told what changed since the last one

### Added

- **Drafting re-grounds a resumed session on what changed in the project.**
  The drafting conversation is kept across items and cleared by hand, so it can
  be weeks old, and everything it read is a snapshot. When Draft resumes it, the
  opening prompt now lists what changed since that session's previous draft:
  - new entries in the decisions log (`docs/project-state.md` → Key Decisions
    Log);
  - ADRs, PRDs and backlog items that are new or whose status changed, with the
    old status next to the new one, so "Superseded by ADR-…" stands out.

  Edits that leave a document's status unchanged are counted rather than
  listed. The session's own earlier drafts are included but tagged. Only
  committed history counts. A fresh session gets no delta, since it reads
  everything anyway. The delta currently applies only to Claude, the one CLI
  whose drafting sessions resume.

### Upgrade steps

**In Build Studio** — project-server only:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

Then restart the project-servers.

**In each managed project** — nothing to do. Projects that keep ADRs in
`docs/adrs/`, PRDs in `docs/prds/`, backlog items in `docs/backlog/` and a
"Key Decisions Log" table in `docs/project-state.md` get the full delta. Other
layouts get whatever parts match, and nothing breaks.

### Notes for forks

- `lib/draft-delta.js` reads the committed record only (`git log --since`, and
  the tree at the last commit before that time). Keep it that way: uncommitted
  edits are the owner's work in progress, not a change the project has made.

---

## 2026-09-26 — A CI-fix PR carries the fix, not your unpushed commits

### Fixed

- **Accepting a CI fix in PR mode opened a PR containing every unpushed local
  commit, and the fix never reached your local branch.** The fix branch was cut
  from the local HEAD. When local `main` ran ahead of `origin` (the normal state
  if you push rarely), the "fix(ci)" PR carried all of that in-flight work too:
  one real case was 24 commits and 78 files under a one-line title. After the
  PR was squash-merged, local `main` still lacked the fix, and the next rebase
  replayed the local history against a squash of its own early snapshot and
  conflicted. Now the fix is applied on the remote default branch in a
  throwaway worktree and pushed from there, so the PR holds exactly the agent's
  change. The same change is also committed on the local branch, so when the
  squash-merged PR is pulled back a rebase drops it as already applied. A fix
  that only works on top of unpushed commits is refused with a message saying
  so. The working tree is left as it was, and you push first or switch to the
  push strategy.
- **The CI-fix PR title was the agent's whole summary paragraph.** The title is
  now its first sentence, capped at 72 characters. The full summary goes in
  the PR body and commit body.

### Changed

- PR-mode accept runs `git fetch origin` first and opens the PR against the
  remote's default branch (`origin/HEAD`) explicitly.

### Upgrade steps

**In Build Studio** — project-server only:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

Then restart the project-servers.

**In each managed project** — nothing to do. If a project already has a
squash-merged CI-fix PR that swept in local commits, its local branch and
`origin` have diverged. Compare them before rebasing: files identical on both
sides can keep the local version.

---

## 2026-09-24 — Scoped QA runs the right UITest classes, finishes promptly, and moves on after a relaunch

### Fixed

- **A QA run with one failing test sat for up to ten minutes after the last
  test, looking hung.** On any failure xcodebuild collects a simulator
  sysdiagnose (`simctl diagnose`, 600 s timeout) before exiting, at 0% CPU,
  with the results already in the log. The server-run suite now passes
  `-collect-test-diagnostics never`.
- **A relaunched step finished but the run did not move on, with no error.**
  After three refused auto-advances on a step, auto-advance pauses that step.
  Relaunching the step did not lift the pause, so the fresh result was skipped
  silently. Relaunch now clears it, as re-enabling auto-advance already did.
- **QA halted with "the scoped XCUITest step ran 0 tests" when a changed UITest
  file declared classes not named after the file.** QA scoped the run to
  `<UITestTarget>/<file name>`, so a file such as `BasisUITests.swift` holding
  four classes (`TargetsStepUITests`, `EditorUITests`, …) produced a filter
  that matched nothing. xcodebuild reports that as a pass ("Executed 0
  tests"), and the new tests never ran. The class names are now read from the
  file: every class subclassing `XCTestCase`, or a project base class named
  `…TestCase`, is scoped. Base classes themselves are left out, and a file with
  no test class (shared support code) adds nothing.

### Upgrade steps

**In Build Studio** — project-server only:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

Then restart the project-servers.

**In each managed project** — nothing to do.

---

## 2026-09-22 — Approving a QA round cap no longer loops back into fix planning

### Fixed

- **Approving the fix-loop cap after `qa_validation` sent the run back into
  `fix_plan` with the same findings, instead of moving on.** The cap's approve
  delegated to QA's own approve, whose strict gate re-read the round's failing
  test counts and refused. That left the run on a completed `qa_validation`
  step, which auto-advance evaluated from the same stale report and routed to
  `fix_plan` again — no fresh QA run, and a fix planner handed findings it had
  already seen fixed. It either invented "prove it" tasks or, honestly,
  returned none and tripped the 0-task gate. Approving the cap now passes the
  operator override the strict gate expects, and is logged on the step's
  `overrides` as well as `wf.capOverrides`.
- **The 0-task fix-plan gate over-counted findings.** A QA report with
  `Blocking: 7` and `9 failures` was reported as 16 blocking findings. The
  blocking line is the triaged count; the raw failure count is only used when
  there is no blocking line.

### Upgrade steps

**In Build Studio** — project-server only:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

Then restart the project-servers.

**In each managed project** — nothing to do.

### Known issues

- "Another round" at a `qa_validation` cap re-runs QA against HEAD, which is
  the right choice when the last fix round claims green. Approving the cap
  accepts the outstanding findings and does NOT re-run the suite: the branch
  merges on the last fix round's own scoped verification. Pick "Another
  round" when what is missing is proof, not fixes.

---

## 2026-09-21 — Agents no longer leave feedback payload files in the project

### Fixed

- **Untracked files such as `.qa-review-feedback.json` or
  `.tmp-qa-feedback-<prd>.json` appeared in a project's root after a review.**
  An agent whose feedback is long writes the JSON body to a file and posts that
  file — sensible, since inline shell quoting mangles long payloads. Nothing
  told it where to put the file, so it used the project directory and left it
  there. On the default branch that is an untracked file, which blocks the next
  execution run and gets swept into a careless commit. Every agent that reports
  feedback is now told to create the file in the system temp directory and
  delete it after a successful POST. The fix planner's file instruction names
  the same location.

### Upgrade steps

**In Build Studio** — project-server only:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

Then restart the project-servers.

**In each managed project** — delete any leftovers once; they are copies of
feedback the server already recorded:

```bash
git status --short | grep -E '^\?\? \.?[^/]*(feedback|qa-review)[^/]*\.json$'
```

---

## 2026-09-20 — The drafting panel's Close button is now "End draft"

### Changed

- **`Close` on the drafting panel is relabelled `End draft`.** It does what it
  did: exits the drafting agent, keeps the conversation for the next draft to
  resume, and releases the one-draft-at-a-time lock. "Close" read as closing the
  panel, which left it unclear how to get the Draft buttons back. The
  server's refusal message no longer points at the removed `Start fresh` button.

### Upgrade steps

**In Build Studio** — hub and project-server changed:

```bash
cd packages/hub && npx next build
cd packages/desktop && node inject-resources.js
```

Then restart the app and the project-servers.

**In each managed project** — nothing to do.

---

## 2026-09-20 — Scoped QA no longer aborts when a new UITest sits in a subfolder

### Fixed

- **QA halted with "no tests were executed (0 passed, 0 failed)" after a run
  that lasted under a second.** When a change adds or edits XCUITest files, QA
  scopes the run to the unit-test target plus those classes. The class
  identifier was built from the file's parent directory, so a test filed in a
  subfolder of the UITest target (`ios/AppUITests/Onboarding/FooUITests.swift`)
  became `-only-testing:Onboarding/FooUITests`. xcodebuild rejects an unknown
  target while loading the project, so nothing ran — not even the unit tests.
  The target is now the path segment that names the UITest target. Changed
  files in a UITest target that declare no `XCTestCase` (shared support code)
  are no longer passed as test classes.

### Upgrade steps

**In Build Studio** — project-server only:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

Then restart the project-servers. A workflow already halted on this needs its
QA step relaunched after the restart.

**In each managed project** — nothing to do.

---

## 2026-09-20 — Scheduled content publishing, per project

### Added

- **A scheduled job that publishes staged blog posts when their date arrives.**
  Off by default; a project opts in with `content_publishing.enabled: true`.
  While the project is running, Build Studio checks its staged directory and
  publishes every draft whose `publish_date` has been reached. A date that
  passed while Build Studio was closed is published at the next start. A draft
  with no `publish_date` is never published by the timer.
- **Operations → Publishing**, shown only in projects that enabled it: what is
  scheduled, drafts waiting for a click (`Publish now` — also for publishing a
  dated post early), failures with their reason and log, and a history of every
  attempt.
- **Failures are loud and logged.** A failed publish is never retried by the
  timer — it raises a Monitor alert naming the log file, which holds the full
  command output, so an agent can be pointed at it. `Retry` in the tab is the
  only way it runs again.
- **A background check that the post is actually live.** "Published" means the
  push succeeded. Afterwards the live URL is polled for up to
  `verify_timeout_minutes`; if it never answers, a Monitor alert says so.

### How publishing works

Build Studio knows nothing about your site. It runs **your** command with the
staged files of one post as arguments, and expects one line per file on stdout:

```
PUBLISHED<TAB><staged path as given><TAB><live url>
```

and exit code 0. Anything else is a failure. On success Build Studio stamps the
staged files (`status: published`, `posted_to`, `publishedAt` — no other key is
touched, the file is line-edited, never re-serialised), commits exactly the
paths the publish changed, and pushes the default branch. `<slug>.md` and
`<slug>.<lang>.md` are one post and are published together.

It publishes only while the project's checkout is on its default branch. During
an execution run on a feature branch the publish is deferred to the next check,
and the tab says why.

```yaml
content_publishing:
  enabled: true
  command: node scripts/publish-blog-post.mjs   # required
  staged_dir: docs/marketing/content/staged     # default
  publish_time: "08:00"                         # local time on the publish date
  check_interval_minutes: 15
  command_timeout_minutes: 10
  verify_url: true
  verify_timeout_minutes: 20
```

The config is re-read on every check; changing it needs no restart.

### Upgrade steps

**In Build Studio** — hub and project-server changed:

```bash
cd packages/hub && npx next build
cd packages/desktop && node inject-resources.js
```

Then restart the app and the project-servers.

**In each managed project** — nothing, unless you want the feature. To use it:
write a publish command that follows the protocol above, put staged posts in
`docs/marketing/content/staged/`, and add the config block. The history file
`.build-studio/publish-history.jsonl` is ignored automatically on first use.

### Known issues

- A publish command that fails halfway can leave uncommitted files behind.
  Build Studio reports them (tab and alert) but does not delete them — it cannot
  know they are safe to remove — and a dirty default branch blocks the next
  execution run until they are dealt with. Write the command so it cleans up
  after itself on failure.
- The job runs inside the project-server, so nothing is published while the
  project is stopped. The catch-up at start covers this.

### Notes for forks

- `lib/content-publish.js` must never throw out of `publishPost`, and must keep
  committing a pathspec of only the paths the publish itself changed. It runs on
  a checkout the owner may be working in.
- A deferred publish is deliberately not written to history; only real attempts
  are.
- `lib/ignore-rule.js` is now the single place that adds a `.gitignore` line for
  a runtime state file. New state files should use it before their first write
  and commit the change on its own.
- Monitor accepts `deps.extraAlerts()` — a feature contributes derived alerts
  without the monitor knowing about it.

---

## 2026-09-20 — Drafting ignores its own state file in projects that predate it

### Fixed

- **`.build-studio/draft-state.json` showed up as an untracked file, and got
  committed.** Onboarding writes the ignore rule, but only when a project is
  onboarded, so a project that predates the drafting feature never received it.
  Its first drafting session left an untracked state file, and the next
  sweep-all commit picked it up. Drafting now adds that one line to the
  project's `.gitignore` before it first writes state, and commits the change
  immediately with a pathspec-scoped commit — a modified `.gitignore` on the
  default branch would otherwise block the next execution run.

### Upgrade steps

**In Build Studio** — project-server only:

    cd packages/desktop && node inject-resources.js --sync-only --restart-projects

**In each managed project** — nothing to do for a project that has never
drafted; the rule is added on first use. A project where the file is **already
tracked** needs it untracked once, and note the form — a pathspec commit takes
the working-tree state and silently ignores a staged deletion:

    git rm --cached .build-studio/draft-state.json
    git commit -m "chore: stop tracking drafting state"     # no path argument

## 2026-09-19 — A tmux call can no longer freeze a project-server

### Fixed

- **The project-server could deadlock against its own tmux command and stop
  answering entirely.** Every tmux call is synchronous, and the same process is
  the reader of the ptys attached tmux clients write to. So: a sync call blocks
  the event loop, tmux tries to redraw an attached client, the pty's reader is
  the blocked process, the pty fills, tmux blocks on the write, and the call
  never returns. Observed with a drafting terminal attached — `tmux send-keys`
  hung for minutes and HTTP stopped responding altogether.

  Tmux calls now carry a 5-second timeout. The real remedy is asynchronous tmux
  calls, which is a larger change than this warrants today; the timeout turns a
  permanent freeze into a brief hiccup and a visible error, and lets the pty
  drain so the deadlock clears itself.

- **Close did nothing on a session whose agent had already exited.** It sent
  `/exit` in both cases, but a pane with no agent is a bare shell, which does
  not understand it — the shell printed `command not found` and the window
  stayed open. A running CLI is still asked to exit itself, so it can finish
  writing; a shell has its window closed instead.

### Known issues

- Tmux operations remain synchronous. The timeout bounds the damage but the
  deadlock is still reachable, briefly, whenever a terminal is attached.

## 2026-09-19 — The drafting session is a terminal you keep open

### Changed

- **The drafting panel sits above the filter bar and minimises rather than
  hides.** It is a fixture of the backlog view — a terminal you keep open while
  you work — not something that appears under the row that started it. Minimised
  it collapses to one line naming the ticket, whether the session is running or
  idle, and how long it has been open. Clicking Draft always maximises it.

  It renders only when a session exists, so an empty box never pushes the list
  down, and the minimised state is remembered: a panel that un-minimises itself
  on every reload is worse than no memory at all.

- **End session is now Close.** The old name suggested discarding. It closes a
  terminal: the conversation is kept and the next draft resumes it. Its two real
  effects are releasing the one-at-a-time lock and freeing the agent's
  ~300–450 MB and its pty.

- **Start fresh is gone.** `/clear` in the terminal is the canonical way to drop
  context, and a button duplicating a CLI's own command is a button that can
  disagree with it.

### Fixed

- **The terminal stayed attached to a pane that had been replaced.** The window
  is called `draft` for the life of the project, but launching kills and
  recreates it, and the terminal only watched the name — so after moving to the
  next story it showed a dead pane. Sessions now carry a launch stamp the
  terminal keys on.

## 2026-09-19 — Hiding the drafting panel sticks, and says so

### Fixed

- **Hide did not hold.** It cleared the session from the page, and the status
  poll — seeing a live window — put the panel straight back, so hiding lasted
  under ten seconds and read as the button being ignored. Hiding is now an
  intent tracked apart from whether a session exists.

- **The drafting terminal could not attach after the move to one session per
  project.** The window is named `draft` now, but the terminal's lookup still
  searched only the older per-item map, so every attach answered
  `No agent "draft" found in the active workflow or run`. Both shapes resolve;
  the older one is kept because a state file written before the change still
  carries it.

### Added

- **A hidden session shows as one line, with a Show button.** Without it a
  hidden session was invisible: the panel gone, the Draft buttons disabled
  because an agent held the lock, and nothing on screen saying why or offering a
  way back. The line reports whether the session is running or idle.

## 2026-09-18 — Drafting keeps one conversation per project

### Added

- **Drafting sessions persist and resume.** A project has ONE drafting session.
  When the previous draft has finished, the next Draft click resumes that same
  conversation with the CLI's resume flag rather than starting over — context
  kept across drafts, which is what the feature was asked for, since related
  stories touch related areas.

- **One draft at a time.** While a drafting agent is running, every Draft button
  is disabled and says which item is in the way; the API refuses a second start
  with a 409. Previously a second click replaced the running conversation, and
  briefly afterwards it typed the new item into it — fine mid-answer, wrong when
  the agent was sitting on a menu, where the text would have been read as the
  menu choice. There is no need for two drafts at once in one project, so the
  case is removed rather than made careful. The buttons re-enable on their own
  once the agent finishes.

- **An End session button.** Three controls, three different things: **Hide**
  closes the view and leaves the session running; **End session** stops the
  agent but keeps the conversation, so the next draft resumes it; **Start
  fresh** abandons the conversation entirely.

  End exists because Hide made finishing ambiguous. A completed draft whose
  agent was still sitting at its prompt looked identical to one in progress, so
  it held the one-at-a-time lock and disabled every Draft button — and typing
  `/exit` into the pane was the only way out, which is not something a button
  should require you to know. Ending sends the CLI's own exit rather than
  killing the window, so a CLI part-way through writing a file can finish.

- **The panel shows the session's age and how many items it has covered**, and
  carries a **Start fresh** button. The boundary is per project, cut by hand
  when the subject changes; nothing expires a session on its own, so that button
  is the scissors. It confirms first, because the old conversation cannot be
  resumed afterwards.

### Changed

- **The drafting window is named per project, not per item.** A window per item
  gave every draft a fresh conversation that had to be told the same things
  again — the opposite of what drafting is for.

### Known issues

- **Only claude can be resumed.** codex has no session-pinning equivalent, and
  OpenCode can continue a session but cannot be told which id to use when
  starting one. Both therefore start fresh every time; `sessionPinFlag` and
  `sessionResumeFlag` in `shared/cli.js` are empty for them rather than
  pretending. Resumable is reported per session so the UI can say so.

### Upgrade steps

**In Build Studio** — hub and project-server both change: `npx next build`, then
the full inject, then restart.

**In each managed project** — nothing to do. An existing `draft-state.json` from
before this change is replaced on the next Draft click; it is gitignored and
regenerated, so nothing needs cleaning up by hand.

## 2026-09-18 — A running drafting session can be found again

### Added

- **The drafting panel is restored when you open the backlog.** The session
  lives in tmux, not in the page, so it survives a reload — but the panel only
  appeared straight after a successful Draft click, which meant a reload, or the
  terminal failing to attach once, left a live session with no route back to it
  from the hub at all. Found the hard way: a session sat waiting for an answer
  while the only way to reach it was `tmux attach`.

- **`GET /draft` reports liveness and prunes what is gone.** Whether a window
  still exists is read from tmux rather than tracked, because the window is the
  truth and anything the state file believed could only be out of date. Entries
  whose window has gone are dropped as they are found, which also stops the file
  growing a row per draft ever started.

  Sessions are also marked `agentRunning`: a pane whose agent has exited is a
  shell at a prompt, which is worth telling apart from one still in conversation.

### Known issues

- **Clicking Draft on an item that already has a live session kills it.** Window
  creation deduplicates by name, so a second draft of the same item replaces the
  first and its conversation is gone — there is no resume yet. The restored panel
  makes the live session reachable, which is most of the need, but the button
  itself is still destructive. Resume is increment 2.

## 2026-09-18 — Agent terminals no longer leak pty descriptors

### Fixed

- **Opening agent terminals eventually exhausted the machine's pty pool.** macOS
  caps ptys system-wide (`kern.tty.ptmx_max`, 511 by default). One
  project-server was found holding **466** of them with zero child processes —
  every attach it had ever served, still allocated. Past that ceiling nothing on
  the machine can open a pty: terminals fail with `posix_spawn failed`, and so
  does anything else that needs one, including `tmux` and the test suite.

  Two defects, both needed to produce it:

  1. **node-pty leaks one descriptor per pty, and no call we can make releases
     it.** Each pty opens *two* handles on the same fd (a `tty.ReadStream` and a
     write stream). Measured on node-pty 1.1.0: `kill()` frees one, `destroy()`
     frees one, both together free one, and destroying the streams by hand frees
     one. The second is never released. The server now calls `destroy()` rather
     than `kill()` because it is the more correct call, **but that is not a fix**
     — it moves nothing. Long-standing, and invisible while terminals were opened
     by hand and one at a time.
  2. **The drafting terminal reconnected on a timer.** It rendered inside
     `SortableItemRow`, which is defined inside `BacklogTab` and therefore gets a
     new identity on every render, so React remounted every row. The backlog
     polls every 30s, so the terminal reattached twice a minute — roughly 120
     leaked descriptors an hour. It now renders at the tab's top level, where its
     position in the tree is stable.

  Defect 1 makes every attach cost one descriptor for the life of the server;
  defect 2 made attaches happen 120 times an hour. Either alone is survivable,
  which is why this surfaced only after drafting shipped.

  **The leak is now bounded.** Agent terminals share one pty per WINDOW, kept
  alive between viewers, so opening the same terminal ten times costs one
  descriptor rather than ten. The pty is released when it exits — when its window
  or session goes away — so a finished run reaps its own. What remains is one
  descriptor per window ever viewed, against a ceiling of 511, instead of one per
  attach. Measured: eight attach/detach cycles cost one pty where they used to
  cost eight.

  Viewers of the same window now share a view, including input. Joining replays
  the recent buffer, so a late viewer sees the pane instead of a blank screen.

### Known issues

- node-pty 1.1.0 leaks one descriptor per pty regardless of how it is closed, so
  a server still accumulates one per agent window ever viewed, against a ceiling
  of 511 (`sysctl kern.tty.ptmx_max`). Restarting the project-server releases
  them. To check one: `lsof -p <pid> | grep -c ptmx`. Closing it entirely needs
  node-pty 1.2, which is beta-only today — deliberately not taken, since it is a
  native module underneath every terminal in the app.

### Upgrade steps

**In Build Studio** — the usual inject and restart. A server already holding
leaked descriptors keeps them until it restarts, which the deploy does anyway.

**In each managed project** — nothing to do.

## 2026-09-17 — Drafting state is no longer committed into managed projects

### Fixed

- **`.build-studio/draft-state.json` was not gitignored.** It is machine-local
  runtime state — tmux session and window names, timestamps — exactly like
  `workflow-state.json` and `run-state.json`, which are both ignored already.
  The drafting feature added the file without the matching ignore rule, so the
  first session committed it and every later one showed as a diff. Added to the
  scaffolded pattern list.

### Upgrade steps

**In each managed project** — a project that has already run a drafting session
has the file tracked. Untrack it once:

    git rm --cached .build-studio/draft-state.json
    echo '.build-studio/draft-state.json' >> .gitignore

Onboarding writes the pattern for projects that have not run one yet. Prompt
files were already covered by the existing `prompt-*.txt` rule.

**In Build Studio** — nothing beyond the usual inject; the change is in the
onboarding scaffold, which runs per project.

## 2026-09-17 — The Draft button shows the session it starts, and logs it

### Added

- **A drafting session now appears inline under the backlog item**, as a live
  terminal you can type into, instead of starting silently in the background.
  Launching it invisibly is what made the button read as broken on first use:
  the window opened and the agent ran, and nothing on screen said so. Hiding the
  view closes the view, not the session.

- **The drafting pane is piped to a log**, as workflow agent panes already are,
  at `tmp/.logs/draft-<item>.log`. Without it the pane was the only record, and
  a launch that failed before the CLI started left nothing to read — diagnosing
  the first real failure meant digging through tmux scrollback, which lives only
  as long as the window.

## 2026-09-17 — Bugs no longer offer a Draft button

### Fixed

- **The Draft button did nothing on a project using a `[1m]` model.** The launch
  line is typed into the pane's interactive shell, which is zsh, and zsh globs
  unquoted arguments — so `--model claude-opus-5[1m]` failed with
  `zsh: no matches found` before the CLI started. The tmux window opened, the
  session was recorded, and the pane sat at a bare prompt, so the button looked
  inert. Flag values are now quoted. (The workflow launcher never hit this: it
  writes a script and runs it under bash, which passes an unmatched glob through
  literally.)

- **Bug items in `Backlog` showed a Draft button**, though bugs have no PRD:
  their lifecycle goes straight from `Backlog` to a bugfix run. Clicking it
  would have opened a session to write a document nothing reads. The button is
  now shown only on Features and Tasks, which share the PRD lifecycle, and
  `POST /draft/start` refuses a Bug with a 409 before opening any window.

### Upgrade steps

**In Build Studio** — hub and project-server both change:

    cd packages/hub && npx next build
    cd packages/desktop && node inject-resources.js

Then restart the Electron app and Start each project.

**In each managed project** — nothing to do.

## 2026-09-14 — A Draft button opens a drafting session in the dashboard

### Added

- **Backlog items in `Backlog` with no PRD get a Draft button**, beside Review
  and Execute. It opens an interactive session you talk to, in the dashboard's
  own terminal panel, instead of a terminal you opened yourself in a session the
  engine knew nothing about. Drafting is where the product gets shaped, and it
  was the only step of the cycle living outside the dashboard.

  **It does not consume the workflow slot.** A project allows one active
  workflow, and the established practice is to draft with review and execution
  rounds in between — a drafting session holding the slot would forbid exactly
  the interleaving it exists to support. It runs in its own tmux session
  (`draft-<project>`), touches no workflow state, and cannot make
  `POST /workflow/start` answer 409.

  The CLI, model and effort come from the `plan` step group through the shared
  CLI switch, so a project that moves planning to another model moves drafting
  with it. Nothing is hard-coded to `claude`.

- **A skill whose name contains an underscore is now recognised as a skill.**
  The skill-reference pattern allowed only letters, digits and hyphens, so
  `draft_prd` — scaffolded into every project — could never match it. Written
  backticked it failed the skill pattern; written `/draft_prd` it matched the
  *command* pattern and resolved against `.claude/commands/`, where a skill does
  not live. Either way the reference inlined nothing, silently, and a codex or
  opencode agent invented its own substitute. That is the precise failure the
  inlining exists to prevent, and it affected any prompt referencing that skill,
  not only drafting.

### Known issues

- **Increment 1 of four.** There is no continuity between drafts yet: each
  Draft opens a fresh conversation. Session persistence, skill distribution to
  the other CLIs, and delta re-grounding on resume are the remaining increments.

- **An item that already has a PRD is refused** (409, naming the existing PRD).
  Re-drafting is legitimate when a story's scope changed, but it silently
  replaces a reviewed document, and two drafting affordances on one story is an
  unresolved UI question. Deferred rather than guessed at.

### Upgrade steps

**In Build Studio** — hub and project-server both change:

    cd packages/hub && npx next build
    cd packages/desktop && node inject-resources.js

Then restart the Electron app and Start each project.

**In each managed project** — nothing to do. Drafting state lives in a new
`.build-studio/draft-state.json`, created on first use. Projects wanting
drafting on a different model can regroup `draft_prd` in `step_groups`.

### Notes for forks

`draft_prd` is a pseudo-step: it appears in `step_groups` so it resolves a CLI
through the same switch as every real step, but it has no workflow stage, no
gate and no feedback contract. Keep it that way — the plan's central argument is
that drafting has no intermediate states worth gating, and modelling it as a
workflow would mean inventing a step sequence for something that has none.

## 2026-09-14 — The scorecard measures rounds to converge, not the round cap

### Changed

- **The scorecard's `max round` column is replaced by `rounds`** — the mean,
  across runs, of how many rounds a role needed to settle. The old column was
  `max(round)` taken across *all* runs, which is a property of the run rather
  than of the role: it saturated at the review-round cap and read 4–6 on nearly
  every row, so it could not tell two roles apart. It looked like the metric the
  evaluation plan asked for and was not it.

  On existing data the new column separates immediately where the old one did
  not: the same role and step reading 3.75 in one project against 1.52 in
  another, on rows whose old column said 5 and 6. That difference is a
  configuration difference, and the project's command file is where it lives.

  No new instrumentation — this is a different aggregation of records already
  written. History therefore gains the metric retroactively.

  Read it beside `runs`: a mean over three runs moves a long way on one bad run.
  And for a step where several roles run together in one round — a review round —
  every role necessarily shares the round number, so there the figure separates
  projects rather than roles. The column's tooltip says both.

- `roundsToConverge` is **null**, not 0, when no run recorded a round.
  "Not measured" and "converged in zero rounds" are different claims, and
  reporting 0 would rank an unmeasured role as the best in the table.

### Upgrade steps

**In Build Studio** — hub and project-server both change:

    cd packages/hub && npx next build
    cd packages/desktop && node inject-resources.js

Then restart the Electron app and Start each project.

**In each managed project** — nothing to do. The metric is computed from
`scorecard.jsonl` records already on disk, so existing history is included.

### Notes for forks

The `maxRound` field is **gone** from the `/api/scorecard` payload, replaced by
`roundsToConverge`. A fork rendering the old field will show nothing; switch to
the new one rather than reinstating the max, which measured the round cap.

## 2026-09-13 — "Gate could not run: N/A" no longer blocks a healthy run

### Fixed

- **A verification step could not advance when the agent wrote a negative into
  the `**Gate could not run:**` line.** Agents treat the marker as a field to
  fill in rather than a line to omit, and any non-empty text counted as a
  blocker. Seen in a real run: the suite executed fully, 664/665 passed, one
  genuine blocking finding — exactly what the fix loop is for — alongside
  `**Gate could not run:** N/A — suite executed fully; no environment blockers.`
  The run stalled, and the message told the owner to fix an environment the
  agent had just certified as fine.

  An explicit negative (`N/A`, `none`, `nothing`, `no`, `-`, or one of those
  followed by a separator) now reads as the absent line it was meant to be. The
  matching is tight on purpose: a reason that merely *starts* with such a word —
  `no browser is available`, `nothing was listening on port 4000` — still
  blocks, because silently swallowing a real environment failure is the worse
  error of the two.

### Changed

- The instructions handed to gate agents now say explicitly to **omit** the line
  when every check ran, and not to write `N/A` into it. The line's presence is
  the signal.

### Upgrade steps

**In Build Studio** — project-server only:

    cd packages/desktop && node inject-resources.js --sync-only --restart-projects

Then Start each project in the hub. A run already stalled on this unblocks
without re-running the step: the stored feedback is re-parsed when you retry
`send_to_devs`.

**In each managed project** — nothing to do.

## 2026-09-12 — The scorecard scrolls, and shows which model a row ran on

### Fixed

- **The scorecard tab could not be scrolled.** The app shell is
  `h-screen … overflow-hidden` down to `<main>`, so the page never scrolls on its
  own and each tab supplies its own scroll container. This one set `padding`
  only, so everything below the fold was unreachable — invisible until enough
  runs accumulated for the table to outgrow the viewport, i.e. exactly when it
  became worth reading. It now matches `monitor-tab` and `model-tab`.

### Added

- **A `model` column.** The field was collected but never rendered, leaving the
  most common explanation for a cost difference between two otherwise-matching
  rows invisible. A row listing more than one model is shown slightly brighter
  with a tooltip saying so: its averages span different models, which is worth
  knowing before drawing a conclusion from them.

### Known issues

- `max round` is `max(round)` — the highest round the role appeared in, which is
  a property of the *run*, not of the role. It therefore reads 4–6 on nearly
  every row and cannot discriminate between roles. The metric worth having is
  convergence (rounds needed to settle), which is not what this measures.
  Unchanged for now; renaming or replacing it is a design decision, not a fix.

- Costs already recorded against a bare model alias stay unpriced. Rows carrying
  one show `(N gaps)` next to the cost, and with the model column those rows are
  now self-explanatory: every row with a gap contains a bare alias, every row
  without runs a fully-qualified id.

### Upgrade steps

**In Build Studio** — hub change, so `--sync-only` is not enough:

    cd packages/hub && npx next build
    cd packages/desktop && node inject-resources.js

Then restart the Electron app.

**In each managed project** — nothing to do.

## 2026-09-11 — An unpriced agent no longer takes down the project page

### Fixed

- **"Failed to load project" when opening a project.** The workflow view
  rendered each agent's `costUSD` without a guard, but that field is
  deliberately nullable — pricing returns null for an unpriced model rather than
  lying with 0. One unpriced agent threw `Cannot read properties of null
  (reading 'toFixed')` during render, and because it sits inside the project
  route, the error boundary swallowed the **whole page**. A missing cost now
  shows "not priced". The two sibling token fields in the same badge, and the
  project-level cost badge, were the same latent crash and are guarded too.

- **Agents running on a bare model alias were priced as unmeasured.** Pricing
  never consulted the alias table the launcher already resolves `--model`
  through, so `sonnet` and `opus` found no rate. This was not an edge case: a
  step with no explicit model falls back to `agent_defaults.model`, which
  defaults to the literal `opus` — so the most ordinary configuration on the
  platform recorded real token counts with a null cost. Measured on one run:
  eleven agents, every one unpriced. Pricing and launching now share one table.

  An unknown model is still reported as unpriced rather than guessed — that
  property is unchanged and pinned by a test.

### Upgrade steps

**In Build Studio** — this touches hub code, so `--sync-only` is NOT enough:

    cd packages/hub && npx next build
    cd packages/desktop && node inject-resources.js

Then restart the Electron app and Start each project.

**In each managed project** — nothing to do. Costs already recorded as null stay
null; they are historical records, not recomputed. New runs price correctly.

### Notes for forks

`token-pricing.js` now imports `MODEL_IDS` from `@build-studio/shared/cli` — the
same table `buildCliFlags` resolves `--model` through. Keep it that way: two
hand-maintained lists is how the aliases came to be unpriced. And treat every
`costUSD` render as nullable; the null is the honest answer, not a bug to
paper over.

## 2026-09-11 — A hung test suite is caught in minutes, and names the test

### Added

- **QA suite runs are now killed when they stop completing tests, not when they
  run out of time.** A hung test stops producing case transitions long before
  the 45-minute suite timeout, but the timeout could not tell "hung" from
  "slow" — so a hang cost the full 45 minutes and reported only "no verdict".
  Measured on 2026-09-08: a test hung 90 seconds into a run, and the 178 cases
  that had already passed were reported as progress right up to the kill, so
  nothing looked wrong for 44 minutes.

  After 5 minutes with no test case starting or finishing, the run is killed and
  reported as `stalled` — **naming the case that was running when transitions
  stopped**, which is the test that hung. That is the difference between "no
  verdict after 45 minutes" and one actionable line.

- **A runaway log is capped at 500 MB.** The same run wrote a 557 MB log that
  was 99.95% one repeated line. This is a disk backstop only — the stall check
  is what catches a hang, including a silent one that writes nothing.

### Changed

- A stalled or oversized run reports its own status rather than `timeout`, and
  both route to `**Gate could not run:**` — an environment outcome, not a defect
  a developer can fix. Sending one into the fix loop produces a task no
  developer can complete.

### Upgrade steps

**In Build Studio** — rebuild and restart so running servers pick it up:

    cd packages/desktop && node inject-resources.js --sync-only --restart-projects

Then click Start for each project in the hub.

**In each managed project** — nothing to do. The 5-minute stall window and
500 MB cap apply with no config change. Tune or disable per project in
`.build-studio/config.yaml` if a suite legitimately goes quiet for longer:

    qa_validation:
      suite_stall_minutes: 8     # 0 disables the stall check
      suite_log_cap_mb: 1000     # 0 disables the cap

### Notes for forks

The stall trigger is `caseActivity()` in `lib/qa-suite-run.js`, extracted so it
can be tested against real xcodebuild output. Its false-NEGATIVE direction is the
dangerous one — failing to see activity would kill a healthy suite — so a case
that merely *started* counts as activity, and the tests pin that alongside a
chunk of the real runaway log reading as no activity. Add new activity shapes
there, not to the watchdog.

## 2026-09-08 — A finished run commits its own scorecard row

### Changed

- **Completing a workflow now commits `.build-studio/scorecard.jsonl` itself.**
  Every finished run appends a row to that tracked file, which left the working
  tree dirty and blocked the next run until someone committed it by hand from
  the Operations tab — a manual step between every pair of runs, for a file no
  human writes or reviews. The run now commits it as
  `chore(scorecard): record <type> run`.

  The commit is **pathspec-scoped**: it records only `scorecard.jsonl` and
  leaves anything an agent has staged in parallel staged and uncommitted. It is
  also **advisory** — if git refuses (merge in progress, lock contention, no
  repo), the run logs the reason and finishes normally, leaving the row in the
  working tree exactly as before. Nothing about workflow completion can now fail
  on a git error.

  Opt out per project with `scorecard.auto_commit: false` in
  `.build-studio/config.yaml`.

### Upgrade steps

**In Build Studio** — rebuild and restart so the running servers pick it up:

    cd packages/desktop && node inject-resources.js --sync-only --restart-projects

Then click Start for each project in the hub.

**In each managed project** — nothing to do. Projects that already track
`scorecard.jsonl` get the automatic commit with no config change. If a project
has an uncommitted scorecard row right now, the next completed run commits it
along with its own.

**Note** — this only fires for projects where `scorecard.jsonl` is tracked and
inside the repo. A project whose `statePath` resolves outside the project root
is skipped with a logged reason rather than committed.

### Notes for forks

`lib/scorecard-commit.js` holds the decision and its guards; the workflow router
only logs the outcome. Keep it that way — the guards are unit-tested without
booting a workflow, which is why they are not inline in `writeWorklog`. It
shares `lib/scoped-commit.js` with support filing; that helper owns the
concurrency contract (pathspec limiting, lock retries, merge detection), so
new auto-commits should go through it rather than shelling out to git.

## 2026-09-06 — A run refuses to start against a simulator that isn't there

### Changed

- **Execution runs now check the pinned simulator before starting, not after.**
  Projects that set `simulator.destination` get a fast existence check on the
  start request; a destination that no longer resolves is refused with a 400
  naming the dead id and the `xcrun simctl list devices available` command to
  repin it. Retry with `{"override": true}` to start anyway. Projects with no
  `simulator.destination` are unaffected.

  This closes a real gap rather than a theoretical one. The same check already
  existed, but only inside the QA suite — the far end of a run. An Xcode update
  removes a simulator runtime, which deletes every device on it, so a pinned
  UDID silently stops resolving; the run then spends the whole implementation
  phase against a simulator that does not exist before anything notices.
  Measured here: three hours of `task_execution` lost this way.

  The check deliberately does **not** boot the device — it is one `simctl list`
  parse (~1s), because it runs synchronously on an HTTP start request where a
  three-minute boot would not be acceptable. Booting stays where it was, in the
  QA suite's preflight, by which point the device is known to exist.

### Upgrade steps

**In Build Studio** — project-server only:

    cd packages/desktop && node inject-resources.js --sync-only

Then restart the Electron app and any running project-servers.

**In each managed project** — nothing required, but worth checking once. If a
project pins `simulator.destination` by UDID, confirm the device still exists:

    xcrun simctl list devices available | grep "$(grep -o 'id=[0-9A-F-]*' .build-studio/config.yaml | cut -d= -f2)"

No output means the pin is stale and the next run will now be refused at start
(previously it would fail deep into QA instead). Repin it to a live device.

### Notes for forks

`checkSimulatorAvailable` is the cheap half of `preflightSimulator`, split out
of it and exported from `qa-suite-run.js`. Both are kept in one file on purpose:
they must agree about what "this device is usable" means, and preflight now
calls the check rather than repeating its guards. If you add a condition to one,
add it to the check, not to the boot path — the start gate is the half that
sees it first.

---

## 2026-09-05 — Codex agents report their cost, and unpriced models say so

### Added

- **A per-(role, step) scorecard, and a durable log behind it.** Every completed
  run now appends one record per agent to `.build-studio/scorecard.jsonl`, and
  `GET /api/workflow/scorecard` aggregates it: agents, runs, findings by
  severity, tokens, cost, median duration, CLIs and models per row.

  The question it exists to answer is comparative. A role's per-project command
  file is the thing that adapts it, and that file is hand-written and never
  evaluated — so a role needing 2.5 rounds to converge in one project and 1.1 in
  another is a configuration problem, and until now nothing could see it.

  **Its own log, not the snapshots.** Snapshots were the obvious source and the
  wrong one: they are capped at ten *files* per project and written per step
  transition, so one multi-step run fills the cap and evicts every earlier run.
  Measured here, 90 snapshot files held **12 distinct workflows**. A metric whose
  history depends on how many steps recent runs happened to have is not a
  metric. `?seed=1` back-fills from whatever snapshots survive, and says how many
  it found so thin history is not mistaken for a thin project.

  **No composite score.** Weighing cache reads against finding counts against
  duration would invent a precision the inputs do not have. Rows carry raw
  signals; comparing one role across projects is the analysis.

  Three states a single "cost" column would have flattened are counted
  separately — **priced**, **measured but unpriced**, and **unmeasured** (usage
  recorded before the 2026-08-22 attribution fix, which overstated one round by
  4.3x and, for Codex agents, was derived from Claude transcripts entirely).
  Those older numbers are treated as absent rather than averaged in.

### Fixed

- **Codex agents recorded no token usage at all.** Usage is read from an agent's
  own session transcript, keyed on a session id — and only Claude agents get one
  at launch, so every Codex agent reported nothing. The blind spot followed role
  assignment rather than being spread evenly: where a project runs its
  monolithic builder on Codex, the most expensive step in the run was the one
  with no cost attached.

  `codex exec` cannot be given a session id, but it prints the one it chose, and
  the launcher already pipes the pane to a log. That id now locates the rollout
  file, whose running totals give real input, output, reasoning, cache-read and
  cache-write counts. Measured on one historical code-review agent: **508,160
  cache-read tokens** that had been invisible.

  Deliberately *not* matched by time window. That is the attribution bug this
  repo already paid for — it charged each of six concurrent reviewers for all
  six plus the owner's own terminal session, overstating a round by 4.3x. When
  the id or the rollout cannot be found, the agent reports no usage rather than
  a plausible number.

- **Every agent, on every CLI, was priced as Sonnet 4.x.** The rate table had
  two keys, `opus` and `sonnet`, holding Opus 4.x prices, and resolved with
  `TOKEN_COSTS[model] || TOKEN_COSTS.sonnet`. No model id in actual use —
  `claude-opus-5[1m]`, `gpt-5.6-sol`, `openrouter/…` — matched either key, so
  everything silently fell through to the cheapest row, naming a model that was
  not being used. On one execution run that understated the true figure by about
  1.7x.

  Pricing now lives in `lib/token-pricing.js` with per-model rates including a
  **cache-read column**, which matters more than the rest combined: a measured
  run showed 28.4M cache-read tokens against 173K of output, a ratio near 200:1.

### Changed

- **An unpriced model now yields `costUSD: null`, not a guessed number.** There
  is no fallback rate. Project totals count those agents in a new
  `unpricedAgents` field instead of adding them as zero — a total that reads
  lower the less of a run is understood is the same failure as pricing it
  wrongly, only quieter.

- **Codex usage is priced on the model its rollout reports**, not on
  `agent.model` — the latter stores the literal string `codex` for these agents,
  which prices to nothing. This also gives the honest answer when the serving
  model differs from the configured one.

### Known issues

- Historical `tokenUsage` recorded before 2026-08-22 came from the old
  time-window attribution and is unreliable — Codex agents from that era carry
  numbers derived from *Claude* transcripts in the same directory. Any
  aggregation over old snapshots should exclude it; the `source` field on newly
  captured usage distinguishes what was measured properly.

### Upgrade steps

**In Build Studio** — project-server change only:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

Then restart the Electron app and any running project-servers.

**In each managed project** — nothing to do. Capture is automatic for Codex
agents from the next run. If a project uses a model not in the rate table, its
agents report tokens with `costUSD: null` and are counted in `unpricedAgents`;
add the model to `RATES` in `lib/token-pricing.js` to price it.

---

## 2026-08-29 — Pick the builder role per run, instead of by config-file order

### Added

- **A PRD can name its own implementation track.** Add a `**Role:**` line to the
  PRD's header block and every execution run of it builds under that role — from
  the workflow view, the backlog tab, or a raw API call:

  ```markdown
  **Status:** Draft
  **Owner:** PM
  **Role:** Android Dev
  ```

  The value accepts a role name, its skill, or the slash form (`Android Dev`,
  `android_dev`, `/android_dev`) — the same matching a backlog item's `role:`
  already gets. A backlog item's `role:` is used when the PRD says nothing.

  The start view reads it as you type the input and **preselects** the picker,
  so the choice is confirmed at a gate you already attend rather than being an
  extra step to remember. An explicit pick always wins, and the view says so
  when the two disagree instead of quietly overriding.

  **Only the PRD's header is read** — everything before the first `##`. PRD
  bodies routinely discuss roles, and letting a sentence set the builder would
  reintroduce the same silent misrouting through a different door.

- **A Builder role picker on the execution start view.** A monolithic run
  implements the whole PRD under one execution role, and until now *which* role
  was decided by array position: the planning shortcut read
  `roles.execution[0]`, with a hardcoded role-name fallback left over from the
  example project it was written against. Nothing about the PRD participated.

  A project with more than one implementation track therefore had to reorder its
  `roles.execution` before each run and put it back afterwards. Forgetting
  produced no error — a role will build another track's story perfectly happily,
  with the wrong domain rules and the wrong ADRs, and it surfaces only as
  diffuse quality loss.

  That is not hypothetical: it happened while this was still a proposal. A
  native mobile foundation story — build system, UI toolkit, platform sources —
  was built under a *different* platform's role, because that role was
  `execution[0]` and the right role was not in the roster at all. The agent
  carried 239 lines of the wrong platform's guidance while writing the other
  platform's code, and the run passed code review. A human reading the dashboard
  noticed; no check did.

  The picker appears only when a project has more than one execution role, and
  defaults to `roles.execution[0]` — so a run started without touching it
  behaves exactly as before.

- **The run header now reports which role implemented what, per step.** "Which
  lens produced this code?" was previously answerable only from tmux logs, and
  it is the first question worth asking when a story comes out wrong.

  It is deliberately not a single answer. `task_execution` builds under the
  builder role, but `fix_execution` derives its own from the **fix planner**,
  which is explicitly instructed *not* to inherit the builder's — it routes by
  the files a fix will touch. A cross-cutting fix genuinely belongs to the role
  that owns those files, so a run having two lenses is correct behaviour rather
  than drift. Reporting only the builder would have named the first lens and
  silently implied the fixes shared it; the header now lists each step's roles
  and says so when they differ.

  Derived from the agents that actually ran, never stored — a second copy is one
  more thing that can disagree with reality.

### Added

- **An optional start gate: `execution.require_builder_role`.** When set, an
  execution run whose PRD does not name its builder role is refused, with the
  usual `{"override": true}` escape hatch and an error naming the project's
  roles. It closes the gap the picker leaves open — a PRD that says nothing is
  indistinguishable from a single-track project, and falls through to
  `roles.execution[0]`.

  **Default off, and self-limiting when on.** The gate is skipped entirely on a
  project with fewer than two execution roles: there is nothing to choose,
  `execution[0]` is unambiguously right, and demanding the line would block
  every run for nothing. A project that later adds a second role starts
  enforcing automatically — which is when the question becomes real. Projects
  whose PRDs are not written by `/pm` have nobody to add the line, which is the
  other reason this is opt-in rather than the default.

- **`/pm` now writes the line.** The PM base role and the cross-project
  conventions both document the `**Role:**` header, when it is required, and
  why getting it wrong is silent rather than loud.

### Changed

- **A `builderRole` that cannot be resolved now fails the start request** rather
  than falling back to `roles.execution[0]`. The fallback is right for a bugfix
  item's frontmatter `role:` — a best-effort hint where a typo should not stop a
  run — and wrong for an explicit choice, where building under a role the owner
  did not pick is the exact failure the picker exists to remove. The error names
  the project's execution roles. A review-only role is refused for the same
  reason: role lookup treats a category as a preference rather than a filter, so
  it would otherwise resolve and launch with no branch prefix.

- **Monolithic PRD runs and bugfix runs now share one role-resolution path.**
  Both go through `resolveBuilderRole`; the inline `execution[0]` read and its
  hardcoded fallback are gone.

- **A PRD naming a role the project does not have refuses the start**, rather
  than being ignored and built under the default. Ignoring it starts the run
  under a silently different role than the document names — the failure this
  whole change exists to remove. The error names the project's roster, and the
  start view flags the same condition before you click. This can only affect a
  PRD that has a `**Role:**` line, so nothing existing changes.

### Known issues

- **The role order still matters for PRDs that do not name a track.** Whichever
  role sits first builds any run started without a selection, so a roster
  reordered for one track will silently mis-build the next story from another.
  Adding `**Role:**` to a PRD closes that for that PRD; nothing yet tells a PM
  to write the line, so it has to be added by hand for now.

### Upgrade steps

**In Build Studio** — hub and project-server both changed:

```bash
cd packages/hub && npx next build
cd packages/desktop && node inject-resources.js
```

Then restart the Electron app and any running project-servers.

**In each managed project** — nothing to do. The picker defaults to the current
behaviour and no existing PRD has a `**Role:**` line, so nothing moves on its
own.

**To turn on the start gate**, add to a project's `.build-studio/config.yaml`:

```yaml
execution:
  require_builder_role: true
```

It does nothing until the project has two or more execution roles, so setting it
everywhere is safe. Once it is active, the next execution run whose PRD lacks a
`**Role:**` line is refused — with an override — so add the lines first if you
would rather not meet the gate mid-flight.

Two things are worth doing where a project has more than one implementation
track, in this order:

1. Make sure every track has a role in `roles.execution` with its own command
   file. A track with no role is the case that bites hardest — the run builds
   under whichever unrelated role happens to be first.
2. Add `**Role:** <role name>` to the header of PRDs whose track is not the one
   sitting at `roles.execution[0]`. Once a project's in-flight PRDs carry it,
   the reorder-the-roster ritual can be retired for that project.

---

## 2026-08-29 — Re-reviewers actually get the diff this time

### Fixed

- **The server-run iOS suite could spawn `-only-testing:<Scheme>Tests` and run
  nothing.** On a project that sets no `simulator.scheme`, the scope section
  built its own scheme with a `'<Scheme>'` fallback — a placeholder meaning
  "substitute your project's scheme", which is right in prompt text an agent
  reads and fatal in an argv. The project and scheme were discovered correctly;
  only the derived unit-test target still carried the placeholder. xcodebuild
  aborted during target resolution in 683ms with exit 70, zero tests ran, and it
  surfaced a step later as *"qa_validation could not run a check"*.

  The .xcodeproj and scheme are now resolved once, before anything derives a
  target name from them, and the argv builder refuses any argument still
  containing a `<…>` placeholder rather than spawning a doomed command. The
  caller treats that refusal like any other decline and hands the run back to
  the agent.

  Only projects with `simulator.destination` set and `simulator.scheme` unset
  were affected — and only since 2026-08-27, when the server started running the
  suite. The failure was loud and non-destructive (a gate that could not run,
  which is exactly what it was), so nothing was mis-reported as passing.

- **The targeted re-review shipped on 2026-08-22 has never worked.** That entry
  said each review round records the PRD's commit sha so the next round's prompt
  carries `git diff <sha> -- <prd>` as its first step. The recording step called
  `execFileSync` in a function that never imported it — every other use in that
  file does its own local `require('child_process')` first — so it threw
  `ReferenceError` on the first round of every review, in every project, and the
  caller's `catch (_) {}` swallowed it.

  Nothing looked broken, which is why it lasted a week. The re-review block was
  present and correct in every round-2 prompt; it just always rendered in its
  no-diff form, because a missing base is a legitimate state (an uncommitted
  PRD) that the prompt is built to degrade into. Round 2 kept re-reading whole
  documents, and the 27%-more-cache-reads measurement that motivated the change
  was never actually addressed.

  The lookup now lives in `review-rereview.js`, which does its own require and
  is covered by tests that call it. A genuinely absent base still degrades the
  same way, but it now logs why instead of being indistinguishable from a
  programming error.

### Upgrade steps

**In Build Studio** — this entry alone is a project-server change:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

**If you are pulling from 2026-08-15 or earlier, do the full rebuild instead** —
the entries below this one include hub changes (the Capture Learnings panel, the
execution timeline), and `--sync-only` does not update the Next.js build:

```bash
cd packages/hub && npx next build
cd packages/desktop && node inject-resources.js
```

Either way, restart the Electron app and any running project-servers afterwards.

**In each managed project** — nothing to do for this entry. Read the
per-entry sections below; the 2026-08-23 one has the only caveat worth acting
on (a project that overrides `roles` and drops `standalone: QA`).

### Notes for forks

- `packages/project-server/lib/api/workflow.js` has no module-level
  `child_process` import: all 52 call sites rely on a local
  `require('child_process')` in the same function. That is one edit away from
  the bug above at any time, and the failure is silent wherever the call sits
  inside a `catch`. A sweep of every other file in the repo found none with the
  same exposure — they all import at module level. If you add an `execFileSync`
  call to `workflow.js`, add the require next to it.

---

## 2026-08-27 — The workflow runs the iOS test suite, so QA stops paying to watch it

### Changed

- **On iOS projects, `qa_validation` now runs `xcodebuild test` itself** and
  starts the QA agent with the results already in its prompt. The agent used to
  run the suite, and because a foreground run blocks and a silent one trips the
  15-minute stall watchdog, it was told to background the run and tail the log
  "every few minutes". In practice that meant every ~13 seconds, and every poll
  is an API request that re-reads the agent's whole context.

  Measured across every QA run still on disk:

  | run | requests | polling | share of the step's cache reads |
  |---|---|---|---|
  | fazon FAZ-286 | 148 | 90 | 61% |
  | deskrhythm #1 | 39 | 17 | 47% |
  | deskrhythm #2 | 47 | 16 | 37% |

  On FAZ-286 that was 10.8M cache-read tokens spent watching a counter, in a
  step that was itself 60% of the whole execution run. The cost was turn
  *count*, not context size — context sat flat near 90K while 148 requests each
  paid to re-read it.

  The agent keeps everything else: visual smoke, test-data cleanup, failure
  triage and the report. Only the blocking wait moved.

- **The fallback path polls slowly.** When the server can't run the suite, the
  agent still does — but the instruction now names an explicit interval (2
  minutes minimum, with the wait *inside* one Bash call) and says what polling
  costs, instead of "every few minutes".

### Added

- `simulator.scheme` and `simulator.project` are discovered when unset, via
  `xcodebuild -list`. The scheme named after the project wins; a lone scheme
  wins; anything else is treated as ambiguous and hands the run back to the
  agent rather than guessing. (fazon's project carries both `Fazon` and
  `Copy of Fazon`, and they sort with the copy first.)
- `qa_validation.suite_timeout_minutes` (default 45). A suite past its limit is
  killed and reported to the agent as a gate that could not run — never as a
  result, since a killed run has counts but no verdict.
- `qa_validation.server_runs_suite: false` opts a project out entirely.

### Known issues

- **Non-iOS QA runs are unaffected, and one of them is expensive for a different
  reason.** The polling instructions were gated on a configured simulator, so
  web projects never had the problem — they run `npx vitest run` once and stop.
  But one measured web run still spent 5.9M cache reads across 61 requests,
  dominated by browser automation for the visual smoke (screenshots are image
  tokens, and they inflate every later turn). That needs its own fix.
- **Codex-run QA agents record no token usage at all**, so this measurement
  covers only the Claude-run ones. Seven agents across nine projects is the
  whole visible sample.

### Upgrade steps

**In Build Studio** — project-server change only:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

Then restart the Electron app and any running project-servers.

**In each managed project** — nothing to do. Scheme and project are discovered
when unset. Two optional knobs if you want them: set `simulator.scheme` to skip
discovery (worth doing if your project has multiple schemes), and
`qa_validation.suite_timeout_minutes` if 45 is wrong for your suite.

---

## 2026-08-23 — A delivered companion spec no longer reports itself rejected

### Fixed

- **An agent waiting at a question was reported as a dead step, and the fix
  offered was the one that destroys its work.** When an agent asks a question it
  draws a menu and waits — producing no log output, which trips the 15-minute
  idle timeout, which stamps the agent `error`. Two things then went wrong at
  once. The stall classifier saw a recoverable report in the transcript (a long
  run has almost always left something report-shaped by then) and called it
  *"An agent finished but never reported — use Recover, or relaunch the step."*
  And the dashboard banner skipped that diagnosis entirely, because it only
  surfaced stalls on agents still marked `running`, so what you actually saw was
  *"all agent(s) errored with no output — fix the cause and relaunch."*

  Every action on offer was destructive: Recover posts a partial report as the
  step's result, and relaunch discards the agent's context and any uncommitted
  work in its worktree. The agent was alive, intact, and one keystroke from
  continuing.

  A pane showing a dialog is now reported as **"An agent is waiting for your
  decision"**, with the action to open its terminal and answer — and it outranks
  both the recoverable-report guess and the dead-step rule. An agent stamped
  `error` by the idle timeout still surfaces its own diagnosis instead of a
  generic one. A genuinely dead step is still reported as dead, and a bare
  prompt with a report behind it is still `finished_not_reported`.

- **QA delivered its companion spec and the dashboard showed "Changes
  requested".** The `companion_specs` step writes specs; it is not a review
  round, and it has no verdict to give. But it resolved each §10 owner without
  saying which variant it wanted, and every preset defines *two* roles named QA
  — `review: QA` (skill `qa_review`, the PRD-review skill) and
  `standalone: QA` (skill `qa`, the test-authoring one). Role lookup searches
  review first, so the spec **author** was handed the **reviewer** skill, whose
  mandated output format is `**Approved:** yes | no`. The agent filled it in
  honestly, the dashboard parsed it as a review verdict, and a spec that had
  been written, committed, and marked Done in the PRD table rendered as
  rejected.

  Only QA was affected — UX, Brand, Architect, Marketing and Security exist
  under one category each and resolved correctly the whole time.

### Changed

- **Companion-spec authors are now told how to report.** The step's instruction
  previously ended without naming an output format, so each agent fell back to
  whatever its role's skill prescribed. It now states that the step is a
  delivery rather than a review, asks for `**All issues addressed:** yes | no`
  about the agent's own deliverable, and explicitly rules out the PRD-review
  format. A problem the author found in the PRD but cannot fix itself goes in
  the summary's first line and under `### Action Items`, addressed to the role
  that owns it — so it stays visible without being reported as a verdict on the
  spec that was delivered.

### Known issues

- `companion_specs` is the last step of the review flow and offers only
  *approve* and *skip*. A genuine PRD defect surfaced there — the case above was
  one, a pinned fixture whose numbers did not reproduce — has no route back to
  the PM, and the run completes with it open. The step's own "no §10 table"
  error text still advises `send_back`, an action that does not exist here.
  Unresolved: whether the step should gain a send-back or whether such findings
  belong in the backlog instead.

### Upgrade steps

**In Build Studio** — hub and project-server both changed, so a full rebuild:

```bash
cd packages/hub && npx next build
cd packages/desktop && node inject-resources.js
```

Then restart the Electron app and any running project-servers.

Time the restart: relaunching stops the project-servers, and an agent parked at
a question is exactly the thing this release makes visible. Answer any waiting
agent first — its context does not survive a relaunched step.

**In each managed project** — nothing to do. The role rosters ship with the
presets and are unchanged. One caveat: a project that overrides `roles` and
drops the `standalone: QA` entry will still resolve QA to the reviewer variant;
the new instruction block keeps the report readable, but adding a
`standalone: QA` role restores the intended skill.

---

## 2026-08-22 — Re-reviews get the diff, and agent costs stop being 4x wrong

> **The diff half of this entry did not actually work until 2026-08-29.** The
> sha recording threw on every round and the error was swallowed, so the
> re-review prompt always rendered without a diff. See the 2026-08-29 entry.
> The token-attribution fix below was unaffected and has worked since it landed.

### Fixed

- **Per-agent token counts and costs were inflated several times over.** Usage
  was attributed by *time window over every transcript in the project directory*
  — but a review step runs six agents concurrently in the same directory, so
  each was charged for all six, plus any other Claude session you had open in
  that project. Measured on one review round: a reviewer reported 1,711,835
  cache-read tokens against a real 421,411, and the round totalled **4.3x** its
  true usage. Usage is now read from the agent's own session transcript.

  An agent with no recorded session id now reports no usage rather than a guess.
  A confidently wrong number is worse than a blank.

### Changed

- **A re-reviewing agent is now handed the exact diff to verify.** The
  instruction already said not to re-read sections no fix touched, but gave no
  way to see which those were — so reviewers opened the whole document anyway.
  On a measured run, 5 of 6 round-2 reviewers read the full 394-line PRD and
  **round 2 cost 27% more in cache reads and 20% more turns than round 1**. Each
  review round now records the PRD's commit sha, and the next round's prompt
  carries `git diff <sha> -- <prd>` as its first step, with instructions to open
  the document only for ranges the diff or their own prior findings name.

  By round 3 of that run the agents had drifted to diff-first behaviour on their
  own and cost roughly halved — this makes that the instruction rather than an
  accident. Runs that started before the sha was recorded fall back to a
  `git log`-based recipe, so nothing loses the guidance mid-run.

- **A re-reviewer now receives its prior findings in full.** A flat 1,200-character
  cap applied to every history entry, which delivered each reviewer **11–18% of
  its own previous review**: the cut landed on the first finding's *title*, so
  every finding body was missing, along with 80% of the PM fix report claiming
  to close them. One reviewer responded by running `sed` over its own transcript
  file to recover what had been cut.

  The most recent round — the reviewer's own findings and the PM fix report
  answering them — is now delivered whole. Earlier rounds stay capped, since
  their findings were already adjudicated in the round that followed, so the
  block stays bounded as rounds accumulate rather than growing with each one.
  Truncation now states how much was removed instead of trailing off.

### Notes for forks

- `computeTokenUsage(startedAt, completedAt, cwd, model, sessionId)` takes a
  fifth argument and returns `null` without it.
- `buildRereviewInstruction(role, skill, prdPath, round, diffBase)` takes a
  fifth argument; omitting it yields the fallback recipe rather than throwing.
- `roleHistory`'s third argument is now `olderMaxChars` — it caps rounds before
  the latest only, and no longer bounds the whole block.
- Review workflows now carry `wf.reviewBaseSha`.

---

## 2026-08-22 — The spec human-gate scan is removed

### Removed

- **The pre-start scan for human-only requirements in specs is gone.** It
  listed things it believed no agent could discharge — a second person, a manual
  review, a sign-off, an owner decision — on the Backlog tab before a run and in
  the `POST /workflow/start` response. In practice it could not tell a *pending*
  obligation from prose that merely mentions one, and the noise crowded out the
  occasional real finding.

  Two examples from the runs that ended it. One item reported **31 gates, 18 of
  them citations of four decisions the owner had already made** — specs cite
  decisions by number ("owner decision 3", "Owner decision 4 resolves it")
  because numbering is how a decision gets recorded. The next item reported
  nine, six of which were `/security` sign-offs — and `/security` is a
  configured agent role that runs during review, so those were not human gates
  at all.

  Two rounds of tightening each cut the count without fixing the class: telling
  "this needs a decision" from "this cites a decision" is a distinction of tense
  and attribution that pattern matching over prose does not reliably make.

  Removed rather than disabled: `lib/spec-human-gates.js`, the
  `humanGates` field on `POST /workflow/start` and
  `GET /workflow/start-readiness`, and both UI panels.

  **Unaffected:** the workflow steps that genuinely wait for you —
  `demo_review`, `device_testing`, `owner_consultations` — are a different
  mechanism (`needs-attention.js`, `HUMAN_GATES`). They are engine-defined,
  unambiguous, and unchanged.

### Upgrade steps

**In Build Studio** — project-server and hub both changed, so this needs the
Next build and a full inject:

```bash
cd packages/hub && npx next build
cd packages/desktop && node inject-resources.js
```

**In each managed project** — nothing to do. Nothing was ever written into your
specs; the scan only read them.

### Notes for forks

- `GET /workflow/start-readiness` still exists and still reports branch,
  default-branch, dirty and `needsAttention` — only `humanGates` is gone from
  its response, and from the start response. A fork reading that field should
  drop it; nothing else about either payload changed.

---

## 2026-08-19 — Capture Learnings shows what the run captured, not the whole archive

### Changed

- **The Capture Learnings review panel now lists only the learnings this run
  wrote or updated.** It was loading every learning in the project — 293 of them
  in one case — under the heading "Review Learnings Before Approving", so the
  two or three the run actually produced were buried in years of history. A
  review surface nobody can read is not a review surface.

  A learning carries no run id, so "this run's" is decided by file mtime against
  the capture agent's start time. That deliberately includes **updated**
  learnings as well as new ones: the capture step appends evidence to existing
  files at least as often as it creates them, and an updated learning is just as
  much a product of the run.

  The full corpus is one click away — **Show all N** — rather than hidden, since
  mtime is a heuristic and a merge or checkout can touch a file. If the run
  captured nothing, the panel says so plainly instead of showing an unfiltered
  list. When neither an agent start time nor a run timestamp is available (very
  old runs), nothing is filtered and the previous behaviour stands.

### Upgrade steps

**In Build Studio** — hub change, so it needs the Next build and a full inject:

```bash
cd packages/hub && npx next build
cd packages/desktop && node inject-resources.js
```

**In each managed project** — nothing to do.

---

## 2026-08-18 — The execution timeline shows Code Review before the run starts

### Fixed

- **The workflow panel omitted Code Review from the execution timeline until a
  run reached it.** `merge_for_review` hands off to `code_review`
  unconditionally, so it always runs — but no preset lists it in its
  `execution` array (each one comments it as "runtime-inserted"). The hub
  compensated by injecting it from live workflow state, and that injection was
  guarded on a workflow existing, so an idle panel advertised a seven-step run
  that would really be eight, hiding the review gate. It is now shown whenever
  the timeline is for an execution workflow.

  Bugfix timelines were never affected: `code_review` is listed explicitly in
  their resolved step list, and that list is still authoritative — a project
  that removes it from a `workflow.bugfix` override still sees it removed.

### Upgrade steps

**In Build Studio** — this is a hub change, so it needs the Next build and a
full inject, not `--sync-only`:

```bash
cd packages/hub && npx next build
cd packages/desktop && node inject-resources.js
```

**In each managed project** — nothing to do.

---

## 2026-08-18 — A live agent waiting on a question is no longer reported as dead

### Fixed

- **An agent waiting at a question prompt was reported as "Process exited ...
  pane is back at a shell prompt", with advice to relaunch it.** Relaunching
  would have killed a live process holding 50 minutes of context and uncommitted
  work. Three checks were reading tmux's `#{pane_current_command}` as proof of
  death, but that field names the foreground process-GROUP LEADER — and agents
  launch as `bash start-<agent>.sh` without `exec`, so it reads `bash` for a
  healthy agent's entire life. The rule now lives in one place
  (`paneReturnedToShell`) and requires a shell pane **and** no live process
  beneath it.
- **An agent that resumed after you answered its question stayed stuck showing
  the old error.** `isRevived` rejected any pane whose command was a shell,
  which is every Claude agent, always — so the revival it was written for could
  never happen, and the card kept offering Recover and Approve. Either would move
  the step and cause the agent's real report to be rejected as belonging to a
  closed step.
- **The CLI's own question dialog was read as evidence the agent was busy.** Its
  footer contains "Esc to cancel", which matched a *working* marker — so the most
  common way an agent blocks on a human was invisible to the stall detector.
  Dialog navigation markers ("Enter to select", "↑/↓ to navigate") now take
  precedence.

### Changed

- **A stalled agent's card now says what is actually wrong.** The waiting/auth/
  finished-without-reporting classifier used to run *after* the 15-minute idle
  timeout and was guarded on the agent still being `running` — but the timeout
  had already flipped it to `error`, so the one component that recognises
  "waiting for input" never ran for its main case. It now runs first, and the
  timeout reports its verdict ("An agent is waiting and will not proceed")
  instead of a generic "may be stuck".
- **Error text for a live-but-stalled agent no longer tells you to relaunch
  without saying what it costs.** Where the process is still alive, the message
  says so and notes that relaunching discards context and uncommitted work.

### Upgrade steps

**In Build Studio** — sync and restart:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

**In each managed project** — nothing to do.

### Notes for forks

- `agent-recovery.js` exports `paneReturnedToShell({paneCommand, hasLiveChild})`.
  Call it instead of `isShellCommand()` for any liveness decision;
  `isShellCommand()` remains but answers a narrower question than its name
  suggests. `isRevived()` takes a new optional `hasLiveChild`, defaulting to
  `false` so existing callers keep their current behaviour.
- `agent-stalled.js` exports `WAITING_MARKERS`, checked before `WORKING_MARKERS`.

---

## 2026-08-17 — Agent Xcode builds stop leaking gigabytes, and stop being cold

### Fixed

- **The DerivedData reaper now sweeps in-project build directories, not just
  `/private/tmp`.** iOS agents isolate their builds from the IDE's DerivedData,
  which is correct — but many put that directory inside the project
  (`<root>/ios/build/…`), where the reaper never looked. One iOS project had
  accumulated **41 directories totalling 21.8 GB** in-tree, one per agent per
  fix and review round, going back months. Run `node
  packages/project-server/lib/tmp-derived-clean.js --dry-run --scan-projects` to
  size your own.
- **The reaper's "never touch a live build" guard was not holding for relative
  paths.** It read `-derivedDataPath` from the process table and resolved it
  against its *own* working directory, so a build started as
  `cd ios; xcodebuild … -derivedDataPath build/DerivedDataX` resolved to a
  nonexistent path and matched nothing. Live builds were protected only by the
  180-minute freshness guard. Relative paths are now resolved against the build
  process's own cwd; if that cannot be read the directory name is guarded
  instead, which errs toward keeping too much.

### Changed

- **iOS agents are told to reuse one DerivedData directory per run**
  (`ios/build/dd-<item>`) instead of inventing a name per step and per round.
  Two effects on an unmodified config: builds after the first in a run are
  incremental rather than cold (minutes per review round), and a run leaves one
  directory behind instead of one per agent. The isolation from an open Xcode is
  unchanged — that part was always right.
- **The installed sweep LaunchAgent now passes `--scan-projects`**, reading the
  project registry at run time so projects added later are covered without
  reinstalling.

### Upgrade steps

**In Build Studio** — reinstall the sweep so it picks up the new flag, then sync
and restart:

```bash
./scripts/install-xctest-sweep.sh
cd packages/desktop && node inject-resources.js --sync-only
```

**In each managed project** — nothing to do, but iOS projects may want to
reclaim what has already accumulated. Check first, then delete:

```bash
node <build-studio>/packages/project-server/lib/tmp-derived-clean.js --dry-run --scan-projects
node <build-studio>/packages/project-server/lib/tmp-derived-clean.js --scan-projects
```

Do this with no workflow running. DerivedData is a pure build cache — the only
cost of deleting it is one cold rebuild.

### Notes for forks

- `tmp-derived-clean.js` takes `--dir` (repeatable) instead of a single scan
  directory. `--tmp-dir` still works as an alias, so existing wrappers and
  LaunchAgents keep running unchanged.
- Its JSON output renames `tmpDir` (string) to `dirs` (array). A fork parsing
  `--json` needs updating.

---

## 2026-08-17 — A fix plan that fails to arrive is caught while the agent can still fix it

### Fixed

- **A fix planner whose plan never reached the server no longer stalls the run
  silently.** The failure looked like this: the planner did its job, wrote a
  complete plan, then lost it building the HTTP request — a multi-line
  `python3 -c` mangled by the shell, so only its prose summary was sent. The
  server accepted the prose, answered `{"ok":true}`, marked the agent done and
  closed its window. Nothing looked wrong until the owner clicked **Approve**
  hours later and got *"No valid fix plan found in planner feedback"*, with a
  dead button and a suggestion to relaunch a planner that had already done the
  work correctly.

  Feedback for `fix_plan` is now checked when it is POSTed, while the agent is
  still alive. A post with no parseable task array is refused with the required
  format, so the agent — which still holds its plan — retries and usually
  succeeds. Rejected payloads are kept on the agent record rather than
  discarded.

### Changed

- **A `fix_plan` step can now be blocked by the engine before you ever approve
  it.** After three rejected posts the last payload is accepted anyway (nothing
  is thrown away), the step is marked `blocked`, and it surfaces in **Needs
  attention** with an explanation — instead of the agent burning context on a
  format it cannot produce. The note points at the agent's scratchpad, because
  in the observed case the plan existed on disk and only the POST failed.
- **Blocked steps no longer auto-advance.** Auto-advance runs the approval path,
  which is precisely what a blocked step says cannot succeed. It now waits for
  you.
- **Fix planner prompts now say to post the plan from a file** (`--data-binary
  @payload.json`) rather than assembling JSON inline in a shell string or
  heredoc. This is the root cause of the incident above, not a style
  preference.

### Notes for forks

- Fix-plan extraction moved out of the approve handler into
  `lib/plan-contract.js` (`extractFixPlan`). The POST-time check and the approve
  path now share it deliberately — if they diverged, validation would move the
  stall rather than remove it. A fork that patched the parsing cascade inline in
  `api/workflow.js` needs to re-point that patch.
- Validation is an allowlist and currently covers `fix_plan` only. `planning` is
  deliberately excluded: its approve path can build a task plan out of markdown
  role headers and numbered lists, so prose there is legitimate.

### Upgrade steps

**In Build Studio** — sync the project-server into the bundle, then restart the
app and any running project-servers:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

**In each managed project** — nothing to do.

---

## 2026-08-15 — A check that cannot run is no longer reported as a defect

### Added

- **Gate agents can now say "the gate could not run".** One verdict channel
  (`Approved: no` + a blocking count) carried two unrelated conditions: the gate
  ran and the code failed it, and the gate never executed at all. Downstream they
  were indistinguishable, so an environment problem entered the fix pipeline as
  work no developer could complete — a QA agent that could not reach a browser
  filed it as BLOCKING and the fix planner aimed a task at the project; another,
  pointed at a dev-server port nobody was serving, did the same. Each cost a full
  fix round.

  Agents now report `**Gate could not run:** <what failed to execute>` instead of
  a blocking verdict. It surfaces to the owner as `gate_blocked`, and
  `send_to_devs` refuses to build a fix plan from it (override available). A
  check that *ran* and failed is untouched — that is what the fix loop is for.

### Changed

- **Reviewers no longer read each other's findings when re-checking their own.**
  Onboarding's `team_review` now scopes history the same way PRD re-review
  already did: your own prior findings plus the fix reports, not all six roles'
  verdicts. Less prompt, and no reading another reviewer's blocker before
  forming your own view.

- **An item can be dragged into a release group with no visible rows.** Nothing
  registered a release as a drop target, so the branch handling it was
  unreachable — with Hide done on, a group whose items are all done could not be
  dropped into. The target is registered *only* while a group is empty, so
  ordinary row-to-row drags see no new competing droppable.

### Fixed

- **Security: git operations no longer build shell strings.** Branch names come
  from workflow state and backlog ids, and every git call interpolated them into
  a shell command — two without even quoting. A branch named `x$(...)` was
  command execution. All fifteen call sites now pass an argument list, with a
  test asserting that a name containing `$(touch …)` creates nothing.

### Fixed

- **The human-gate panel no longer fires on decisions that were already made.**
  A backlog item recording a decision uses the same words as one requiring it —
  reported on an item whose only match was the heading
  `## Owner decision (2026-08-15)`. A **dated** heading records; an undated
  `## Owner decision needed on the schema` still reports. Prose pointing back at
  a decision ("written per owner decision") is filtered too.

### Notes for forks

`gate-blocked.js` is deliberately narrow: it detects "did not execute", never
"executed and I disliked the result". If you widen the marker, it becomes an
escape hatch from real failures — the pattern is anchored to a line start and
requires a reason, and the tests assert that an ordinary failing-test report is
*not* diverted.

---

## 2026-08-12 — Agents that are alive but stuck now say so

### Added

- **The watchdog now detects agents that are running yet will never finish.**
  The existing checks ask *is the process alive?* and answer correctly — which
  is exactly why three failures in one day went unsurfaced. All three left a
  healthy, repainting process, so the idle-stall timer never fired:

  - an expired CLI login blocked three reviewers for **39 minutes** while the
    three that had already reported looked fine;
  - an agent wrote a complete review and stopped without posting it (twice in
    five days) — the step waits forever for a report that exists but was never
    sent;
  - an agent sitting at a prompt with nothing behind it.

  Liveness and progress are different axes. The discriminator is what the pane
  ends with: a working agent shows a spinner and `esc to interrupt`, a blocked
  one shows a bare prompt. Three conditions are reported —
  **`auth_blocked`** (login expired, invalid key, credit or usage limit — fires
  immediately, since the message is terminal), **`finished_not_reported`** (bare
  prompt, no feedback, and a recoverable report already in the transcript), and
  **`agent_waiting`** (bare prompt, nothing recoverable — deliberately the
  weakest claim, with no automatic action offered).

  Advisory, never a halt: it appears as the same ⏸ banner human gates use, with
  the remedy stated. A false positive costs a glance; a false halt costs a run.

### Notes for forks

`agent-stalled.js` is pure — pane text in, verdict out — so the rules are
testable without a tmux session. Two invariants: absence of the *working*
marker is what indicates waiting (positive evidence of working, rather than
enumerating every prompt shape), and an unreadable pane returns null, because it
is not evidence of anything. The marker is cleared when an agent recovers on its
own; a stale "needs you" is worse than none.

---

## 2026-08-12 — Re-review rounds verify fixes instead of re-reading the PRD

### Changed

- **From round 2, PRD reviewers verify their own prior findings rather than
  sweeping the document again.** Until now the reviewing instruction was
  byte-identical every round — *"Read the PRD file, then analyze it"* — with no
  diff and no changed-section scoping. The only round-awareness was a rule
  saying *"after round 2, only raise genuinely new issues"*.

  That combination is a finding generator, not a review: a round-3 reviewer
  opens the whole PRD, is told the only acceptable output is NEW material, and
  has a fresh lens to apply. On a real run a reviewer reported "the round-2
  blocker is resolved" and then raised three findings from a surface no earlier
  round had touched. It did what it was asked.

  Rounds 2+ now get a targeted contract: locate the fix for each of your prior
  findings and mark it CLOSED / NOT CLOSED / REGRESSED; read the sections the
  fixes touched; do not re-assess sections no fix touched and you did not
  previously flag. An unclosed finding or a regression **still blocks** — what
  is ruled out is treating an already-reviewed document as unread.

  `code_review` has worked this way for implementation review since it was
  written ("do not re-audit code that was already approved in round 1"); PRD
  review simply never got the same treatment.

- **A re-reviewing role now sees only its own prior findings, plus PM's fix
  reports.** The shared history handed all six roles' feedback to every
  reviewer, which was the bulk of the prompt and invited anchoring — Brand
  reading Architect's blocking finding before forming its own view. PM's fix
  report is always included, because it is the claim being verified. Every other
  step keeps the full cross-role history.

### Upgrade steps

**In Build Studio** — sync and restart:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

**In each managed project** — nothing to do.

### Notes for forks

This narrows what a re-review LOOKS at; closure mode (above) changes what
happens to findings that still surface. They are complementary and a run wants
both — verification first, and a contract for the residue. Per-agent history is
overridden through `agent.historyOverride`; leave it unset and the agent gets
the shared cross-role history as before.

---

## 2026-08-12 — PRD review converges on its own

### Changed

- **After two review rounds, reviewers switch from discovery to closure.** A PRD
  review that keeps surfacing genuinely new material each round is progressing
  yet can never approve — the reviewers' "fresh angle each round" method is an
  unbounded lens generator, so round 3 raises three new blockers, round 4 raises
  three more, and the run only stops at the cap with an owner reading six agent
  transcripts to decide which findings were real.

  From round 3 (configurable), the finding **contract** changes. Still blocking:
  a regression, an incomplete fix citing a specific earlier finding, or a newly
  found defect causing data loss, security exposure or corruption. No longer
  blocking: anything from sweeping an angle no previous round examined, missing
  tests for behaviour verified correct by other means, and polish or spec-letter
  divergence without user-facing harm. Those are reported under a
  **Follow-up proposals** heading to file as backlog items.

  `Approved: yes` with a rich follow-up list is the designed good outcome —
  nothing is lost, it moves from blocking the run to being tracked work.

  This machinery already existed (`review-wrapup.js`) but reached only
  `final_review`, and only past the round cap — which made it unreachable in
  practice: with a cap of 5 it could not engage until round 6, three full
  six-agent rounds after the problem starts.

### Upgrade steps

**In Build Studio** — sync and restart:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

**In each managed project** — nothing to do. Defaults apply; tune per project
with `review.fresh_lens_rounds: N` in `.build-studio/config.yaml` (default 2 —
raise for deeper review, set high to disable), or `review.wrapup: false` to opt
out entirely. `final_review` is untouched and keeps its own cap-based trigger
and its own `final_review.wrapup_past_cap` opt-out.

### Notes for forks

The two flows now have separate thresholds and separate opt-outs on purpose: an
owner who wants unbounded PRD review should not have to give up closure on
`final_review` to get it. `buildWrapupBlock` also takes the flow, because the
heading has to be true for the round it lands in — telling a round-3 PRD
reviewer it is "past the owner-approved cap" is false, and a reviewer that
catches the prompt lying has every reason to discount the rest of it.

---

## 2026-08-12 — A finished agent's log is readable again

### Fixed

- **A completed agent's log rendered as one unreadable blob.** The fallback
  below reads the `pipe-pane` file, which is the raw byte stream a TUI wrote —
  not the rendered terminal `capture-pane` returns. In that stream `\r` is the
  line break: one real 52 KB agent log contained **two** `\n` bytes total. Split
  on `\n` it became ~3 "lines", i.e. the whole file run together, and every
  agent's log looked alike because they share a banner and prompt preamble with
  nothing after it delimited. Logs now split on `\r` too, and cursor-column
  escapes become spacing instead of being dropped (which was gluing words
  together). Spinner frames are filtered too — the CLI animates its status line
  in place, so every repaint became its own line (462 of 839 on a real review
  log) and arrived as vertical one-character slices (`✽ u n` / ` r i`). Only
  lines that are glyphs alone, or a run of single-character tokens, are dropped;
  real short lines are longer than that and survive. Unicode is preserved, and escape stripping now follows ECMA-48
  properly — the previous pattern missed every sequence a current terminal
  negotiates at startup (`ESC[>1u`, `ESC[?2026$p`, `ESC 7`/`ESC 8`), which
  survived as literal garbage on the first lines of every log.

- **Clicking Log on a completed agent said "No output yet — agent starting…".**
  Exactly backwards: the agent had finished, and the more cleanly a step ran the
  less of it you could see. An agent's tmux window is reaped the moment it
  reports, so the pane is empty from then on — and the route the hub calls,
  `GET /terminal/workflow/:role`, read only the pane and returned `''` when it
  was gone.

  It now falls back to the log file, which `pipe-pane` has been streaming to
  disk all along. A sibling route (`/workflow/log`) already had this fallback;
  this one did not, and the hub calls this one.

### Notes for forks

The pane is the live view; the file is the record. Any route serving agent
output needs both — reading only the pane silently loses every agent that has
already finished, which is the majority of them at any given moment.

---

## 2026-08-12 — Reorder the backlog while filtered

### Changed

- **Drag-to-reorder now works with Hide done and the type filters on.** It was
  disabled whenever any filter was active. That turned out to be caution rather
  than a constraint: the reorder never works on visible indices — both endpoints
  are resolved against the full item list and the complete group structure is
  persisted, not a delta. "Move A to where B is" is well-defined however many
  rows are hidden between them.

  Verified against a group holding 72 items of which 3 were visible: dragging
  the last visible item to the top moved it from index 43 to 10, shifted the 33
  hidden rows it passed by one, kept all 72 ids, and persisted exactly the
  visible order shown on screen.

  **Search still disables it**, deliberately — its visible set changes as you
  type, so a drag begun under one result set can end under another. The hint and
  the drag handle's accessible label now say that instead of the old, broader
  "while a filter is active".

### Known issues

- **An item still cannot be dropped into a release group with no visible rows.**
  Nothing registers a release as a drop target — there are no `useDroppable`
  calls in the tab — so the `overIsRelease` branch in `onDragOver` has never been
  reachable. This is pre-existing and unchanged, but enabling filtered reordering
  makes it easier to meet: Hide done can empty a group that previously showed
  rows. Wiring a release-level droppable would change collision detection for
  every drag, so it is left as its own change rather than a rider on this one.

---

## 2026-08-11 — Visual smoke evidence is no longer committed

### Changed

- **Workflow runs no longer commit their screenshots.** Visual smoke evidence is
  written to `docs/pr-evidence/<PRD>/visual/` exactly as before and is still
  required — the AC verifier resolves cited paths against the working tree, so a
  missing directory still blocks a visual AC from being marked MET. What changed
  is that the files are now **gitignored**: they are a run artifact that needs to
  exist on disk, not a source artifact that needs to exist forever.

  Screenshots do not delta-compress, so every regeneration was a full blob
  retained permanently. Measured across the projects here before the change: one
  repository held **1 060 MB of evidence PNGs in a 1.5 GB `.git`**, with 368 MB
  of that added in a single fortnight and up to **21 committed versions of one
  ~2 MB screenshot**. A second was 92% evidence by size. Nothing read any of it —
  every reference to the directory outside `docs/` is a writer.

  The prose beside the images (`.md`, `.txt`, `.json`) is still tracked. It is
  small, and it is the part that gets read.

### Upgrade steps

**In Build Studio** — rebuild, inject, restart:

```bash
cd packages/hub && npx next build
cd packages/desktop && node inject-resources.js
```

**In each managed project** — add the ignore rule and untrack the images. This
stops the growth; it changes no history and is reversible. Run per project:

```bash
cat >> .gitignore <<'EOF'

# Visual smoke evidence — regenerated per run, kept on disk, never committed
docs/pr-evidence/**/*.png
docs/pr-evidence/**/*.jpg
docs/pr-evidence/**/*.jpeg
docs/pr-evidence/**/*.gif
docs/pr-evidence/**/*.pdf
EOF

git ls-files 'docs/pr-evidence' | grep -iE '\.(png|jpg|jpeg|gif|pdf)$' \
  | tr '\n' '\0' | xargs -0 --no-run-if-empty git rm --cached --
git add .gitignore && git commit -m "chore(git): stop committing visual smoke evidence"
```

The files stay on disk — only the tracking stops. Re-running onboarding on an
existing project also adds the ignore rule (it is idempotent and appends only
what is missing), but it will not untrack what is already committed; the command
above is what does that.

### Known issues

- **Untracking does not shrink your repository.** The blobs stay in every commit
  that already contains them, so `.git` will not get smaller — the growth stops,
  the weight remains. Expect no change from `du -sh .git` after the upgrade
  steps; that is correct, not a failed upgrade.

  To size your own situation:

  ```bash
  git rev-list --objects --all \
    | git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' \
    | awk '$1=="blob" && $3 ~ /pr-evidence/ {s+=$2} END {printf "%.0f MB\n", s/1048576}'
  ```

  Reclaiming that space requires rewriting history (`git-filter-repo` or
  equivalent), which **changes every commit id**. Everyone with a clone must
  re-clone or hard-reset, open PRs need rebasing, and any unpushed work must be
  replayed. That is a deliberate, coordinated operation — it is intentionally not
  part of these upgrade steps, and it is not recommended unless the measurement
  above shows a number worth the disruption. A few hundred MB of static dead
  weight is usually cheaper to live with than a rewrite.

  If you do rewrite: push everything you care about first, and tell anyone else
  with a clone before you force-push.

### Notes for forks

The ignore list lives in two places that must stay in step —
`BUILD_STUDIO_GITIGNORE_PATTERNS` in `lib/onboard.js` (applied when onboarding an
existing repository) and `templates/default/.gitignore` (applied when scaffolding
a new one). Adding a pattern to only one leaves half the projects unprotected.

The directory itself is deliberately **not** ignored wholesale, and neither are
`.md`/`.txt`/`.json`. If you ignore the whole directory you also lose the
evidence notes, and the AC verifier will still pass because it only checks that
cited paths exist on disk — so the loss is silent. There is a test pinning both
halves of this in `onboard.test.js`.

---

## 2026-08-09 — Human gates are listed before a run, not discovered at the round cap

### Changed

- **Non-Claude code reviewers are told the review method instead of a skill name
  they cannot invoke.** The review prompts said "Use the `/code-review` skill at
  high effort — a multi-angle, recall-biased pass". That harness is compiled into
  the `claude` binary, so for a codex or opencode reviewer the instruction was
  inert. It reported so itself: *"skill is not available in this session, so I'll
  use the project's review instructions"* — and then ran a single pass where the
  prompt specified recall-biased multi-pass. With the review slot set to codex,
  that was **every code review, final review and bugfix review in the
  installation**.

  Those prompts now spell out the method for non-Claude CLIs: pass 1 finds every
  plausible issue without judging, pass 2 actively tries to disprove each one,
  and only what survives is reported. Claude keeps the real reference, since it
  can run it.

  This is a *translation*, not the file-inlining used for `.claude/commands` and
  `.claude/skills` — there is no file to point at. A same-named marketplace
  plugin does exist on disk, but it is a different tool (drives `gh pr diff`,
  launches sub-agents, posts a GitHub PR comment), and inlining it would aim a
  reviewer at a pull request instead of the branch diff.

  Prompts that deliberately say "Do **NOT** use the /code-review skill" — the
  targeted re-review and the bugfix review, which opt out of the fan-out on
  purpose — are left alone.

### Added

- **Human gates are now reported on every way a run can start, including from
  no UI at all.** The first version of this checked only the Backlog tab's Start
  button — one of three entry points. The Workflow tab has its own start path,
  and an automated caller posts to the API directly. A run started from either of
  those saw nothing.

  That gap had teeth: an unattended job started an item carrying six gates,
  including an owner decision, then rewrote the spec to declare the gate
  automated and marked the item Reviewed — while the test underneath was
  unchanged. The scan now runs server-side on `POST /workflow/start`, so the
  gates come back in the response for **any** caller and are written to the
  server log for the ones with no screen. The Workflow tab renders them as a
  dismissible notice beside the run. Both endpoints share one helper rather than
  the copy the first version inlined.

- **Requirements only a person can discharge are surfaced on the Start click.**
  Starting a run from the Backlog now scans that item's spec set — the item
  file, its PRD, and the docs the PRD links — for requirements no agent can
  satisfy: a second person, a manual review, a recorded reviewer identity, a
  sign-off, an owner decision. If any are found, the first click lists them with
  file, line and the sentence itself, and offers **Start anyway** or **Cancel**.

  It is advisory and never blocks a start. The point is not to forbid human
  gates — they are legitimate, and an agent should not be making those calls on
  the owner's behalf — but to have them resolved up front rather than found
  eight rounds in. The prompt for this: a QA spec required "a second person
  reviews the fixture diff for sensitive data and records reviewer/date in the
  manifest". No agent can do that. It was reported BLOCKING in all seven
  code-review rounds of one run, the developer correctly refused to fabricate a
  reviewer every time, and the run hit its round cap having found **zero**
  product defects.

  A spec that has already *replaced* its gate is not reported as having one —
  "enforced mechanically, not by attestation" reads as a negation, because a
  list that cries wolf gets ignored.

### Fixed

- **Security: the human-gate scan could be pointed at files outside the project.**
  Introduced and fixed the same day, but it was on `main` in between — pull if you
  took `aab0a0b`. The scan built its file list from three untrusted sources: the
  `item` request parameter, a backlog item's `prd:` frontmatter value, and a regex
  over PRD body text. It resolved absolute paths as given and joined relative ones
  with no containment check, so `prd: /etc/hosts` or `?item=../../../../etc/hosts`
  read that file and returned every line matching a gate pattern in the API
  response — an information-disclosure primitive driven by repo content that
  agents write.

  Now guarded at both layers: the item id must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`
  with no `..`, and every path the scanner reads goes through `assertInside`
  against the project root. A refused path is skipped rather than failing the
  scan, so one bad `prd:` value does not hide the gates in the other files.

- **QA was told dev servers were running when none were, and given a port the
  project does not use.** The QA prompt asserted "Worktree dev servers are
  already running on offset ports" unconditionally, falling back to a hardcoded
  `5173`/`4000` whenever the run had started none. A bugfix run works in the
  project root and starts no servers; a project with no `dev_commands` has none
  to start either way.

  The result on a hello-world bugfix: QA pointed `playwright-cli` at an invented
  `http://localhost:5173`, got `ERR_CONNECTION_REFUSED`, and reported it as a
  blocking finding — while the project serves on `4173` via Playwright's own
  `webServer` block, which starts it automatically (the E2E suite passed 7/7 in
  the same run). The fix planner then spotted the port mismatch and aimed a fix
  task at **the project**, i.e. at changing a working repo to match a prompt that
  was wrong.

  The section is now conditional: it lists the servers the workflow actually
  started, or states plainly that none were and that no port should be guessed —
  a connection refused on a port nobody serves is an environment characteristic,
  not a finding. When a step genuinely needs the app served, it points at the
  project's own configuration (`package.json` scripts, the E2E runner's
  `webServer` block, which names both the command and the port) instead of a
  default that belongs to no project.

- **An execution run that hit the fix-loop round cap could not be moved at all.**
  The execution flow parks a run at `review_cap_reached` but implemented no
  transition out of it — only the *review* flow had one, and it routes to steps
  (`reviewing`, `companion_specs`) that do not exist in an execution run. Every
  action answered "no valid transition for step=review_cap_reached", including
  the Force Continue button the UI offers. The run was unmovable without editing
  state by hand.

  Both ways out now work: **Another round** restarts the round budget and
  re-enters the source step, **Force Continue** re-enters that step's own
  approve path (so it routes wherever an approved review routes, and keeps
  doing so if that changes) and records the override on `wf.capOverrides`.

- **Expanding a backlog item could send the view back to the top**, putting the
  body you just asked for off screen. Expanding a row now pins that row in
  place. Note this was not reproducible from a browser against the same build —
  several rows, a full poll cycle, and both synthetic and real click paths all
  held position — so this anchors the symptom rather than claiming to have
  found the trigger. Pinning the clicked row is right regardless of cause.

### Upgrade steps

**In Build Studio** — hub and project-server both changed, so a full rebuild,
inject and app restart:

```bash
cd packages/hub && npx next build
cd packages/desktop && node inject-resources.js
```

**In each managed project** — nothing to do. The gate scan reads specs where
they already are and writes nothing.

### Notes for forks

`agent-skills.js` now has two mechanisms, and the distinction matters when you
add to either. `inlineReferencedDefinitions` resolves names to **files** — a
project edits `.claude/commands/qa.md` once and all three CLIs see it, which is
the property to preserve. `translateClaudeOnlyCapabilities` is the fallback for
capabilities that have no file because they live inside the Claude binary; it
rewrites the reference into prose. Prefer the first whenever a file exists, and
when adding to `CLAUDE_ONLY_TRANSLATIONS` match only the affirmative form — a
prompt that says "do NOT use X" must not be rewritten into a description of X.

`spec-human-gates.js` is pattern-based and deliberately conservative. Two
invariants if you extend `PATTERNS`: a phrase must be specific enough that
ordinary spec prose does not trip it (plain "review" is hopeless — every spec
says it about agents), and every addition needs a matching consideration in
`NEGATIONS`, or a spec that has removed its gate starts reporting one. The scan
result reports `total` and `truncated` alongside the capped list; keep that —
a silently truncated list reads as the whole list.

---

## 2026-08-09 — Non-Claude agents can finally read their own role definitions

### Added

- **Delete a recording from Home → Demos.** Each row in the recordings list has
  a delete button, behind a confirmation that names what is about to go — the
  recording, its rendered cuts, the upload master and your notes, whichever of
  those exist. Cancel holds focus and Escape closes, so the destructive button is
  never the one you hit by reflex. Deletion is permanent and nothing is moved to
  the Trash, which the dialog says outright. A recording that is still being
  written is refused rather than deleted: the recorder holds an open handle
  inside that folder, and pulling it out from under a live capture corrupts the
  take instead of cancelling it.

### Changed

- **Codex and OpenCode agents now receive the role definitions and skills their
  prompts refer to.** Build Studio scaffolds roles into `.claude/commands/` and
  skills into `.claude/skills/`, and the step prompts name them — "Use the /qa
  skill", "Use the `qa-browser-testing` skill". Those are Claude Code paths.
  Every non-Claude agent has therefore been running **without its role
  definition** and without any skill it was pointed at, silently, for as long as
  the CLI picker has existed.

  What such an agent does is not nothing — it substitutes something of its own,
  chosen with no knowledge of what the project provides. Those names now resolve
  at launch, at the one point where the agent's CLI is known, and the file
  contents are appended to the prompt for any CLI that cannot load them. Only
  names that actually exist on disk in that project are inlined, so a reference
  to a Claude Code built-in (`/code-review`) adds nothing rather than inventing
  something.

  Expect non-Claude prompts to grow by roughly the size of one role file plus
  any referenced skill — about 12 KB on a QA step here.

- **The QA visual-smoke step now names `playwright-cli` instead of describing
  the goal.** When a browser target is configured, the instruction gives the
  actual commands and explicitly rules out CLI-native browser tools
  (`agent.browsers`, Computer Use, in-app browser skills), including the standing
  rule that "No browser is available" means the wrong tool was used and is never
  a finding to report.

### Fixed

- **A codex QA agent could fail a run over a screenshot it was never able to
  take.** On a hello-world bugfix (a one-character Swedish typo, fixed correctly
  in the very first commit), QA needed a visual smoke, could not see the
  `qa-browser-testing` skill, and reached for codex's own in-app browser runtime
  — whose bundled instructions tell it to try that *before* falling back to
  standalone Playwright. In a headless tmux pane that runtime does not exist, so
  it got `No browser is available` and filed the gap as a **blocking defect**.
  Code review inherited the blocker, fix_plan planned work no developer could do,
  and the run reached round 2 with zero code defects ever found. `playwright-cli`
  was installed throughout and never invoked once.

  There was already a guard for this loop, added for an Electron project in
  July — but it only fires when `features.playwright_cli` is **false**. It
  covered "no browser configured" and missed "browser configured, but this agent
  cannot reach it". Both changes above close that second case.

### Known issues

- An environmental block and a real defect still reach the workflow through the
  same signal (`**Approved:** no` + a blocking count), so a gate that *cannot
  run* is indistinguishable downstream from one that ran and failed, and can
  still enter the fix pipeline as work no developer can complete. Giving QA a
  distinct "gate could not run" channel is the real repair; the changes above
  remove the cause that has actually fired, not the class.

### Upgrade steps

**In Build Studio** — this touches both the hub and the project-server, so it
needs a full rebuild and inject, then an app restart:

```bash
cd packages/hub && npx next build
cd packages/desktop && node inject-resources.js
```

Running project-servers need restarting too, or agents launched from them keep
using the old prompt assembly.

**In each managed project** — nothing to do. The role and skill files are read
where they already are; nothing is copied, moved or rewritten.

### Notes for forks

`agent-skills.js` resolves the names by **existence on disk**, never from a
list — `.claude/commands/<name>.md` for a `/name` reference, and
`.claude/skills/<name>/SKILL.md` for a backticked `` `name` skill `` reference.
Two invariants to preserve if you extend it:

- The command pattern is anchored on a word boundary before the slash, so path
  segments (`docs/qa/…`, `e2e/support/…`) cannot match. Loosening that inlines
  role files into prompts that never asked for them.
- If a CLI gains native `.claude/` loading, add it to `NATIVE_CLAUDE_DIR_CLIS`
  or its agents get the definitions twice.

Oversized files are skipped and *named* as skipped in the prompt rather than
truncated — an agent handed a silently-cut role definition treats the fragment
as the whole thing.

---

## 2026-08-09 — Recover no longer strands a planner step

### Fixed

- **Recovering a planner that died without reporting left the step with no way
  forward.** When an agent exits without posting its feedback, Recover falls
  back to reconstructing a report from the commits on the branch. That is right
  for a Dev agent, whose deliverable *is* the diff — and structurally wrong for
  a planner, whose entire output is the JSON task list it posts and which never
  touches git. So Recover filed a prose summary of *other* agents' commits under
  the planner's name, marked the step `done`, and reaped its window. The
  `fix_plan` approval gate then rejected it — correctly, since it parses planner
  feedback for a ```json block — and the run was stuck: the step could be
  neither approved nor recovered again.

  Recover now refuses the git fallback for `Planner` and `Fix Planner` and says
  why, pointing at Relaunch. A planner that reported nothing produced nothing to
  lose, so relaunching costs only the re-run. Transcript recovery is unchanged
  and still preferred for both roles — a planner's own words *do* contain its
  plan; only the commit-based reconstruction was ever incapable of recovering
  one.

### Upgrade steps

**In Build Studio** — sync the project-server into the app bundle and restart
it, then restart any running project-servers:

```bash
cd packages/desktop && node inject-resources.js --sync-only
```

**In each managed project** — nothing to do.

### Notes for forks

`exit-recovery.js` now exports `isPlanningRole()` and `PLANNING_ROLES`, and
`hasRecoverableWork(facts, role)` takes the role as an optional second argument
(omitting it keeps the old behaviour). If you add a role whose deliverable is a
plan rather than a diff, add it to `PLANNING_ROLES` — the matching uses the same
normalisation as the workflow API's `normalizeRole`, so spelling variants are
already covered.

---

## 2026-08-07 — Make the learnings system measurable per project

A review of the knowledge/learning system asked three questions: is it used,
can we tell where, and does it stop issues recurring. The first had an answer
(5.8% of injections are applied), the second did not, and the third was being
answered by a counter that had been dead for months.

### Added

- **Per-project learning counters.** `learnings-stats.json` now records
  `byProject` alongside the global totals, so "is this earning its keep in the
  project I am actually working in" becomes answerable. The global rate says
  whether the system works at all; only this says where.

### Changed

- **Stack-specific learnings no longer reach projects without that stack.** The
  injection budget is six entries per prompt, and the entries consuming it
  hardest were framework trivia in the wrong place: `Svelte bind:value…` at 831
  injections and **zero** applications, `@next/mdx auto-pipeline…` at 711/0,
  `__NEXT_PRIVATE_STANDALONE_CONFIG…` at 665/0. Fifty-eight Swift-tagged
  entries sat in the shared pool, eligible for an Electron/TypeScript project
  where none could ever apply.

  A learning with no stack tag is a general engineering principle and is
  **always** eligible — those are the entries that actually get applied, at
  18-29%. Only a learning declaring a stack the project lacks is dropped, and
  if the project's stack cannot be determined nothing is dropped at all.
  Withholding a relevant learning is a silent regression that resurfaces weeks
  later as a repeated mistake; showing an irrelevant one costs a sixth of a
  prompt. Measured on this installation: 22% of the eligible pool filtered for
  an Electron project, 4% for an iOS one, and **no project loses any of its own
  captured learnings**.

- **`timesCited` and `recurrences` are retired.** Both date from the
  keyword-citation era — which "cited" 67% of injections on coincidence — and
  neither has been written since self-reporting replaced it. A
  `recurrences: 5536` total reads like a live measurement of prevented
  recurrence, and nothing measures that. They now sit under `legacy` on each
  entry, and the stats file is backed up once before the first rewrite.

  **Recurrence prevention is still not measured.** Self-reporting captures
  claimed use, which is a different thing. Worth knowing before drawing
  conclusions from the numbers.

### Fixed

- **An agent you revive from the live terminal now clears its own error.** The
  watchdog's dead-process verdict was final: once an agent was marked `error`,
  nothing re-examined it. But that verdict is about a process, and a human can
  change the fact underneath it — answering a blocking prompt in the terminal
  revives an agent that has already been written off.

  Seen on a fix_execution run: the pane fell back to a shell, the agent was
  marked *"process exited… after 20m of work"*, the owner answered the question
  in the terminal, and the agent carried on working — while the card still
  showed an error and still offered **Recover** and **Approve**. Both move the
  step, and once the step moves the agent's eventual report is refused as
  belonging to a closed one, discarding the work in flight.

  The watchdog now clears the error and returns the agent to `running` when the
  pane shows a real agent process **and** the log is actively producing output.
  Both signals are required: a non-shell pane command alone could be a transient
  tool child, and recent output alone could be a dying process's last gasp.
  Getting this wrong is self-correcting — a falsely revived agent is re-judged
  on the next tick — whereas the old behaviour stayed wrong until someone
  noticed.

### Upgrade steps

**In Build Studio** — project-server only: `cd packages/desktop && node
inject-resources.js --sync-only`, then restart the project-servers.

**In each managed project** — nothing to do. Stack detection is automatic, and
the legacy-counter migration runs on first read.

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

  **For npm the verdict comes from `npm audit fix --dry-run`, not from reading
  the lockfile — and not from npm's `fixAvailable` flag either.**
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

- **One file per status listing lost its first letter and sat in the wrong
  box.** The CI/CD tab showed `ocs` for `docs/…` and `2e` for `e2e/…`, filed
  under *staged* while actually being merely modified.

  `git status --porcelain` is columnar — `XY <path>`, index status then worktree
  status — so a leading space is data: `" M docs/a.md"` means *modified, not
  staged*. The command's output was passed through a `.trim()` that is correct
  for every other read in that module (a branch name, a rev count) and wrong
  here. It stripped the leading space from the **first line only**, which is why
  exactly one row misbehaved at a time: the line then read as index-status `M`,
  landing in the staged list, and the fixed-width path offset ate one character.

  Counts and the *Commit all changes* button were unaffected — the file was
  still counted, just under the wrong heading — which is why this stayed a
  cosmetic annoyance rather than causing a bad commit. "fatal: invalid refspec ''".** `git branch
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

- **A verdict needs attribution, not just evidence.** npm's update plan names
  packages without paths, so it says nothing usable about a package installed at
  several versions at once — which is normal, not exotic. `npmInstalledCopies`
  exists to detect that, and the plan is consulted only when exactly one copy is
  present. Any signal keyed on a bare package name deserves the same suspicion.

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

- **Pass `--include=dev` to any npm command the project-server runs.** It is
  spawned with `NODE_ENV=production`, which npm reads as `--omit=dev` — so an
  audit reports *zero* vulnerabilities on a project whose advisories are all
  devDependencies, and every dependent check silently degrades to "could not
  tell" instead of failing. Build tooling is exactly where these advisories
  live, so the omission is close to total.

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
