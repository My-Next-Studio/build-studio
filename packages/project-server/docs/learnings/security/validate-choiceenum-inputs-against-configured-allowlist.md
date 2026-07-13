---
title: "Validate choice/enum inputs against configured allowlist"
date: 2026-03-22
severity: medium
tags: [validation, choice, allowlist, input-validation, security, api, form]
component: api
---

Checking only that a choice-type answer is a string (not empty) without verifying it is one of the configured options allows guests to inject arbitrary strings into DB and CSV exports. When `q.options` is non-empty, reject values not in the list. No HTML injection risk, but prevents data pollution and caterer-export corruption. This issue recurred across multiple PRDs — any shared `validateResponses()` helper that handles a `choice` case must include the allowlist check. Discovered during security audit of PRD-013; recurred in PRD-015 when new endpoints reused the same helper.
