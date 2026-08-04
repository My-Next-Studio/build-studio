# Plan: CI/CD tab — monitor CI after a push, notify on failure, highlight the tab

> **Status: implemented 2026-08-04.** All three gaps closed, alongside
> [monitor-tab.md](monitor-tab.md) — they shared G-1 and it was built once, as
> a cache in the project-server (`lib/github-cache.js` + `lib/monitor.js`)
> rather than as a second poller, so `/deployment/ci-status` stopped shelling
> out per request and the hub's existing 6-second poll now carries CI state.
> G-2: red `pulse-border-red` on the CI/CD tab, its owning function and the
> status-bar project button. G-3: Electron main-process notifications
> (`shared/ci-notify.js`), firing on failure **and** on recovery, on transitions
> only. The cadence question raised below was answered by decoupling: the UI
> cadence and the GitHub cadence are no longer the same number.
>
> **Original request follows.** Owner request: after pushing from
> Operations → CI/CD, the run's progress should be visible from that tab, a
> failure should raise a notification, and the tab should be highlighted the way
> it already is when a workflow is waiting for input.
>
> Independent of any single project. It applies to every managed project that
> already has GitHub Actions — 12 of them at the time of writing — so it can be
> built and verified today against any of those.

## What already exists — most of it

`packages/hub/components/cicd-tab.tsx` (974 lines) is further along than the
request assumes:

- **Push** — `handlePush` → `POST /deployment/push` (`:258-272`), gated on
  `canPush = info.hasRemote && info.deployCommits.length > 0` (`:303`).
- **CI status** — `GET /deployment/ci-status` (`:110`), with a light always-on
  poll so "the badge stays current" (`:139`) and cleanup on unmount (`:126`).
- **Rendering** — a "CI Health — always-on status + failure investigation"
  section (`:562`) showing run `status`/`conclusion` and **per-job** rows with
  `StatusDot` (`:574-659`).
- **Failure investigation** — an agent path, `POST /deployment/ci-investigate`
  + `/status` polling (`:167-201`), including a fix strategy
  (`ciFixStrategy: 'push' | 'pr'`) that can push a fix branch or open a PR.

So "monitor progress from that tab" is largely **already true while the tab is
open**. The gaps are about what happens when it *isn't*.

## The three gaps

### G-1 (structural) — CI status is only polled while the tab is mounted

The poll lives inside `cicd-tab.tsx` and is torn down on unmount (`:126`). You
cannot be highlighted or notified about a failure you are not already watching,
which is precisely the case the owner is asking for.

**This is the load-bearing change.** CI status has to be lifted to a
project-level concern, polled alongside the existing workflow brief, so the tab
selector and the global status bar can read it without the CI/CD tab being open.
Everything else in this plan is cheap once that exists.

Open question for whoever picks this up: does it belong in the same poll that
produces `wfBrief` (one request, one cadence), or a sibling? The workflow brief
polls fast because a waiting workflow blocks a human; CI runs take minutes and
tolerate a much slower cadence. Folding them into one interval likely means
polling GitHub far more often than needed — worth a deliberate decision rather
than convenience.

**Cadence is a constraint here, not a tuning detail.** `GET /deployment/ci-status`
shells out to `gh run list` per call (`packages/project-server/lib/api/deployment.js:485`).
Today that only runs while the CI/CD tab is open, so the blast radius is one
project. Lifting it to a project-level poll multiplies it by every managed
project at once — 12 have GitHub Actions in this installation, and a fork's
number is its own. At a workflow-brief cadence that is a continuous stream of
authenticated GitHub API calls for runs that change every few minutes at most,
which risks rate-limiting the same `gh` credential the push button and the
CI-investigate agent depend on.

Three constraints the implementation should carry, whatever cadence it picks:

- **Only poll projects with `deployment.repo` configured.** Everything else has
  nothing to ask GitHub about.
- **Back off hard when nothing is in flight.** A project whose last run finished
  hours ago does not need the same cadence as one polled 30 seconds after a push.
- **Prefer push-triggered polling over unconditional polling.** The tab already
  knows when a push happened; that is the moment a run appears. Watching
  continuously for runs nobody started is the expensive way to learn nothing.

### G-2 — the attention mechanisms have no CI input

Both existing highlights are driven **solely** by the workflow signal
`waitingForInput`:

- **Tab selector** — `packages/hub/components/project-dashboard.tsx:319`:
  `hasNotification = wfBrief?.waitingForInput && wfFunctionId === fn.id`
- **Project button** — `packages/hub/components/global-status-bar.tsx:104`:
  `waiting = wf?.waitingForInput && wf.currentStep !== 'completed'`, driving
  `animation: pulse-border 2s ease-in-out infinite` + a
  `rgba(249,115,22,0.2)` outline (`:126-128`) and an orange status dot
  (`:136-140`).

A red CI run highlights nothing. The ask is to mirror this treatment for a
failed run — reusing `pulse-border` and the orange register rather than
inventing a second visual language.

**Design question worth settling before building:** the current highlight means
"a human is blocking the machine — go unblock it." A CI failure means something
different ("this is broken") and is not necessarily urgent. Reusing the identical
treatment risks diluting the waiting-for-input signal that currently has a
100% action rate. Consider whether CI-red deserves a distinct colour (red vs
orange) while sharing the pulse mechanic — a `/ux` call, not an implementation
detail.

### G-3 — no notification mechanism exists at all

Grepped `packages/desktop/` and `packages/hub/`: no `new Notification`, no
notifier, nothing. This is net-new, and it is the one part with an
Electron-vs-web decision:

- **Electron `Notification`** (main process, `packages/desktop/`) — real macOS
  notifications that arrive when Build Studio is backgrounded, which is the
  actual use case (you push, then go do something else).
- **Web `Notification` API** from the hub — simpler, but requires permission and
  is scoped to a focused/open renderer, which mostly defeats the purpose.

Recommend Electron main-process. Also decide: notify on **failure only** (the
owner's literal ask), or on failure **and** first success after a failure — a
green-after-red is arguably the other moment worth surfacing, and without it you
have to go look anyway to learn it recovered.

## Scope

- Lift CI status to a project-level poll (G-1), with a deliberate cadence
  separate from the workflow brief, scoped to projects that have a
  `deployment.repo` and backing off when no run is in flight.
- Feed run state into the tab selector and global status bar (G-2), reusing
  `pulse-border` and settling the colour question.
- Add a desktop notification on CI failure (G-3), main-process, with the
  failure-only vs also-recovery decision made explicitly.
- **Not in scope:** changing the push flow, the CI-investigate agent, or the
  existing in-tab rendering. All three work.

## Verification

- Push from the tab, navigate away to another tab/project, let CI fail →
  the CI/CD tab highlights and a notification arrives without the tab ever
  being reopened. This is the whole point; if it only works with the tab open,
  nothing was fixed.
- A passing run produces no highlight and no notification (no noise on green).
- Highlight clears when the failure is acknowledged or a later run succeeds —
  decide which, and make it deliberate; a highlight that never clears becomes
  wallpaper.
