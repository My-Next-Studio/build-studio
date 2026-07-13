---
title: "Svelte 5 hydration is async — use networkidle before Playwright interactions"
date: 2026-03-26
severity: high
tags: [svelte5, playwright, hydration, e2e, flaky, networkidle, waitForLoadState]
component: testing
---

`page.goto()` resolves at DOMContentLoaded/load, but Svelte 5 hydration completes asynchronously after that. If Playwright fills inputs or clicks buttons immediately after goto, reactive `$state` bindings are not yet live — filled values are discarded and clicks do not trigger reactive updates, producing intermittent 50% failure rates. Fix: add `await page.waitForLoadState('networkidle')` after every `page.goto()` in Svelte 5 E2E specs. `networkidle` fires after all pending fetch/XHR activity from hydration settles, which is a reliable proxy for hydration completion.
