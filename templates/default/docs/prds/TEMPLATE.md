# PRD-NNN — <Title>

> **This is the canonical PRD template.** Copy it to `docs/prds/PRD-NNN-short-name.md`
> when drafting — do not reverse-engineer the format from an older PRD. Replace every
> `<placeholder>`, delete the guidance blockquotes, and delete any optional section
> that genuinely doesn't apply. Writing economy: state each requirement once, in the
> section that owns it; other sections reference it ("per §2.1"), never restate it.

**Backlog item:** `<PREFIX>-NNN` — <item title>
**Status:** Draft
**Owner:** PM

## 1. Problem & Goal

> Why this exists and what outcome it buys. 2–5 sentences, no solutioning.

## 2. Solution

> The builder's spec — the highest-value section. Subsections per area
> (§2.1, §2.2, …) with concrete `file:line` references and named seams where
> they exist. Precision here is never the thing to trim.

### 2.1 <Area>

## 3. User Stories (optional)

> Only when they add information beyond the ACs. If the ACs fully cover
> behavior, delete this section rather than paraphrase them.

## 4. Acceptance Criteria

> Numbered, testable, complete — every AC gets verified against the
> implementation during code review and AC verification.

- **AC-1** —
- **AC-2** —

## 5. Out of Scope

> Explicit exclusions. Reviewers are instructed not to raise issues about
> anything listed here — so list what you're deliberately not doing.

## 6. Test Plan

> What proves the ACs: unit tests, E2E, manual demo steps. Name the test
> files/targets when known.

## 7. Risks & Open Questions

> One row per risk: risk, impact, mitigation/owner. Open questions get an
> owner and a deadline (usually "before execution").

## 8. Dependencies (optional)

> Other backlog items, external services, or decisions this blocks on.

## 9. Revision History

> One line per review round — e.g. "Round 2: 2 MEDIUM + 1 LOW folded into
> §2.1/AC-2". The narrative lives in the workflow feedback history, not here.

- Round 0: drafted.

## 10. Companion Specs

> Delivery table for specs authored by other roles (UX spec, ADR, copy deck, …)
> before execution starts. **Exactly one owner per row** — the execution
> workflow spawns one agent per listed role. Required rows must have a path and
> the file must exist on disk before the Preparation → Execution gate passes.
> If this PRD truly needs no companion specs, keep the section with the note
> "None required" — the merge gate looks for this section by name.

| Spec | Owner | Path | Required | Status |
|------|-------|------|----------|--------|
| <UX spec: `<short scope>`> | /ux | docs/ux/UX-NNN-<name>.md | Yes | Pending |
