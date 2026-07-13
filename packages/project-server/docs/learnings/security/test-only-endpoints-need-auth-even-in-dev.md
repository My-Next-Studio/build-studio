---
title: "Test-only endpoints gated by NODE_ENV need authentication — staging environments may be public"
date: 2026-03-22
severity: medium
tags: [security, test-helpers, staging, authentication, pii, node-env]
component: api
---

Endpoints registered only when `NODE_ENV !== 'production'` are still reachable by unauthenticated attackers if the staging or preview environment is publicly accessible. Endpoints that return PII (actor emails, IP hashes) or can mint auth tokens are especially risky. Add a shared-secret header check (`X-Internal-Secret` matching an env var) to all test-helper endpoints, and pass it from E2E test fixtures. Alternatively, document that test deployments must not have public-facing URLs and enforce this in CI.
