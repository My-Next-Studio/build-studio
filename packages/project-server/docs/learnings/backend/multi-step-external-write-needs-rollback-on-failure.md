---
title: "Multi-step external writes (S3, DB) need compensating rollback in the catch block"
date: 2026-03-22
severity: high
tags: [s3, database, transaction, rollback, atomicity, error-handling]
component: api
---

When multiple external writes happen sequentially (e.g., two S3 uploads, or a DB update followed by an S3 write), a failure partway through leaves earlier writes in an inconsistent state. The catch block must compensate: delete already-written S3 objects, or roll back DB mutations. Use `Promise.allSettled` (not `Promise.all`) for cleanup so that a cleanup failure does not suppress the original error. The same class of bug can appear independently on each code path — fix it everywhere, not just the one caught in review.
