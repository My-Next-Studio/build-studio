---
title: "Sanitize HTML (or any content) at write time, not read time"
date: 2026-03-27
severity: medium
tags: [sanitization, xss, html, lifecycle, single-pass, storage, content]
component: api
---

Sanitizing content at read time causes two problems: different consumers may apply sanitization inconsistently (or redundantly), and stored data is the unsanitized form — making it harder to reason about what is actually in the DB or object store. The correct pattern is single-pass: sanitize once at generation/write time before storage, then all downstream consumers (HTTP handlers, SSE events, S3 sync, publish) receive the already-sanitized form and pass it through unchanged. This is especially important for HTML/AI-generated content where double-sanitization may corrupt valid markup.
