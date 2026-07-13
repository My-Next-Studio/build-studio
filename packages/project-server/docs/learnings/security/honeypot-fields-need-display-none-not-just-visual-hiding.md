---
title: "Honeypot fields need display:none or type=hidden, not just visual hiding"
date: 2026-03-26
severity: high
tags: [honeypot, spam, autofill, css, security, forms, browser]
component: auth
---

Hiding a honeypot input with `position:absolute; left:-9999px; opacity:0` does not prevent browser autofill — the element is still in the layout tree and autofill engines consider it a valid candidate. When the browser autofills the honeypot, every legitimate form submission appears to be a bot. Fix: use `display:none` on the wrapper (removes from layout entirely) plus `type="hidden"` on the input (browsers never autofill hidden inputs). Both defenses together prevent false positives without breaking the honeypot's ability to catch bots that explicitly POST the field.
