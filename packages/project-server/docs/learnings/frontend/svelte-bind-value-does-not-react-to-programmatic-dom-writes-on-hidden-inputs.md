---
title: "Svelte bind:value does not react to programmatic DOM writes on hidden inputs"
date: 2026-03-26
severity: medium
tags: [svelte, svelte5, bind, reactive, hidden-input, input-event, testing]
component: testing
---

Svelte's `bind:value` only updates component state when an `input` DOM event fires. `type="hidden"` inputs never fire `input` events, and programmatic writes via `element.value = ...` (e.g., in Playwright `page.evaluate`) also do not fire the event. As a result, any guard logic that reads bound state (e.g., a honeypot check `if (honeypot)`) will never trigger when the value is set programmatically. Fix: when writing to a hidden/bound input in tests, also dispatch a synthetic `input` event; in production, prefer `type="hidden"` over binding to purely server-sent values so state is read from the DOM at submit time.
