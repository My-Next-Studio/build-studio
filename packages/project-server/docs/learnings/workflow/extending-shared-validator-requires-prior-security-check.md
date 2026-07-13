---
title: "Extending a shared validator to new endpoints must re-verify prior security findings"
date: 2026-03-23
severity: medium
tags: [security, validation, shared-code, helper, audit, recurrence, workflow]
component: general
---

When a new PRD extends an existing shared validator (e.g., `validateResponses()`) to additional endpoints, known security findings from prior audits are not automatically applied. PRD-015 added new RSVP endpoints that reused `validateResponses()`, but the choice-value allowlist check found in PRD-013's security audit was still absent. Before starting a security audit on any PRD that modifies or reuses shared helpers, implementation agents should grep for the helper name and verify all prior security learnings tagged with the same component are applied.
