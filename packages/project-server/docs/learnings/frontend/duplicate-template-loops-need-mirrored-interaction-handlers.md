---
title: "Duplicate template loops for the same entity must mirror all interaction handlers"
date: 2026-03-23
severity: medium
tags: [svelte, react, template, ui, confirmation, state, interactive, pattern]
component: frontend
---

When a page renders the same entity in multiple separate loops (e.g., events grouped by status: live / paused / unpublished), stateful interactions like inline confirmation dialogs must be explicitly duplicated in every loop block. A shared state variable (e.g., `confirmDeleteResponseId`) controls what is shown, but if the conditional branch that renders the dialog is missing from one loop, clicking the trigger silently sets state with no visible effect. Review every template section that shares entity-level state when adding interactive patterns.
