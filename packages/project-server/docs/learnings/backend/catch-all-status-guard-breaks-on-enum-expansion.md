---
title: "Catch-all status guard (status !== 'live') silently breaks new enum values"
date: 2026-03-22
severity: high
tags: [typescript, enum, status, migration, regression, guard]
component: api
---

When migrating from a boolean (`live: true/false`) to a multi-value status enum, a naive guard like `if (status !== 'live')` collapses all non-live statuses into the same branch — including new values like `pending_verification` that have distinct intended behavior. Always enumerate statuses explicitly: `if (status === 'unpublished')` rather than a negation. Add a test for every status value on every guarded path at migration time to catch regressions immediately.
