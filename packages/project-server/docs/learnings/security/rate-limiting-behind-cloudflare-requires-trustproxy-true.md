---
title: "Rate limiting behind Cloudflare requires `trustProxy: true`"
date: 2026-03-22
severity: medium
tags: [cloudflare, fastify, proxy]
component: general
---

Without `trustProxy: true`, Fastify behind Cloudflare returns the Cloudflare egress IP from `request.ip`. All guests share the same apparent IP, so per-IP rate limits either lock out everyone or never trigger, and any IP-based audit/attribution records the same useless egress hash. Use `trustProxy: true` + read `cf-connecting-ip` header (Cloudflare sets this reliably; prefer it over `X-Forwarded-For` which can be client-spoofed). This applies to every feature that uses `request.ip`: rate limiters, audit logs, fraud detection, etc.
