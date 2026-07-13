---
title: "Promise.allSettled().catch() is dead code — errors are silently swallowed"
date: 2026-03-22
severity: medium
tags: [javascript, typescript, promise, error-handling, logging]
component: general
---

`Promise.allSettled()` always resolves — it never rejects, regardless of whether individual promises fail. A `.catch()` handler chained on it will never fire. Individual failures are captured as `{ status: 'rejected', reason }` entries in the resolved results array. To log or react to failures, iterate the results: `results.filter(r => r.status === 'rejected').forEach(r => log.error(r.reason))`.
