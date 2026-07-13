---
title: "Batch scripts must wrap each row's external write in try/catch with separate counters"
date: 2026-03-27
severity: medium
tags: [batch, s3, error-handling, try-catch, counters, partial-failure, script]
component: api
---

When a script loops over DB rows to push each to an external service (S3, email, HTTP API), wrapping the entire loop in a single try/catch aborts the whole run on the first failure. Instead, wrap each iteration individually so one bad row does not prevent the remaining rows from being processed. Track `successCount` and `failureCount` separately and exit with a non-zero code if any failures occurred, so CI/CD or operators can detect partial runs. This pattern applies to any batch migration or sync script.
