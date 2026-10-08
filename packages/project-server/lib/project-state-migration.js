'use strict';

// Moves the two ever-growing sections out of project-state.md into files of
// their own:
//
//   ## Key Decisions Log  →  docs/decisions.md
//   ## Backlog            →  docs/backlog-index.md   (the BACKLOG markers)
//
// project-state.md is the file every agent reads first, and both sections only
// grow: a row per owner decision, a line per backlog item. In one project they
// were 191 KB and 75 KB of a 470 KB file. Their readers are few and known: the
// drafting and interview skills open the decisions log, and Build Studio reads
// the index through backlog.backlogIndexPath(). Each heading stays in
// project-state.md with a one-line pointer, so an older skill copy that still
// looks there is sent to the right place.
//
// `build-studio migrate-project-state` runs this for an existing project. New
// projects get both files from the template.

const fs = require('fs');
const path = require('path');

const { BACKLOG_INDEX_FILE } = require('./backlog');

const DECISIONS_FILE = 'decisions.md';

const MOVES = [
  {
    key: 'decisions',
    label: 'Key Decisions Log',
    file: DECISIONS_FILE,
    heading: /^##[ \t]+Key Decisions Log[ \t]*$/m,
    // A dated table row: the section has real content.
    hasContent: (body) => /^\|\s*\d{4}-\d{2}-\d{2}/m.test(body),
    pointer: 'Moved to [`docs/decisions.md`](decisions.md). It is not required reading:\n' +
      'open it when drafting, or when a PRD, ADR or item cites a decision.\n',
    header: '# Key Decisions Log\n\n' +
      'One row per owner or role decision, newest first. Not required reading for\n' +
      'every agent: the drafting and interview skills check it so a settled question\n' +
      'is not asked again, and anyone else opens it when a document cites a decision.\n' +
      'Put each decision in the PRD or ADR it governs as well; this is the index.\n\n',
    // The log's rows move under the file's own heading.
    keepHeading: false,
  },
  {
    key: 'backlog',
    label: 'Backlog',
    file: BACKLOG_INDEX_FILE,
    // `## Backlog`, `## Backlog (PRD-004 — new format)`, …
    heading: /^##[ \t]+Backlog\b[^\n]*$/m,
    hasContent: (body) => body.includes('<!-- BACKLOG-START -->'),
    pointer: 'Moved to [`docs/backlog-index.md`](backlog-index.md): the order of the backlog,\n' +
      'one line per item in `docs/backlog/`. Item status lives in the item files.\n',
    header: '# Backlog index\n\n' +
      'The order of the backlog: one line per item file in `docs/backlog/`, grouped\n' +
      'by release. Build Studio renders each line\'s `[Type · Status]` from the item\n' +
      'file and reorders lines when you drag them in the Backlog tab. Add a line\n' +
      'when you create an item, remove it when you delete one; never edit a\n' +
      'status here.\n\n',
    keepHeading: true,
  },
];

/**
 * Split `content` around the section whose heading matches `re`. When more
 * than one heading matches, the first whose body passes `pick` wins (one
 * project kept an old `## Backlog` table above the marker section).
 * Returns { before, heading, body, after } — `before` ends just before the
 * heading line — or null when there is no such section.
 */
function splitSection(content, re, pick = () => true) {
  const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
  let first = null;
  for (const m of (content || '').matchAll(all)) {
    const headEnd = m.index + m[0].length;
    const next = content.slice(headEnd).search(/^##\s/m);
    const end = next < 0 ? content.length : headEnd + next;
    const split = { before: content.slice(0, m.index), heading: m[0], body: content.slice(headEnd, end), after: content.slice(end) };
    if (pick(split.body)) return split;
    if (!first) first = split;
  }
  return first;
}

function isPointer(move, body) {
  return body.includes(`docs/${move.file}`) && !move.hasContent(body);
}

/**
 * What migrating `projectRoot` would do, per section:
 *   'none'     — no section, already a pointer, or nothing in it to move
 *   'move'     — write the file and leave the pointer
 *   'conflict' — the file exists AND the section still has content; left
 *                for the owner to reconcile by hand
 */
function planProjectStateMigration(projectRoot, docsRel = 'docs') {
  const statePath = path.join(projectRoot, docsRel, 'project-state.md');
  if (!fs.existsSync(statePath)) return MOVES.map((m) => ({ key: m.key, action: 'none', summary: 'No project-state.md.' }));
  const content = fs.readFileSync(statePath, 'utf8');
  return MOVES.map((m) => {
    const split = splitSection(content, m.heading, m.hasContent);
    const target = `${docsRel}/${m.file}`;
    if (!split) return { key: m.key, action: 'none', summary: `No ${m.label} section.` };
    if (isPointer(m, split.body)) return { key: m.key, action: 'none', summary: `Already moved to ${target}.` };
    if (!m.hasContent(split.body)) return { key: m.key, action: 'none', summary: `Nothing to move to ${target}.` };
    if (fs.existsSync(path.join(projectRoot, docsRel, m.file))) {
      return { key: m.key, action: 'conflict', summary: `${target} exists and project-state.md still has the section; reconcile by hand.` };
    }
    const kb = Math.round(Buffer.byteLength(split.body, 'utf8') / 1024);
    return { key: m.key, action: 'move', summary: `Move ${kb} KB to ${target}.` };
  });
}

/** Apply every 'move' in the plan. Returns the repo-relative paths written. */
function applyProjectStateMigration(projectRoot, docsRel = 'docs') {
  const plan = planProjectStateMigration(projectRoot, docsRel);
  const statePath = path.join(projectRoot, docsRel, 'project-state.md');
  const written = [];
  let content = null;
  for (const m of MOVES) {
    if ((plan.find((p) => p.key === m.key) || {}).action !== 'move') continue;
    content = content == null ? fs.readFileSync(statePath, 'utf8') : content;
    const split = splitSection(content, m.heading, m.hasContent);
    const body = split.body.replace(/^\n+/, '').replace(/\s+$/, '');
    const moved = m.keepHeading ? `## Backlog\n\n${body}\n` : `${body}\n`;
    fs.writeFileSync(path.join(projectRoot, docsRel, m.file), m.header + moved);
    written.push(path.join(docsRel, m.file));
    // A blank line before the next heading; none when the section was last.
    content = `${split.before}${split.heading}\n\n${m.pointer}${split.after ? `\n${split.after}` : ''}`;
  }
  if (content != null) {
    fs.writeFileSync(statePath, content);
    written.push(path.join(docsRel, 'project-state.md'));
  }
  return written;
}

module.exports = {
  DECISIONS_FILE,
  BACKLOG_INDEX_FILE,
  splitSection,
  planProjectStateMigration,
  applyProjectStateMigration,
};
