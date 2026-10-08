# Backlog index

The order of the backlog: one line per item file in `docs/backlog/`, grouped
by release. Build Studio renders each line's `[Type · Status]` from the item
file and reorders lines when you drag them in the Backlog tab. Add a line
when you create an item, remove it when you delete one; never edit a
status here.

## Backlog

> **PRD-004 format.** Each backlog item is one file at `docs/backlog/<PREFIX>-NNN.md`
> (YAML frontmatter: `id, title, type, status, release, created, prd, depends_on, cost_actual_usd`).
> `<PREFIX>` is a 2–4 letter uppercase code derived from the project name
> (e.g. example-graph → `EG`, example-web → `EW`). The ordered list between the markers
> below is the source of truth for **membership and order** — the dashboard renders
> from it, so every item file MUST have a matching line here. See the `/pm` skill's
> backlog rules. Do **not** use a legacy markdown table.

<!-- BACKLOG-START -->

### [Release / phase name — e.g. "Phase 1 — Foundation"]

- [Filled during kickoff by /pm — one `- <PREFIX>-NNN — Title  [Type · Status]` line per item]

<!-- BACKLOG-END -->
