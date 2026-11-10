'use strict';

/**
 * Is the stack decision still open?
 *
 * ADR-001 holds the tech stack. When a project's inputs make that choice wait
 * for an investigation or spike, the kickoff's Architect writes ADR-001 with
 * `Status: Pending` instead of selecting (lib/kickoff-prompts.js). Everything
 * that builds on the stack (the scaffold, provisioning) reads this, so the
 * check is plain code: no agent decides whether the decision was made.
 */

const fs = require('fs');
const path = require('path');

/**
 * A status line whose value starts with "Pending", in the common markdown
 * shapes: `Status: Pending`, `**Status:** Pending — …`, `- Status: pending`,
 * `| Status | Pending |`.
 */
const PENDING_STATUS = /^[\s>*_|-]*status[\s*_]*[:|][\s*_|]*pending\b/im;
const ANY_STATUS = /^[\s>*_|-]*status[\s*_]*[:|][\s*_|]*([^|\n]+)/im;

/** The first `ADR-001*.md` in docs/adrs/, or null. */
function findStackAdr(docsPath) {
  const dir = path.join(docsPath, 'adrs');
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return null; }
  // ADR-001-…, ADR-01-…, ADR-1-… — but not ADR-010 or ADR-011.
  const name = names.filter((n) => /^ADR-0*1\b.*\.md$/i.test(n)).sort()[0];
  return name ? path.join(dir, name) : null;
}

/**
 * @returns {{ exists: false } | { exists: true, file: string, pending: boolean, status: string|null }}
 *   `file` is relative to docsPath's parent (the project root), for messages.
 */
function stackDecision(docsPath) {
  const abs = findStackAdr(docsPath);
  if (!abs) return { exists: false };
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch (_) { /* unreadable: treat as no status */ }
  // The status belongs near the top; a "status: pending" deep in the body is
  // likely about something else (a table of open items).
  const head = text.split('\n').slice(0, 40).join('\n');
  const m = head.match(ANY_STATUS);
  return {
    exists: true,
    file: path.relative(path.dirname(docsPath), abs),
    pending: PENDING_STATUS.test(head),
    status: m ? m[1].replace(/[*_]/g, '').trim() : null,
  };
}

module.exports = { stackDecision, findStackAdr, PENDING_STATUS };
