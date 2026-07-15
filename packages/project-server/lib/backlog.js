/**
 * Backlog storage layer (PRD-004).
 *
 * Per project:
 *   - One markdown file per item at `<docs>/backlog/<ID>.md` with YAML frontmatter
 *     (id, title, type, status, release, prd, depends_on, cost_actual_usd, created)
 *     and a free-form body (## Requirements, ## Acceptance criteria, ## Notes).
 *   - The canonical *order* lives between `<!-- BACKLOG-START -->` and
 *     `<!-- BACKLOG-END -->` in `<docs>/project-state.md`. Content outside the
 *     markers is preserved verbatim on every write.
 *
 * This module is pure I/O + parsing. No express, no workflow concerns.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const BACKLOG_START = '<!-- BACKLOG-START -->';
const BACKLOG_END = '<!-- BACKLOG-END -->';

const VALID_TYPES = ['Feature', 'Bug', 'Task'];
// New Feature lifecycle (PRD-004 follow-up): Backlog → Drafted → Reviewed →
// Implemented → Done, with Blocked reachable from any state. Legacy statuses
// (Ready, In Progress, In Review) are still accepted so pre-existing items
// don't fail validation. Bugs and Tasks still use whatever fits today;
// dedicated lifecycles for those come later.
const VALID_STATUSES = [
  'Backlog', 'Drafted', 'Reviewed', 'Implemented', 'Done', 'Blocked',
  // Bug lifecycle: a bugfix workflow flips Backlog → Fixing at start, then
  // Fixing → Done on merge (or back to Backlog on cancel). Bugs skip the
  // PRD-shaped Drafted/Reviewed states unless routed through a PRD.
  'Fixing',
  // Legacy — accepted on read/write so existing items aren't rejected:
  'Ready', 'In Progress', 'In Review',
];

// Feature lifecycle in order. The auto-transition logic only moves forward
// through this list; it never moves backward and never skips ahead.
const FEATURE_LIFECYCLE = ['Backlog', 'Drafted', 'Reviewed', 'Implemented', 'Done'];

// `^[A-Z]{2,5}-\d{1,5}$` — uppercase project prefix + numeric suffix. The
// filesystem mirror of this regex prevents path-traversal via crafted IDs.
const ID_RE = /^[A-Z]{2,5}-\d{1,5}$/;
function isValidId(id) { return typeof id === 'string' && ID_RE.test(id); }

function backlogDir(projectRoot, docsPath) {
  return path.join(projectRoot, docsPath || 'docs', 'backlog');
}
function projectStatePath(projectRoot, docsPath) {
  return path.join(projectRoot, docsPath || 'docs', 'project-state.md');
}
function itemFilePath(projectRoot, docsPath, id) {
  if (!isValidId(id)) throw new Error(`Invalid item id: ${id}`);
  return path.join(backlogDir(projectRoot, docsPath), `${id}.md`);
}

// ─── Item file parse / serialize ─────────────────────────────────────────────

function parseItemFile(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('Item file is missing YAML frontmatter');
  const fm = yaml.load(m[1]) || {};
  return { ...fm, body: m[2].replace(/^\n+/, '') };
}

function serializeItemFile(item) {
  if (!item || !item.id) throw new Error('serializeItemFile: id required');
  const { body, ...fm } = item;
  // Deterministic field order — keeps git diffs minimal across writes.
  const ordered = {};
  const keys = ['id', 'title', 'type', 'status', 'release', 'created', 'prd', 'depends_on', 'cost_actual_usd'];
  for (const k of keys) if (k in fm) ordered[k] = fm[k];
  for (const k of Object.keys(fm)) if (!(k in ordered)) ordered[k] = fm[k];
  const fmText = yaml.dump(ordered, { lineWidth: 100, noRefs: true });
  return `---\n${fmText}---\n\n${(body || '').replace(/^\n+/, '')}${body && !body.endsWith('\n') ? '\n' : ''}`;
}

function readItem(projectRoot, docsPath, id) {
  const file = itemFilePath(projectRoot, docsPath, id);
  if (!fs.existsSync(file)) return null;
  const item = parseItemFile(fs.readFileSync(file, 'utf8'));
  if (item.prd) item.prd = normalizePrdField(item.prd, projectRoot, docsPath, item.id || id);
  return item;
}

function writeItem(projectRoot, docsPath, item) {
  if (!isValidId(item.id)) throw new Error(`writeItem: invalid id ${item.id}`);
  if (item.type && !VALID_TYPES.includes(item.type)) throw new Error(`writeItem: invalid type ${item.type}`);
  if (item.status && !VALID_STATUSES.includes(item.status)) throw new Error(`writeItem: invalid status ${item.status}`);
  const file = itemFilePath(projectRoot, docsPath, item.id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serializeItemFile(item));
}

function listItems(projectRoot, docsPath) {
  const dir = backlogDir(projectRoot, docsPath);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.md')) continue;
    const id = f.replace(/\.md$/, '');
    if (!isValidId(id)) continue;
    try {
      const item = parseItemFile(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (item.prd) item.prd = normalizePrdField(item.prd, projectRoot, docsPath, item.id || id);
      out.push(item);
    } catch (e) { /* malformed — skip, lint surfaces it */ }
  }
  return out;
}

