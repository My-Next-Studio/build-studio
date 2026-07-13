---
title: "Playwright `request` fixture does not update after loginViaApi() — use newContext() for multi-user tests"
date: 2026-03-22
severity: medium
tags: [playwright, e2e, authentication, request-context, testing]
component: testing
---

Calling `loginViaApi(page, email)` updates the cookies on `page.request` (browser context) but the standalone `request` Playwright fixture retains its original session. API calls via `request.post(...)` still execute as the first authenticated user, so non-owner 403/401 assertions always get 200/204 instead. To test as a different user via the API, create a fresh context: `const ctx = await request.newContext(); await loginViaApi(ctx, email2)` and use `ctx` for subsequent calls.
