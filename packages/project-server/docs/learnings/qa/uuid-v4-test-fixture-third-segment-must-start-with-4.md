---
title: "UUID v4 test fixtures: third segment must start with '4'"
date: 2026-03-25
severity: low
tags: [uuid, fixture, test, validation, pattern]
component: testing
---

UUID v4 format requires the third hyphen-separated segment to begin with the digit '4' (encoding the version). A common copy-paste fixture like `123e4567-e89b-12d3-a456-426614174000` is invalid (third segment `12d3`) and will fail `toMatch(UUID_PATTERN)` assertions when the code returns or validates the value. Fix: use `42d3` or any `4xxx` form in the third segment. Caught in PRD-016 generation-cache tests.