// ─── project-state.md backlog section parse / render ─────────────────────────

/**
 * Parse the backlog section into an ordered list of release groups.
 * Returns [{ release: 'Release 0.3 (current)', items: ['EX-042', 'EX-038'] }, ...].
 * Lines outside the markers are ignored. Lines inside that aren't a release
 * heading or an `- <ID> — ...` item are silently skipped.
 */
function parseBacklogSection(content) {
  const startIdx = content.indexOf(BACKLOG_START);
  const endIdx = content.indexOf(BACKLOG_END);
  if (startIdx < 0 || endIdx < 0 || endIdx < startIdx) return [];
  const block = content.slice(startIdx + BACKLOG_START.length, endIdx);
  const groups = [];
  let current = null;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.replace(/\s+$/, '');
    const releaseMatch = line.match(/^###\s+(.+?)$/);
    if (releaseMatch) {
      current = { release: releaseMatch[1].trim(), items: [] };
      groups.push(current);
      continue;
    }
    const itemMatch = line.match(/^-\s+([A-Z]{2,5}-\d{1,5})\b/);
    if (itemMatch && current) current.items.push(itemMatch[1]);
  }
  return groups;
}

/**
 * Render the backlog section content between (but excluding) the markers.
 * Item lines display "<ID> — <title>  [<type> · <status>]" pulled from each
 * item's frontmatter, so the section stays human-readable + machine-parseable.
 */
function renderBacklogSection(groups, itemsById) {
  const out = ['', ''];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    out.push(`### ${g.release}`);
    out.push('');
    for (const id of g.items) {
      const item = itemsById[id];
      if (!item) { out.push(`- ${id} — (missing item file)`); continue; }
      const title = (item.title || '').replace(/\s+/g, ' ').trim() || '(untitled)';
      out.push(`- ${id} — ${title}  [${item.type || '?'} · ${item.status || '?'}]`);
    }
    if (gi < groups.length - 1) out.push('');
  }
  out.push('', '');
  return out.join('\n');
}

/**
 * Splice the backlog section into project-state.md, preserving everything
 * outside the markers verbatim. Loads all items first so display lines use
 * current titles/types/statuses. Both items missing from project-state.md
 * (orphans) and IDs in project-state.md with no item file (dead refs) are
 * left for the lint command to surface — this function neither auto-adds nor
 * auto-removes orphans.
 */
function writeBacklogSection(projectRoot, docsPath, groups) {
  const file = projectStatePath(projectRoot, docsPath);
  if (!fs.existsSync(file)) throw new Error(`project-state.md not found at ${file}`);
  let content = fs.readFileSync(file, 'utf8');
  const startIdx = content.indexOf(BACKLOG_START);
  const endIdx = content.indexOf(BACKLOG_END);
  if (startIdx < 0 || endIdx < 0) {
    throw new Error(`project-state.md is missing BACKLOG-START/END markers — cannot splice.`);
  }
  const items = listItems(projectRoot, docsPath);
  const itemsById = Object.fromEntries(items.map(i => [i.id, i]));
  const newSection = renderBacklogSection(groups, itemsById);
  const before = content.slice(0, startIdx + BACKLOG_START.length);
  const after = content.slice(endIdx);
  fs.writeFileSync(file, before + newSection + after);
}

// ─── ID assignment ───────────────────────────────────────────────────────────

/**
 * Compute the next-available ID for `prefix`. Gaps are NEVER reused — we
 * always pick max(existing) + 1, so a deleted item's ID stays retired.
 * Looks at item filenames; doesn't load file contents.
 */
