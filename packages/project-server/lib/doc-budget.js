'use strict';

// Size limits for the two documents every agent is told to read first.
//
// Both grew without bound: agents appended a paragraph per PRD to
// project-state.md and to ARCHITECTURE.md, and nothing ever trimmed them. By
// the time anyone looked, one project-state.md was 470 KB and one
// ARCHITECTURE.md 280 KB, paid for by every agent in every run. The limits
// warn, they do not block (owner decision 2026-10-08): a run logs it and the
// hub shows a notice, so the trim is a choice made in time rather than a
// review finding months later.

const fs = require('fs');
const path = require('path');

const KB = 1024;

// `inDocs`: the path is under the docs dir (true) or the repo root (false).
const DOC_BUDGETS = [
  {
    key: 'project_state',
    rel: 'project-state.md',
    inDocs: true,
    limitBytes: 40 * KB,
    holds: 'current state, roles, conventions and the backlog index',
  },
  {
    key: 'architecture',
    rel: 'ARCHITECTURE.md',
    inDocs: false,
    limitBytes: 20 * KB,
    holds: 'the component map, test seams and guardrails (about two pages)',
  },
];

/**
 * The budgeted documents that are over their limit.
 * @returns {{key, file, bytes, limitBytes, holds}[]} `file` repo-relative
 */
function docBudgetWarnings(projectRoot, docsRel = 'docs') {
  const out = [];
  for (const b of DOC_BUDGETS) {
    const file = b.inDocs ? path.join(docsRel, b.rel) : b.rel;
    let bytes;
    try { bytes = fs.statSync(path.join(projectRoot, file)).size; } catch (_) { continue; }
    if (bytes > b.limitBytes) out.push({ key: b.key, file, bytes, limitBytes: b.limitBytes, holds: b.holds });
  }
  return out;
}

/** One line per warning, for the run log. */
function formatDocBudgetWarning(w) {
  return `${w.file} is ${Math.round(w.bytes / KB)} KB, over its ${Math.round(w.limitBytes / KB)} KB limit. ` +
    `Every agent reads it first. It should hold only ${w.holds}; move history to docs/history/ or the PRDs.`;
}

/**
 * One sentence for an agent about to edit ARCHITECTURE.md: its size against
 * the limit, and what to do when an edit would cross it.
 */
function architectureBudgetLine(projectRoot) {
  const b = DOC_BUDGETS.find((x) => x.key === 'architecture');
  let bytes = null;
  try { bytes = fs.statSync(path.join(projectRoot, b.rel)).size; } catch (_) { /* no file */ }
  const limit = Math.round(b.limitBytes / KB);
  if (bytes == null) return `Keep it under ${limit} KB.`;
  const kb = Math.round(bytes / KB);
  return bytes > b.limitBytes
    ? `It is ${kb} KB, already over its ${limit} KB limit: do not make it longer — if you add a line, condense or remove a stale one in the same edit.`
    : `It is ${kb} KB of a ${limit} KB limit: if your edit would cross it, condense or remove something stale in the same edit.`;
}

module.exports = { DOC_BUDGETS, docBudgetWarnings, formatDocBudgetWarning, architectureBudgetLine };
