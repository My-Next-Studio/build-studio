'use strict';

// Blank-line hygiene for markdown an agent produced and Build Studio writes.
//
// Support triage returns a backlog item's body as JSON; the server writes the
// file and auto-commits it. Agents routinely put a list straight under a bold
// lead-in ("**Observed:**\n- …"), which markdownlint's MD032 rejects — and a
// managed project that lints docs in pre-commit then refused the auto-commit,
// leaving the filed item uncommitted until the owner's next commit tripped
// over it (fazon FAZ-382, 2026-09-30). This applies the three spacing rules
// agents get wrong, without touching anything else:
//   - a blank line before a list that follows a non-list line (MD032),
//   - blank lines around headings (MD022),
//   - blank lines around fenced code blocks (MD031),
// and collapses runs of blank lines (MD012). Text inside fences is left as is.
// A line after a list with no blank line is a lazy continuation of the last
// item, not an error, so no blank is forced there.

const LIST = /^\s{0,3}([-*+]|\d{1,9}[.)])\s+\S/;
const HEADING = /^\s{0,3}#{1,6}(\s|$)/;
const FENCE = /^\s{0,3}(```|~~~)/;

function tidyMarkdown(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let inFence = null;
  const prev = () => (out.length ? out[out.length - 1] : '');
  const blankBefore = () => { if (out.length && prev().trim() !== '') out.push(''); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = FENCE.exec(line);
    if (inFence) {
      out.push(line);
      if (f && line.trim().startsWith(inFence)) {
        inFence = null;
        if (i + 1 < lines.length && lines[i + 1].trim() !== '') out.push('');
      }
      continue;
    }
    if (f) { blankBefore(); out.push(line); inFence = f[1]; continue; }
    if (HEADING.test(line)) {
      blankBefore(); out.push(line);
      if (i + 1 < lines.length && lines[i + 1].trim() !== '') out.push('');
      continue;
    }
    if (LIST.test(line) && prev().trim() !== '' && !LIST.test(prev()) && !/^\s+\S/.test(prev())) {
      out.push('');
    }
    out.push(line);
  }
  // Collapse runs of blank lines outside fences (MD012).
  const collapsed = [];
  let fence = null;
  for (const l of out) {
    const f = FENCE.exec(l);
    if (fence) { collapsed.push(l); if (f && l.trim().startsWith(fence)) fence = null; continue; }
    if (f) fence = f[1];
    if (l.trim() === '' && collapsed.length && collapsed[collapsed.length - 1].trim() === '') continue;
    collapsed.push(l);
  }
  return collapsed.join('\n');
}

module.exports = { tidyMarkdown };
