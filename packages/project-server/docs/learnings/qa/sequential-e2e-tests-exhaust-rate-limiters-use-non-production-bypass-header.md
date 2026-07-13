---
title: "Sequential E2E tests exhaust rate limiters — use a non-production bypass header"
date: 2026-03-26
severity: medium
tags: [rate-limiting, e2e, playwright, testing, fastify, backend, node-env]
component: testing
---

When multiple E2E tests submit forms sequentially from the same localhost IP, the per-IP rate limiter triggers 429 on later tests even though each test is independent. Fix: add a bypass code path in the backend (e.g., check for an `x-test-mode: bypass-rate-limit` header) guarded strictly by `NODE_ENV !== 'production'`, and set the header globally in E2E tests via `test.beforeEach(() => page.setExtraHTTPHeaders(...))`. Never expose this bypass in production — the `NODE_ENV` guard is mandatory.
