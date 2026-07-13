---
title: "Adding auth preHandler to a route requires updating all its test files simultaneously"
date: 2026-03-25
severity: high
tags: [auth, fastify, prehandler, test, vitest, mock, regression]
component: testing
---

When `requireAuth` (or any auth preHandler) is added to an existing route, pre-existing tests that use `fastify.inject()` without auth cookies get 401 or 500 responses instead of the expected business logic responses. Fix: add `vi.mock('../routes/auth.js', () => ({ requireAuth: vi.fn(), ... }))` to every test file that exercises that route — in the same commit as the route change. Failing to do this in the same pass caused 30+ test regressions across 3 rounds in PRD-016.
