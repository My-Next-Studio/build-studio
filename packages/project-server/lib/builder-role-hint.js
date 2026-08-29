'use strict';

/**
 * The implementation track a PRD names for itself.
 *
 * Part 1 gave the owner a picker; this is the half that stops the picker being
 * a thing you have to remember. The PM already knows which track a story is —
 * the PRD is where that belongs, and a run started from anywhere (the workflow
 * view, the backlog tab, a raw API call) can then reach it.
 *
 * FORMAT — a header line in the PRD's existing bolded key-value block:
 *
 *     # PRD-046 — Android foundation
 *
 *     **Backlog item:** `DR-104` — Android foundation
 *     **Status:** Draft
 *     **Owner:** PM
 *     **Role:** Android Dev
 *
 * `role:` rather than a separate `Track:` vocabulary, because backlog items
 * already carry `role:`, `resolveBuilderRole` already reads it, and `findRole`
 * already matches a role name OR its skill — so `Android Dev`, `android_dev`
 * and `/android_dev` all work with no mapping table to maintain per project.
 *
 * The value is NOT resolved here. This module answers "what does the document
 * say", and the caller decides whether that names a real execution role — the
 * two failure modes ("the PRD says nothing" and "the PRD names something that
 * does not exist") deserve different handling and must stay distinguishable.
 */

/** Header keys accepted, in the shapes PMs actually write. */
const KEY = String.raw`(?:builder\s+role|builder|role)`;

/**
 * Read the builder-role hint out of a PRD's header block.
 *
 * Scoped to the header deliberately: only lines before the first `##` section
 * are considered. A PRD body routinely contains prose like "the iOS Dev role
 * owns this", and matching that would let a sentence silently redirect a run.
 *
 * @param {string} text  the PRD's markdown
 * @returns {string|null} the value as written, or null when there is no hint
 */
function parseBuilderRoleHint(text) {
  const src = String(text || '');
  if (!src.trim()) return null;
  // Header block = everything before the first `##` heading.
  const bodyStart = src.search(/^##\s/m);
  const header = bodyStart === -1 ? src : src.slice(0, bodyStart);
  // `**Role:** X`, `**Builder role:** X`, or the same without bold. Anchored to
  // the line start so a mid-sentence "role:" cannot match.
  const re = new RegExp(String.raw`^\s*(?:\*\*)?${KEY}(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+)$`, 'im');
  const m = header.match(re);
  if (!m) return null;
  return cleanValue(m[1]);
}

/**
 * Strip the decoration a header value picks up and keep the role reference.
 *
 * PMs write `` `Android Dev` `` and `Android Dev — the Phase 1.5 track`; both
 * mean the same role, and neither resolves if handed over verbatim.
 */
function cleanValue(raw) {
  let v = String(raw || '').trim();
  v = v.replace(/^[`*_]+|[`*_]+$/g, '').trim();      // wrapping backticks / emphasis
  v = v.split(/\s+[—–-]{1,2}\s+/)[0].trim();          // trailing " — explanation"
  v = v.replace(/^[`*_]+|[`*_]+$/g, '').trim();      // emphasis inside the kept half
  v = v.replace(/[.,;]+$/, '').trim();                // trailing punctuation
  return v || null;
}

/**
 * Which role a run should build under, per the documents.
 *
 * Precedence: the PRD wins over the backlog item. The PRD is the thing being
 * executed and is revised through review; the item's `role:` predates it and
 * exists mainly for bugfix runs, which have no PRD at all.
 *
 * @param {object} p
 * @param {string} [p.prdText]  the PRD's markdown, when there is one
 * @param {object} [p.item]     the backlog item, when the run names one
 * @returns {{value: string, source: 'prd'|'item'}|null}
 */
function suggestBuilderRole({ prdText, item } = {}) {
  const fromPrd = parseBuilderRoleHint(prdText);
  if (fromPrd) return { value: fromPrd, source: 'prd' };
  const fromItem = item && item.role ? cleanValue(item.role) : null;
  if (fromItem) return { value: fromItem, source: 'item' };
  return null;
}

module.exports = { parseBuilderRoleHint, suggestBuilderRole, cleanValue };
