# Following Build Studio from a remote assistant

For an assistant (Codex, Claude Code, or similar) that runs **on the same
computer as Build Studio** and answers the owner, for example by voice from a
phone through the assistant's own mobile pairing. Build Studio listens only on
this computer and has no authentication, so the assistant calls it locally;
nothing here is exposed to the network.

Background: [the work queue plan](plans/work-queue-and-remote-overview.md).

## Where things are

- **The hub:** `http://127.0.0.1:18080`.
- **Each project's server:** `http://127.0.0.1:<port>`, where the port is the
  `port:` in that project's `.build-studio/config.yaml`. The overview below
  lists every project; `GET /api/health` on a port confirms which project
  answers there (`name`, `projectRoot`).

## Reading (safe at any time)

These change nothing, so call them as often as needed.

| Question | Call |
|---|---|
| "How is my work plan going?" / "What is running?" / "Which projects need me?" | `GET 18080/api/overview` |
| "What is next in <project>?" / "Is the next job ready?" | `GET <port>/api/work-queue` |
| "Why has this job stopped?" | `GET <port>/api/workflow`: `needsAttention` and the current step's agents |
| The backlog, without changing it | `GET <port>/api/backlog?readonly=true&fields=status` |

Never use `GET /api/backlog` without `readonly=true` for monitoring: the
normal read writes files.

### Reading the overview

`GET 18080/api/overview` returns `{ observedAt, projects: [...] }`. Per project:

- `source`: `live` (its server answered), `persisted` (its server is down;
  this is what its state files last said) or `unavailable` (down, and no
  files). **Only `live` describes the present.** Say "the server for X is not
  answering" for the others; never call such a project idle or done.
- `work`: what is running (`item`, `type`, `step`, `task`, `agents`), or
  `null` when nothing is. `fromQueue` says whether the queue started it.
- `needsOwner`: when set, the run is waiting on the owner; `title` and
  `detail` say why and `action` says what to do.
- `progress`: `lastActivity` and `lastCommit`, the evidence it is moving.
- `queue.current`: the job most recently started from the queue and its
  `status.state`; `queue.next`: the next planned job, `ready` and, when not
  ready, `reason`; `queue.following`: the few after it.

### What the states mean

Use these words with the owner, and keep them distinct:

| State | Means |
|---|---|
| running | agents are working; `progress.lastActivity` shows when they last did |
| waiting for you | `needsOwner` is set, or `queue.current.status.state` is `waiting_for_owner` |
| ready to merge | the run reached its merge gate; only the owner approves a merge |
| owner checks | merged; the run lists recommended manual checks (`steps.owner_checks.checks`). Optional: read them to the owner; the owner runs them (Done), saves them for later, or skips them, with no proof. Saved ones are in `queue.savedChecks` |
| finished | the job's own phase verifiably finished (a draft has its PRD, a review left the item Reviewed, a build or fix merged) |
| stopped | the run ended without finishing its phase (cancelled, for instance) |
| blocked | `queue.next.ready` is false; `reason` is the start's own refusal |

An old `lastActivity` alone is not a stall while agents are listed as
running. A QA step marked done by hand is not a pass.

## Acting (only when the owner says so)

Each of these changes something. Do one only when the owner asked for it in
this conversation, and say what you did.

| The owner says | Call |
|---|---|
| "Queue FAZ-123" | `POST <port>/api/work-queue` `{ "item": "FAZ-123" }`, optional `"action"` (`draft`, `review`, `execute`, `bugfix`), `"position"`, `"note"` |
| "Move it first" / "Remove it" | `PATCH <port>/api/work-queue/<entryId>` `{ "position": 0 }` / `DELETE <port>/api/work-queue/<entryId>` |
| "Merge it" (the run is ready to merge) | `POST <port>/api/workflow/advance` `{ "action": "approve" }` |
| "Done with the checks" (the run is at owner checks) | `POST <port>/api/workflow/advance` `{ "action": "approve" }` |
| "Save the checks for later" / "Skip the checks" (at owner checks) | `POST <port>/api/workflow/advance` `{ "action": "save_for_later" }` / `{ "action": "skip" }` |
| "I did the saved checks for FAZ-123" / "Drop them" | `DELETE <port>/api/work-queue/saved-checks/<id>?outcome=done` / `?outcome=skipped` (the id is in `queue.savedChecks`) |
| "Start the next one" | if the previous run's step is `completed`: `POST <port>/api/workflow/finish` first, then `POST <port>/api/work-queue/<next.entryId>/start` |

Rules that hold whatever the owner's words:

- **Never start a job, approve a merge, or approve any other gate on your own
  initiative.** The queue never starts the next job by itself in this
  version, and neither does the assistant.
- **A start can be refused.** Read the response's `error` to the owner as it
  is; do not retry with `"override": true` unless the owner says so after
  hearing the reason.
- **Repeating a start is safe:** a start that already happened answers
  `alreadyStarted` and the existing run, never a second one.
- **Removing a queue entry never cancels its work.** Cancelling a run is a
  separate decision; do not do it from here.
- **Never quit, restart or kill Build Studio or a project server.**
