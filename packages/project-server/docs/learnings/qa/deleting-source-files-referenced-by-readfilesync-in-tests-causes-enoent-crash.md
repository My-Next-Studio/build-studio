---
title: "Deleting source files referenced by readFileSync in tests causes whole test file to crash"
date: 2026-03-26
severity: medium
tags: [testing, vitest, readfilesync, enoent, file-deletion, refactoring]
component: testing
---

When infrastructure files are deleted (e.g., `guest-form.js` removed as part of a cleanup PRD), any test that calls `readFileSync(path)` on those files will throw ENOENT at runtime — crashing the entire test file, not just the individual test. This breaks unrelated passing tests in the same file. Fix: when deleting files, grep all test suites for `readFileSync` references to the deleted paths, then delete or `.skip` those test blocks with a comment explaining they are superseded. Prefer deletion over `.skip` to avoid confusion.
