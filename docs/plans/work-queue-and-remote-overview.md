# Plan: a work queue, and an overview a remote assistant can read

> **Status: implemented 2026-10-11 (first version: planning, visibility, readiness, explicit starts).** The assistant's guide is [`docs/remote-assistant.md`](../remote-assistant.md).
>
> Owner request: plan the work at the desk as an ordered list of jobs per
> project ("review this story, then build that one, then fix this bug"), and
> follow that plan while away from the computer, through a voice assistant on
> a phone that reads Build Studio's state and starts the next job when the
> current one is done. Backlog order is not the plan: the plan mixes phases,
> stories and bugs in an order chosen on purpose.
>
> This is the first step. It covers planning, visibility, readiness and
> explicit starts. Starting the next job automatically, and notifications, come
> later, once the queue and the status it reports can be trusted.

## What exists today

- **No work queue.** `lib/api/queue.js` is an older *instruction* queue: notes
  addressed to agent roles, appended to `docs/instructions-queue.md`. Nothing
  reads it to start work, and its hub tabs (`queue-tab`, `instruct-tab`,
  `plan-tab`) are imported nowhere. It can be removed with this work.
- **A cross-project status, partly wrong.** The hub's `/api/global-status`
  fetches each project's workflow and monitor summary. It counts agents from
  `steps[currentStep].agents` only, which is empty during task execution (the
  task agents live under `taskExecution.taskStates`), so a busy run reads as
  0 of 0 agents and "waiting". It does not use `deriveNeedsAttention`, which
  knows the real reasons a run needs the owner.
- **Start checks live inside the start handler.** `POST /api/workflow/start`
  checks type, CLI, builder role, active workflow, backlog status per phase,
  PRD present and tracked, dependencies, companion specs, the Role line, and
  git state, inline. `GET /workflow/start-readiness` is a lighter advisory, and
  the hub mirrors some gates in `backlog-tab.tsx`. Drafting has its own checks
  in `POST /draft/start`.
- **Reading the backlog writes files.** `GET /api/backlog` applies automatic
  status transitions (writing item files) and refreshes the index. A monitor
  must never do that.
- **No remote access.** Both servers listen on 127.0.0.1 with no
  authentication; the README's only advice for remote use is an SSH tunnel.

## The model

### A queue entry

One entry is one job: a backlog item (story or bug) to take one phase further.
What the phase is depends on the item when the job starts, so any item can be
queued whatever its status.

| Field | Meaning |
|---|---|
| `id` | Stable, generated. Survives reorders and restarts. |
| `item` | Backlog id. |
| `action` | Optional. Empty means "the next phase for its status", decided at start. |
| `note` | Optional owner note ("after the copy is approved"). |
| `addedAt` | When it was queued. |

At start the action is the one given, or the one the item's status implies:
no PRD yet → `draft`, Drafted → `review`, Reviewed → `execute`, a Bug →
`bugfix`. The entry then becomes **current** and records the run it started
(`run`, `action`, `startedAt`).

An entry covers one phase. To take a story through draft, review and build,
queue it again after each phase, or queue it twice up front. Tasks inside a
workflow are not entries; they show in the current entry's progress.

### No history: only the current entry

The queue keeps the pending entries and one current entry, the job most
recently started, whatever its state: running, held for the owner, waiting at
the merge, or finished. When the next job starts, the current entry drops off.
That is enough to answer "X-1 is ready to merge; next is X-2", and a run's own
record (workflow state, snapshots, commits) already holds its history. Removing
a pending entry is the only other way one leaves.

### Planned order and readiness are separate

- **Next planned** is the first pending entry, in the owner's order. Always.
- **Ready** is whether that entry would start right now, for the action it
  would take. When it would not, the entry stays where it is, with the reason
  (another workflow is active, the item has no PRD for a review, a companion
  spec is incomplete, the default branch is dirty, the item no longer exists, …).
  The queue never jumps it, and never substitutes another item.

Readiness is the start routes' own checks, extracted into one function each
for workflows and drafts, which both the start routes and the queue call. A
check that lives only in a start handler cannot drift from what the queue
reports, because it is the same code.

### When the current entry is finished

Finished means its own phase verifiably finished:

