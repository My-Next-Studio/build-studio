# Project Agent Instructions

This is the canonical agent-instructions file for this project, read natively
by OpenCode and Codex. Claude Code picks it up via the `@AGENTS.md` import in
`CLAUDE.md`. Edit HERE — not in `CLAUDE.md`.

**Read `docs/project-state.md` first — it is the single source of truth.**

**Before exploring the codebase, read `ARCHITECTURE.md`** (repo root) — the
maintained component map, test seams, and guardrails. Don't re-derive what it
already tells you. If your change alters the component map, revise
`ARCHITECTURE.md` in the same commit: edit the entry it affects rather than
adding a paragraph, delete entries for removed code, and keep it under 20 KB.
It is the map of the code as it is now; a PRD's story belongs in the PRD.

## Docs Map

- `docs/backlog/<PREFIX>-NNN.md` — backlog items (user stories, bugs, tasks).
  An ID like `MS-002` (any casing) always refers to one of these files.
- `docs/prds/` — PRDs, one per iteration. New PRDs start from
  `docs/prds/TEMPLATE.md` — never copy the format from an older PRD.
- `docs/project-state.md` — current state, roles, conventions (source of truth).
- `docs/backlog-index.md` — the backlog's order, one line per item file.
  Status is rendered from the item files; don't edit it here.
- `docs/decisions.md` — the Key Decisions Log. Not required reading; open it
  when a document cites a decision.
- `docs/asset-register.md` — operational assets inventory (domains, hosting,
  accounts). References to credentials only — never secret values.
- `docs/learnings/` — captured lessons, injected into future agent runs.

`node scripts/check-docs-budget.mjs` fails when `docs/project-state.md` passes
40 KB or `ARCHITECTURE.md` 20 KB, or when `ARCHITECTURE.md` names a path that
doesn't exist. CI runs it.

## Project-Specific Notes

<!-- Add project-specific conventions, installed plugins, overrides, etc. below -->
