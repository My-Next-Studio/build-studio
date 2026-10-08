'use strict';

// What changed in a project since its drafting session last drafted.
//
// A drafting session lives for weeks: the owner clears it by hand, not per item.
// Everything it read about the project is a snapshot from when it read it. An
// ADR superseded since then, a decision logged, a PRD that finished review — the
// session knows none of it, and drafts confidently against what it remembers.
// Continuity plus a delta beats either alone: the session keeps what it
// learned, and is told exactly which parts of that are now stale.
//
// Deliberately a list, not a briefing. It names what changed and where, so the
// agent can re-read what matters to the item at hand; summarising the changes
// here would put a second, lossy copy of each decision into the conversation.
//
// Sources are the committed record only (git log over the docs tree, and the
// decisions log: docs/decisions.md, or the section of project-state.md in a
// project not yet migrated). Uncommitted edits are the owner's work in
// progress, not a change the project has made.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DECISIONS_FILE } = require('./project-state-migration');

const MAX_PER_SECTION = 8;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

function titleOf(src) {
  const m = /^#\s+(.+)$/m.exec(src || '');
  return m ? m[1].trim() : null;
}

/** `**Status:** X` or `- **Status:** X`, as ADRs and PRDs write it. */
function statusLine(src) {
  const m = /^[ \t]*(?:-\s*)?\*\*Status:\*\*\s*(.+)$/m.exec(src || '');
  return m ? m[1].trim() : null;
}

function frontmatter(src) {
  const m = /^---\n([\s\S]*?)\n---/.exec(src || '');
  if (!m) return {};
  const out = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      out[key] = kv[2].replace(/^['"]|['"]$/g, '').replace(/^>-?\s*$/, '');
    } else if (key && /^\s+\S/.test(line) && out[key] === '') {
      out[key] = line.trim(); // first line of a folded scalar (title: >-)
    } else if (key && /^\s+\S/.test(line)) {
      out[key] += ` ${line.trim()}`;
    }
  }
  return out;
}

function clip(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : t;
}

/**
 * Rows of the "Key Decisions Log" table dated on or after `sinceDate`
 * (YYYY-MM-DD). The log is dated by day, so a decision made earlier on the same
 * day as the last draft is included: repeating one is cheaper than missing one.
 */
