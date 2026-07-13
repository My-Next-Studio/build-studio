# Project Configuration

**Read `docs/project-state.md` first — it is the single source of truth.**

**Before exploring the codebase, read `ARCHITECTURE.md`** (repo root) — the
maintained component map, test seams, and guardrails. Don't re-derive what it
already tells you. If your change alters the component map, update
`ARCHITECTURE.md` in the same commit.

## Docs Map

- `docs/backlog/<PREFIX>-NNN.md` — backlog items (user stories, bugs, tasks).
  An ID like `MS-002` (any casing) always refers to one of these files.
- `docs/prds/` — PRDs, one per iteration. New PRDs start from
  `docs/prds/TEMPLATE.md` — never copy the format from an older PRD.
- `docs/project-state.md` — roles, conventions, backlog index (source of truth).
- `docs/asset-register.md` — operational assets inventory (domains, hosting,
  accounts). References to credentials only — never secret values.
- `docs/learnings/` — captured lessons, injected into future agent runs.

## Project-Specific Notes

<!-- Add project-specific conventions, installed plugins, overrides, etc. below -->
