---
title: "PostgreSQL COPY FROM does INSERT not UPSERT — use UPDATE for rollback when rows still exist"
date: 2026-03-27
severity: medium
tags: [postgresql, migration, rollback, copy-from, insert, upsert, sql]
component: database
---

When a SQL migration uses UPDATE to modify existing rows, rolling back with `\COPY FROM` a CSV backup will fail with duplicate key violations because the rows were never deleted — they were updated in place. The correct rollback approach is either (A) restore from a platform-level DB snapshot, or (B) issue `UPDATE ... FROM` using a temp table loaded from the export CSV. Only use `COPY FROM` as a restore strategy when the migration deleted rows (DELETE + INSERT pattern) rather than updated them.
