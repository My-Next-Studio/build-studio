---
title: "Test .skip must follow code removal, not precede it"
date: 2026-03-25
severity: medium
tags: [test, skip, coverage, regression, fastify, routes]
component: testing
---

Adding `describe.skip` or `test.skip` before the corresponding code is actually removed creates a window where live routes have no behavioral test coverage. This is a silent regression: the routes remain fully functional but their tests are suppressed. Only skip tests after the code under test has been deleted or disabled. Discovered in PRD-016 when rsvp.test.ts token-route suites were skipped before the GET/PUT routes were removed from rsvp.ts.
