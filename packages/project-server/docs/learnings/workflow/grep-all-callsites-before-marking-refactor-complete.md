---
title: "Grep for all call sites before marking a function removal/move refactor as complete"
date: 2026-03-27
severity: medium
tags: [refactor, grep, callsites, scope, completeness, review]
component: general
---

When a PRD removes or relocates a function call, the documented call sites are often incomplete — other files call the same function for related (but separately evolved) reasons. Always grep the entire codebase for the function name before considering the refactor done. In PRD-018, the PRD documented two call sites to remove (`publish.ts`, `stream-helpers.ts`) but a planner search found a third in `events.ts` POST handler that the PRD missed; leaving it would have contradicted the single-pass sanitization principle the PRD introduced.