| Action | Finished when |
|---|---|
| `draft` | The draft session ended and the item has a PRD. |
| `review` | The review workflow completed and the item is Reviewed. |
| `execute` | The execution workflow merged (item Implemented). |
| `bugfix` | The bugfix workflow merged. |

Every execution and bugfix run stops at the merge gate, so "ready to merge" is
a state the owner sees and answers; approving the merge stays the owner's
call, as do any other gates. A cancelled run, or a QA step marked done by hand,
is not finished. Nothing starts the next entry by itself.

### Work started outside the queue

The overview shows what is running whether or not the queue started it. When a
run starts for an item that has a pending entry, the first such entry becomes
the current one, linked to that run (entries are items, so the match is
unambiguous). A run for an item not in the queue shows as current work
"started outside the queue".

## The overview

One read, across every registered project, built for a short voice answer
first and detail on request:

1. Current item and phase, or idle.
2. The current task and the agents running it (task agents included).
3. Recent progress: last commit, last agent activity, with times.
4. What needs the owner, using `deriveNeedsAttention`'s reasons (owner action,
   held fix loop, gate could not run, stalled agent, completed but not
   finished).
5. Next planned entry and whether it is ready, with the reason if not.
6. The few entries after it.

Every project block says when it was observed and from where: **live** (its
server answered), **persisted** (read from its state files on disk because the
server is down) or **unavailable**. A server that does not answer is never
reported as idle or done.

Words the answers distinguish: *running*, *waiting for you*, *blocked*,
*possibly stalled* (an old timestamp alone is not a stall while task agents
are still active), and *done (verified)*.

## APIs

Per project, on the project server:

- `GET /api/work-queue`: the current entry and its run's state, the pending
  entries, and the next one's readiness.
- `POST /api/work-queue`: add (`item`, optional `action`, `position`, `note`).
- `PATCH /api/work-queue/:id`: move it, or edit its action or note.
- `DELETE /api/work-queue/:id`: remove a pending entry. Never cancels work and
  never touches the backlog item.
- `GET /api/work-queue/:id/readiness`: the start checks for that entry, read-only.
- `POST /api/work-queue/:id/start`: optional `action`; re-checks everything, then
  starts through the existing draft or workflow start. Idempotent: a repeated request for an entry
  already started returns that run instead of a second one. A refusal returns
  the reason.

Across projects, on the hub:

- `GET /api/overview`: strictly read-only. Reads workflow, draft and queue state
  and the backlog without the GET route's write path.

## Decisions (owner, 2026-10-11)

1. **The remote assistant runs on this computer.** The phone reaches it through
   the assistant's own mobile pairing, and the assistant calls these local
   APIs. Build Studio stays loopback-only and gains no authentication surface.
   A short guide tells the assistant which calls answer which questions.
2. **Each project's queue is local state:** `.build-studio/work-queue.json`,
   next to `workflow-state.json`, not committed. Its server owns it; when the
   server is down the hub reads the file and reports it as persisted.
3. **No history.** Pending entries plus the one current entry (above).
4. **Any item can be queued.** The phase is decided when it starts, from the
   item's status unless one is named; an entry covers one phase.
5. **A run started elsewhere for a queued item links to its entry**
   automatically.

## Build order

1. Extract the workflow and draft start checks into readiness functions the
   start routes call, and give the backlog a read path that writes nothing.
2. The queue: store, routes, start, the link to runs started elsewhere, and
   finished detection.
3. The hub overview: task agents counted, `deriveNeedsAttention` used, and
   live, persisted or unavailable per project.
4. The hub UI: "Add to queue" on backlog rows, the project's queue with
   reorder and remove, and the overview cards.
5. The assistant's guide: the calls, what each answer means, and which ones
   change something.

The old instruction queue (`lib/api/queue.js` and its unused tabs) is removed
in step 2.

## Acceptance

- Three entries queued in a chosen order, items in different statuses and a bug.
- The order survives an app and server restart.
- The desktop and the remote assistant read the same queue and status.
- A blocked first entry stays next planned, with its reason.
- Work started outside the queue appears as current work.
- Task agents count in the progress summary.
- A project whose server is down shows as persisted or unavailable, never idle.
- Reading the overview changes no file.
- Starting an entry re-checks readiness, and a repeated start creates no
  second run.
- The current entry is finished only when its own phase has verifiably finished.
- Nothing starts the following entry automatically.
