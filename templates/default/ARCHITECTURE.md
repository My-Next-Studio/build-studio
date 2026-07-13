# ARCHITECTURE

The maintained map of this repo: what lives where, how the parts talk, the seams
tests rely on, and the guardrails a change must respect. Read this **before
exploring the codebase** — don't re-derive what it already tells you.

**Maintenance:** whoever changes the component map (new module, moved
responsibility, new seam or guardrail) updates this file **in the same commit**.
Keep it under ~2 pages. Status and conventions live in `docs/project-state.md`;
decision rationale lives in `docs/adrs/` — never duplicate either here.

> This is a new project — the sections below fill in as components land.
> Builders: when your PRD introduces the first real component, replace the
> placeholders with facts.

## System overview

_One paragraph: what the product is and the deployables it consists of._

## Components

| Dir | Responsibility | Stack / entry point |
|---|---|---|
| _—_ | _—_ | _—_ |

## Data flow & contracts

_How the parts talk: API base paths, auth mechanism, database + migrations,
storage, external services._

## Test seams & env toggles

_Mocks, test-only endpoints, env switches — with file paths._

## Test infrastructure

_Suites, exact run commands, external services tests need, conventions._

## Guardrails (must-not-break)

_Invariants a change must respect, each with its source (vision, ADR, CLAUDE.md)._

## Where things are documented

`docs/project-state.md` (source of truth — read first) · `docs/vision.md` ·
`docs/prds/` · `docs/adrs/` · `docs/backlog/` · `docs/learnings/`.
