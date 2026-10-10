# Backlog API contract

**Status:** v1 · **Relied on by other Studio applications.** First consumer:
Launch Studio, which files backlog items into a product's backlog from its
launch plan (its LS-218 / PRD-128; client in
`launch-studio/src/main/playbook/backlog-bridge.ts`).

Everything below is a promise to code outside this repo. Changing a shape,
a status code or a field's meaning is a breaking change: it needs a matching
change in each consumer, so agree it with the owner first and record it here.
Adding a field is not breaking. The shapes are pinned by
`packages/project-server/lib/api/backlog-contract.test.js`, so a breaking
change fails Build Studio's own CI.

The rest of the project server's API is internal to Build Studio and carries no
such promise.

## Transport

- Each managed project has its own project server, listening on **127.0.0.1**
  only (`BUILD_STUDIO_LISTEN_HOST` opts out). Plain HTTP, JSON bodies, no
  authentication: the only clients are on the same machine.
- Consumers call from a process, not a browser, so CORS does not apply. No
  endpoint redirects.

## 1. Finding the server: the port

A consumer reads the top-level `port:` key in the product repo's
`.build-studio/config.yaml`, then confirms it reached the right project with
`GET /api/health` (§2).

That key is the project's one port. Build Studio starts the project server on
exactly that port (its registry's own port is only the fallback for a project
without the key), and never moves to another one: if the port is taken, the
server does not start and says why. A consumer that reads `config.yaml` finds
the server, or finds nothing listening, never a different project on a moved
port. The health check still guards against the rare case of something else
holding the port.

## 2. `GET /api/health`

**200**, always, with a JSON object. Relied on:

| Field | Type | Meaning |
|---|---|---|
| `ok` | `true` | The server is up. |
| `projectRoot` | string | Absolute path of the project this server serves. A consumer compares it with the repo path it expects, and must not file if they differ. |

The other fields (`name`, `uptime`, `startedAt`, `bundleVersion`) are internal
and may change.

## 3. `GET /api/backlog`

**200** with:

```json
{
  "groups": [{ "release": "Phase 1", "items": ["EX-001", "EX-002"] }],
  "items": { "EX-001": { "status": "Done", "...": "..." } }
}
```

- `groups` is the backlog's order: one entry per release section in
  `docs/backlog-index.md` (or `docs/project-state.md` in a project not yet
  migrated), in display order, each with its item ids in order.
- `items` maps every id to that item's front matter plus its body. Relied on:
  `status`, one of `Backlog`, `Drafted`, `Reviewed`, `Implemented`, `Done`,
  `Blocked`, `Fixing` (a bug under a bugfix run), or the legacy `Ready`,
  `In Progress`, `In Review`, still accepted on read. Other fields are present
  but not promised. A new status is a contract change.
- A project with no backlog index yet answers **200** with empty `groups` and
  `items`. **500** with `{ "error": string }` means the backlog could not be
  read at all.
- Reading has side effects: a Feature whose PRD file exists moves from
  `Backlog` to `Drafted`, and the index's `[Type · Status]` suffixes are
  refreshed. Neither changes order or membership.

### The lean read: `GET /api/backlog?fields=status`

The full response carries every item's body, and a large backlog passes a
megabyte (fazon's was 1.98 MB on 2026-10-10). A consumer that needs only the
order and the statuses asks for the lean form:

```json
{
  "groups": [{ "release": "Phase 1", "items": ["EX-001", "EX-002"] }],
  "items": { "EX-001": { "status": "Done" } }
}
```

- `groups` is identical to the full read's; `items` has the same ids, each with
  only `status`. The response has no other top-level keys. fazon's 412 items come
  to 16 KB.
- The same side effects as the full read run first, so the statuses match.
- `fields` accepts only `status`. Any other value, an empty one or a repeated
  one is **400** with `{ "error": string }`, never a different shape.
- Consumers that only read the order and statuses should use this form; the
  full read stays as it is.

## 4. `POST /api/backlog/items`

Creates an item, allocates its id, writes the item file and its line in the
backlog index, and commits both.

**Request body** (JSON):

| Field | Type | |
|---|---|---|
| `title` | string | Required. |
| `type` | `Feature` \| `Bug` \| `Task` | Optional; default `Feature`. |
| `body` | string | Optional markdown, tidied before it is written. |
| `depends_on` | string[] | Optional; every id must have an item file. |
| `release` | string | Optional; the item goes at the end of that release, which is created if it does not exist. |
| `after` / `before` | id | Optional position. Launch Studio does not send them. |

**201** with:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | The new item's id, matching `^[A-Z]{2,5}-\d{1,5}$`. Numbers are zero-padded to at least three digits (`RS-031`). |
| `release` | string \| null | The release it was filed under. |
| `commit` | object \| null | `null` when the project has no `.git`. Otherwise `{ committed: boolean, sha: string \| null, reason: string }`. `committed: false` means the item exists on disk but is not committed. |

`index` and `item` are also returned and are internal.

**400** with `{ "error": string }` when the input is invalid: a missing title,
an unknown type, a malformed or unknown `depends_on` id, a malformed
`after`/`before`, or a backlog index without its markers. Nothing is written.

The endpoint is neither atomic nor idempotent: a repeated request creates a
second item. A consumer that loses the response cannot tell whether the item was
created, and should treat that as uncertain rather than retry.

**Which branch.** The commit lands on whatever branch the project's checkout
is on, the same way drafting a PRD does, and that is intended. An item filed
during a run lands on the run's branch, is visible in the checkout at once, and
reaches the default branch when the run merges. If the run is cancelled instead,
the checkout returns to the default branch, where the item isn't yet; Build
Studio's cancel dialog lists such items first (`GET /api/workflow/cancel-impact`,
internal), and they stay on the run's branch unless it is deleted.

## 5. `docs/backlog/<id>.md`

A consumer may read an item's file directly, read-only, with Build Studio not
running. The file starts with YAML front matter (`id, title, type, status,
release, created, prd, depends_on, cost_actual_usd`); `status` is relied on, with
the values in §3. Consumers never write `docs/backlog/` or the backlog index;
`POST /api/backlog/items` is the only way in.

## Open decisions

Raised with the owner on 2026-10-10. Each changes behaviour that a consumer
sees, so none is made unilaterally here.

1. ~~The authoritative port~~ **Decided 2026-10-10 (owner):** `config.yaml`'s
   `port:` (§1). Build Studio starts the server on it and no longer falls back
   to the next free port; valkomna's `config.yaml`, which disagreed, was
   corrected.
2. ~~A lean backlog read~~ **Decided 2026-10-10 (owner):** added as
   `GET /api/backlog?fields=status` (§3). Launch Studio switches to it in its own
   backlog item.
3. ~~The branch a filed item lands on~~ **Decided 2026-10-10 (owner):** the
   current branch, as intended (§4). Committing to the default branch as well
   was ruled out: the run's own status updates to the backlog index would make
   its merge conflict.
4. **Versioning:** a path version (`/api/v1/…`) or a `contracts: { backlog: 1 }`
   field in `/api/health`. The second is additive and lets a consumer refuse an
   incompatible server cleanly.