function decisionsSince(projectState, sinceDate) {
  if (!projectState) return [];
  // `#` in docs/decisions.md, `##` as a section of project-state.md.
  const start = projectState.search(/^#{1,2}\s+Key Decisions Log\s*$/m);
  if (start < 0) return [];
  const rest = projectState.slice(start).split('\n').slice(1);
  const out = [];
  for (const line of rest) {
    if (/^##\s/.test(line)) break;
    const cells = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*(.+?)\s*\|/.exec(line);
    if (!cells || cells[1] < sinceDate) continue;
    const bold = /\*\*(.+?)\*\*/.exec(cells[2]);
    out.push({ date: cells[1], text: clip(bold ? bold[1] : cells[2], 160) });
  }
  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); // newest first, log order within a day
}

/**
 * A document is reported when it is NEW since the last draft, or its status
 * changed (an ADR superseded or amended, a PRD reviewed, an item done). A body
 * edit that leaves the status alone is counted, not listed: one sweeping commit
 * that touches thirty PRDs' cross-links would otherwise bury the one ADR that
 * was superseded, which is the thing this exists to surface.
 *
 * "Before" is the tree at the last commit older than `since`.
 *
 * @param {object} p
 * @param {string} p.projectRoot
 * @param {string} p.docsPath   absolute docs directory
 * @param {string} p.since      ISO timestamp of the session's previous draft
 * @param {string[]} [p.own]  backlog ids this session drafted. Still listed —
 *   a review round that revised one of them is news to the session — but tagged,
 *   so its own fresh PRD does not read as someone else's work.
 */
function computeDraftDelta({ projectRoot, docsPath, since, own = [] }) {
  const empty = { decisions: [], decisionsSource: null, adrs: [], prds: [], items: [], otherEdits: 0 };
  if (!since || !projectRoot || !docsPath) return empty;
  const rel = path.relative(projectRoot, docsPath) || '.';
  let changed = [];
  let base = null;
  try {
    changed = git(projectRoot, ['log', `--since=${since}`, '--name-only', '--format=',
      '--', `${rel}/adrs`, `${rel}/prds`, `${rel}/backlog`]).split('\n').filter(Boolean);
    base = git(projectRoot, ['rev-list', '-1', `--before=${since}`, 'HEAD']) || null;
  } catch (_) { /* not a repo, or no history: nothing to report */ }
  const files = [...new Set(changed)].filter((f) => f.endsWith('.md') && fs.existsSync(path.join(projectRoot, f)));
  const before = (f) => {
    if (!base) return null;
    try { return git(projectRoot, ['show', `${base}:${f}`]); } catch (_) { return null; }
  };

  const ownIds = new Set(own.filter(Boolean));
  const ownPrds = new Set();
  const adrs = [];
  const prds = [];
  const items = [];
  let otherEdits = 0;

  for (const f of files.filter((x) => x.startsWith(`${rel}/backlog/`))) {
    const fm = frontmatter(read(path.join(projectRoot, f)));
    const id = fm.id || path.basename(f, '.md');
    const mine = ownIds.has(id);
    if (mine && fm.prd && fm.prd !== 'null') ownPrds.add(path.basename(fm.prd, '.md'));
    const old = before(f);
    const was = old === null ? null : (frontmatter(old).status || null);
    if (old !== null && was === (fm.status || null)) { otherEdits++; continue; }
    items.push({ id, title: clip(fm.title, 110), status: fm.status || null, was, isNew: old === null, mine });
  }
  const docs = (dir, out, statusLen) => {
    for (const f of files.filter((x) => x.startsWith(`${rel}/${dir}/`))) {
      const b = path.basename(f, '.md');
      const mine = dir === 'prds' && [...ownPrds].some((p) => b === p || b.startsWith(`${p}-`) || p.startsWith(b));
      const src = read(path.join(projectRoot, f));
      const old = before(f);
      const status = clip(statusLine(src), statusLen) || null;
      const was = old === null ? null : (clip(statusLine(old), statusLen) || null);
      if (old !== null && was === status) { otherEdits++; continue; }
      out.push({ file: path.basename(f), title: clip(titleOf(src) || b, 110), status, was, isNew: old === null, mine });
    }
  };
  docs('adrs', adrs, 90);
  docs('prds', prds, 60);

  const sinceDate = String(since).slice(0, 10);
  const ownFile = read(path.join(docsPath, DECISIONS_FILE));
  const decisions = decisionsSince(ownFile || read(path.join(docsPath, 'project-state.md')), sinceDate);
  const decisionsSource = ownFile ? `docs/${DECISIONS_FILE}` : 'docs/project-state.md → Key Decisions Log';
  return { decisions, decisionsSource, adrs, prds, items, otherEdits };
}

/** The delta as a prompt section, or '' when nothing changed. */
function formatDraftDelta(delta, since) {
  const sections = [];
  const list = (heading, rows, fmt) => {
    if (!rows.length) return;
    const shown = rows.slice(0, MAX_PER_SECTION).map((r) => `- ${fmt(r)}`);
    if (rows.length > MAX_PER_SECTION) shown.push(`- …and ${rows.length - MAX_PER_SECTION} more`);
    sections.push(`${heading}\n${shown.join('\n')}`);
  };
  list(`Decisions logged (${delta.decisionsSource || 'docs/project-state.md → Key Decisions Log'}):`, delta.decisions, (d) => `${d.date} — ${d.text}`);
  const change = (r) => `${r.isNew ? 'new' : `was: ${r.was || 'no status'}`}${r.mine ? ', drafted in this session' : ''}`;
  list('ADRs — new, or status changed:', delta.adrs, (a) => `${a.title} — Status: ${a.status || 'none'} (${change(a)}; ${a.file})`);
  list('PRDs — new, or status changed:', delta.prds, (p) => `${p.title} — ${p.status || 'no status'} (${change(p)}; ${p.file})`);
  list('Backlog items — new, or status changed:', delta.items, (i) => `${i.id} — ${i.title} [${i.status || '?'}${i.isNew ? ', new' : `, was ${i.was || '?'}`}${i.mine ? ', drafted in this session' : ''}]`);
  if (delta.otherEdits) sections.push(`(${delta.otherEdits} other ADR/PRD/backlog file${delta.otherEdits === 1 ? ' was' : 's were'} edited without a status change — check git log on docs/ if the item touches them.)`);
  if (!sections.length || sections.every((x) => x.startsWith('('))) return '';
  return `\n\n## What changed in the project since your last draft (${String(since).slice(0, 10)})\n\n`
    + 'What you read earlier in this session may be stale where it overlaps these. Before relying on it for this item, '
    + 're-read whichever of them touch the item — a superseded ADR or a newer decision wins over your memory of the old one.\n\n'
    + sections.join('\n\n');
}

module.exports = { computeDraftDelta, formatDraftDelta, decisionsSince, MAX_PER_SECTION };
