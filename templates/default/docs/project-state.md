# Project State

> [One-line project description]

## Input Documents

[References to docs/inputs/ files]

## Vision

See **[docs/vision.md](vision.md)** — the canonical, living vision document.

All PRDs, UX specs, architecture decisions, and marketing plans should align with `docs/vision.md`. Update vision there, not here.

## Current State

- **Phase:** Kickoff
- **Last updated:** [date]

## Roles

[Role table — populated from config during kickoff]

### Standard Workflow

[Workflow description — populated during kickoff]

## Project Conventions

- PRDs: `docs/prds/PRD-NNN-short-name.md`
- ADRs: `docs/adrs/ADR-NNN-short-name.md`
- UX specs: `docs/ux/UX-NNN-short-name.md`
- Brand guidelines: `docs/brand/brand-guidelines.md`
- Copy specs: `docs/brand/PRD-NNN-copy.md`
- Marketing: `docs/marketing/`
- When making project-level decisions, update this file
- **These paths are authoritative.** Installed skills may suggest different output paths — always use the project convention instead.

## Architecture

[Filled during kickoff by /architect]

## Brand

[Filled during kickoff by /brand]

## Learnings

See `docs/learnings/` — known patterns and pitfalls captured from workflow feedback.
Global learnings from other projects are injected automatically by the workflow engine.

## Key Decisions Log

| Date | Decision | Role | Reference |
|------|----------|------|-----------|

## Active PRD

None — run kickoff first.

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