function nextItemId(projectRoot, docsPath, prefix) {
  if (!/^[A-Z]{2,5}$/.test(prefix)) throw new Error(`Invalid prefix: ${prefix}`);
  const dir = backlogDir(projectRoot, docsPath);
  let max = 0;
  if (fs.existsSync(dir)) {
    const re = new RegExp(`^${prefix}-(\\d{1,5})\\.md$`);
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(re);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

// ─── Companion-spec discovery (from the PRD's own table) ─────────────────────

/**
 * Parse the "Companion Specs" section of a PRD markdown file and extract the
 * spec file paths declared in its delivery table. PRDs in this codebase
 * follow a convention:
 *
 *   ## Companion Specs                 ← or "## 9. Companion specs / deliverables"
 *
 *   | Spec | … | Path | … |
 *   |---|---|---|---|
 *   | QA test plan | … | `docs/qa/QA-009-…md` | Not started |
 *   | Brand review | … | reviewer pass on the PR | … |
 *
 * Path cells use backtick-wrapped relative paths (sometimes wrapped in a
 * markdown link). Rows with no path — "reviewer pass on the PR", "inline in
 * PRD §Solution" — are skipped. Paths to files that don't yet exist on disk
 * are still returned (companion specs are normally drafted during the review
 * workflow, *after* the PRD itself).
 *
 * Returns: Array<{ path: string, exists: boolean }>
 *   Each entry's `path` is relative to projectRoot (e.g. `docs/qa/QA-009-…md`).
 */
function parseCompanionSpecsFromPRD(projectRoot, prdRelPath) {
  if (!prdRelPath || typeof prdRelPath !== 'string') return [];
  const fullPath = path.join(projectRoot, prdRelPath);
  if (!fs.existsSync(fullPath)) return [];
  let content;
  try { content = fs.readFileSync(fullPath, 'utf8'); }
  catch (_) { return []; }

  const lines = content.split('\n');
  let inSection = false;
  const seen = new Set();
  for (const line of lines) {
    const heading = line.match(/^(#+)\s+(.+?)\s*$/);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2];
      if (/\bcompanion\b/i.test(text) && /\b(specs?|deliverables?)\b/i.test(text)) {
        inSection = true;
        continue;
      }
      // Exit on the next sibling-or-higher heading (H1 or H2) — nested H3+ stays inside.
      if (inSection && level <= 2) inSection = false;
      continue;
    }
    if (!inSection) continue;

    // Only pull paths from actual table-data rows. Heuristic: the line must
    // start with `|` (allowing leading whitespace), contain at least two `|`
    // separators total, and must not be the header separator `|---|---|`.
    // This excludes prose mentions of paths inside the section (e.g. a sentence
    // referencing `project-state.md` as documentation) — those shouldn't be
    // treated as companion specs.
    if (!/^\s*\|/.test(line)) continue;
    if (/^\s*\|[\s|:\-]+\|?\s*$/.test(line)) continue;  // separator row

    // Extract paths ONLY from cells whose entire content IS the path — i.e. it
    // stands alone in a column (the "Path" cell, or a link-only "Status" cell) —
    // never from a path embedded in a prose description cell. Otherwise an
    // incidental backtick mention like "…light /brand pass against
    // `brand-guidelines.md` …" inside a row's description is mistaken for a
    // companion deliverable (example-app EX-032 via PRD-021, 2026-06-03).
    // Split on UNescaped pipes so an escaped `\|` inside a cell doesn't mis-split.
    const cells = line.split(/(?<!\\)\|/).map(c => c.trim().replace(/^\*+|\*+$/g, '').trim());
    for (const cell of cells) {
      let raw = null, m;
      if ((m = cell.match(/^`([^`\n]+\.md)`$/))) raw = m[1];                   // `path.md`
      else if ((m = cell.match(/^\[[^\]\n]*\]\(([^)\n]+\.md)\)$/))) raw = m[1]; // [label](path.md)
      else if ((m = cell.match(/^(\S+\.md)$/))) raw = m[1];                    // bare path.md
      if (!raw) continue;
      const p = normalizeSpecPath(raw, projectRoot, prdRelPath);
      if (p) seen.add(p);
    }
  }

  return [...seen].map(p => ({
    path: p,
    exists: fs.existsSync(path.join(projectRoot, p)),
  }));
}

/**
 * Normalise a path found in a PRD body to be relative to projectRoot. Inputs
 * may be repo-root-relative already (`docs/qa/QA-…md`) or relative to the
 * PRD's own directory (`../brand/PRD-…md` — common in markdown links).
 *
 * Returns null if the resolved path escapes projectRoot (defense against
 * crafted PRDs trying to read outside the project).
 */
function normalizeSpecPath(rawPath, projectRoot, prdRelPath) {
  if (!rawPath) return null;
  const trimmed = rawPath.trim();
  // Skip URLs (http/https), they're not file paths.
  if (/^[a-z]+:\/\//i.test(trimmed)) return null;
  // Resolve relative-style paths (`./…`, `../…`) against the PRD's own
  // directory — that's how markdown links between sibling docs files work.
  // Everything else (`docs/…`, `ios/…`, `src/…`) is treated as
  // repo-root-relative, which is the dominant convention in this codebase.
  const prdDir = path.dirname(prdRelPath);
  const candidate = path.isAbsolute(trimmed)
    ? trimmed
    : /^\.{1,2}\//.test(trimmed)
      ? path.normalize(path.join(prdDir, trimmed))
      : path.normalize(trimmed);
  // Reject anything that escapes the project root after resolution.
  const abs = path.resolve(projectRoot, candidate);
  const rel = path.relative(projectRoot, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel;
}

/**
 * Normalise an item's `prd:` frontmatter value to a repo-root-relative path,
 * tolerating the three ways PMs have written it (EX-034 + EX-026):
 *   - a bare ID             `PRD-028`                          → docs/prds/PRD-028-<slug>.md (found by ID prefix)
 *   - a markdown link       `[PRD-023](../prds/PRD-023-…md)`   → docs/prds/PRD-023-…md
 *   - a plain/relative path  `docs/prds/…md` / `../prds/…md`   → resolved to repo-root
 * The canonical form (`docs/prds/<file>.md`) passes through untouched. Returns the
 * ORIGINAL value if it can't be resolved, so a genuinely pending/typo'd reference is
 * preserved rather than silently dropped.
 */
function normalizePrdField(rawPrd, projectRoot, docsPath, id) {
  if (!rawPrd || typeof rawPrd !== 'string') return rawPrd;
  let s = rawPrd.trim();
  const link = s.match(/\[[^\]\n]*\]\(([^)\s]+)\)/); // markdown link → its target
  if (link) s = link[1];
  s = s.replace(/^`+|`+$/g, '').trim();              // strip code backticks
  if (!s) return rawPrd;
  // Bare ID (no slash, no extension) → resolve by globbing the prds dir.
  if (/^[A-Za-z]{2,6}-\d{1,5}$/.test(s)) {
    try {
      const prdsDir = path.join(projectRoot, docsPath, 'prds');
      const match = fs.readdirSync(prdsDir).find(f =>
        f.endsWith('.md') && (f === `${s}.md` || f.startsWith(`${s}-`)));
      if (match) return path.posix.join(docsPath, 'prds', match);
    } catch (_) { /* no prds dir / unreadable */ }
    return rawPrd;
  }
  // Otherwise it's a path (plain, relative, or extracted from a link). Resolve it
  // relative to the backlog dir (where the item lives) → repo-root, rejecting escapes.
  const itemRel = path.posix.join(docsPath, 'backlog', `${id || 'X'}.md`);
  return normalizeSpecPath(s, projectRoot, itemRel) || rawPrd;
}

/**
 * Public discovery — combines explicit override + PRD-table parsing.
 *
 *   1. If item.companion_specs is a frontmatter array of strings, treat each
 *      entry as a path. Honor it verbatim (including paths to files that
 *      don't exist yet).
 *   2. Otherwise, if the item has a `prd:` field, parse the referenced PRD's
 *      Companion Specs table and return those paths.
 *   3. Otherwise, return [].
 *
 * Returns: Array<{ path: string, exists: boolean }>
 */
function discoverCompanionSpecs(projectRoot, docsPath, item) {
  if (Array.isArray(item.companion_specs)) {
    return item.companion_specs.map(p => ({
      path: typeof p === 'string' ? p : (p && p.path) || '',
      exists: fs.existsSync(path.join(projectRoot, typeof p === 'string' ? p : (p && p.path) || '')),
    })).filter(s => s.path);
  }
  if (!item.prd || typeof item.prd !== 'string') return [];
  return parseCompanionSpecsFromPRD(projectRoot, item.prd);
}

// ─── Convenience: read the full backlog (order + items) in one call ──────────

/**
 * Returns { groups, items }. `groups` is the ordered release structure from
 * project-state.md (with just IDs). `items` is a map id → item object so the
 * caller can hydrate display lines. Items missing from project-state.md
 * appear in `items` but not in any group (orphans). IDs in groups without a
 * matching item appear in `groups` but not `items` (dead refs).
 */
function readBacklog(projectRoot, docsPath) {
  const stateFile = projectStatePath(projectRoot, docsPath);
  let groups = [];
  if (fs.existsSync(stateFile)) {
    groups = parseBacklogSection(fs.readFileSync(stateFile, 'utf8'));
  }
  const itemList = listItems(projectRoot, docsPath);
  const items = Object.fromEntries(itemList.map(i => [i.id, i]));
  return { groups, items };
}

// ─── Feature auto-transitions ────────────────────────────────────────────────

/**
 * Forward-only check: is `from` strictly before `to` in the Feature lifecycle?
 * Used by transition helpers to refuse moves that would walk backwards or
 * skip past the operator's current state.
 */
function lifecycleAdvancesPast(from, to) {
  const fi = FEATURE_LIFECYCLE.indexOf(from);
  const ti = FEATURE_LIFECYCLE.indexOf(to);
  // If `from` is off-lifecycle (legacy status or Blocked), don't auto-touch it.
  if (fi < 0 || ti < 0) return false;
  return ti > fi;
}

/**
 * Apply the file-presence auto-transition: any item (Feature, Bug, or Task)
 * with status=Backlog whose `prd:` field points to a file that exists on disk
 * advances to Drafted. Idempotent — running it twice in a row produces the
 * same result.
 *
 * All three types share the same lifecycle and run the same review/execution
 * workflows, so all three auto-advance. (Function name kept for import stability.)
 *
 * Returns { changed: boolean, transitioned: [{id, from, to}] }. When changed,
 * caller should re-render the BACKLOG section so display lines pick up the
 * new statuses.
 */
function applyAutoTransitionsForFeatures(projectRoot, docsPath) {
  const items = listItems(projectRoot, docsPath);
  const transitioned = [];
  for (const item of items) {
    if (item.status !== 'Backlog') continue;
    if (!item.prd || typeof item.prd !== 'string') continue;
    const prdFile = path.join(projectRoot, item.prd);
    if (!fs.existsSync(prdFile)) continue;
    // Move to Drafted.
    writeItem(projectRoot, docsPath, { ...item, status: 'Drafted' });
    transitioned.push({ id: item.id, from: 'Backlog', to: 'Drafted' });
  }
  return { changed: transitioned.length > 0, transitioned };
}

/**
 * Workflow-hook helper. Given a PRD path (relative to projectRoot, as stored
 * in wf.prdPath), find every item (Feature, Bug, or Task) whose `prd:` field
 * matches it and whose current status would *advance* by moving to
 * `targetStatus`. Items already at or past `targetStatus` are left untouched.
 * Returns { transitioned: […] }.
 *
 * All three types share one lifecycle and the same review/execution workflows,
 * so all three advance here — the start gate (workflow.js) already accepts any
 * type, so Feature-only advancement left Tasks/Bugs stranded at Drafted.
 * (Function name kept for import stability.)
 *
 * Used by:
 *   - review workflow → completed   : targetStatus = 'Reviewed'
 *   - execution merge_to_main       : targetStatus = 'Implemented'
 *
 * Done is the operator's manual gate — workflows never set it.
 */
function transitionFeaturesForPRD(projectRoot, docsPath, prdRelPath, targetStatus) {
  if (!prdRelPath) return { transitioned: [] };
  // Normalise so `prds/PRD-001.md` and `docs/prds/PRD-001.md` both match.
  const normalize = (p) => p.replace(/^\.?\/?/, '').replace(/^docs\//, '');
  const target = normalize(prdRelPath);
  const items = listItems(projectRoot, docsPath);
  const transitioned = [];
  for (const item of items) {
    if (!item.prd || typeof item.prd !== 'string') continue;
    if (normalize(item.prd) !== target) continue;
    if (!lifecycleAdvancesPast(item.status, targetStatus)) continue;
    writeItem(projectRoot, docsPath, { ...item, status: targetStatus });
    transitioned.push({ id: item.id, from: item.status, to: targetStatus });
  }
  return { transitioned };
}

module.exports = {
  BACKLOG_START,
  BACKLOG_END,
  VALID_TYPES,
  VALID_STATUSES,
  FEATURE_LIFECYCLE,
  isValidId,
  backlogDir,
  projectStatePath,
  itemFilePath,
  parseItemFile,
  serializeItemFile,
  readItem,
  writeItem,
  listItems,
  parseBacklogSection,
  renderBacklogSection,
  writeBacklogSection,
  nextItemId,
  readBacklog,
  discoverCompanionSpecs,
  parseCompanionSpecsFromPRD,
  normalizePrdField,
  lifecycleAdvancesPast,
  applyAutoTransitionsForFeatures,
  transitionFeaturesForPRD,
};
