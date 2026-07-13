---
title: "Shared module signature changes must update all callers in the same commit"
date: 2026-03-25
severity: high
tags: [typescript, refactor, module, async, caller, compile-error, runtime-crash]
component: api
---

When a shared module's function signatures change (e.g., adding a required parameter, making a function async), every caller must be updated in the same commit. Partial updates compile in Vitest (which bypasses tsc) but fail `tsc --noEmit` and crash at runtime — e.g., a `userId` passed as `undefined` violates a NOT NULL DB constraint, or calling `cache.delete()` on a variable that no longer exists throws a ReferenceError. In PRD-016, generation-cache.ts was rewritten to DB-backed but four call sites (events.ts, publish.ts, stream-helpers.ts, refine-stream.ts) were updated in a separate commit, causing 17 TypeScript errors and runtime crashes.
