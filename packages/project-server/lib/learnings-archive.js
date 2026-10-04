'use strict';

/**
 * Move a learning into `_archive/<domain>/` without breaking a single link.
 *
 * A plain rename broke links both ways. Inbound: other learnings and the
 * MEMORY.md index still pointed at the old path. Outbound: the moved file's own
 * relative links were now one directory too shallow. In a project whose
 * pre-commit hook link-checks docs/, the archive commit then failed and every
 * auto-commit after it was blocked until someone fixed the link by hand (seen
 * twice in one project).
 *
 * So the move rewrites:
 *   1. every relative markdown link under `scanRoot` that resolves to the old
 *      path, so it resolves to the new one. scanRoot is the project's docs/, not
 *      only docs/learnings/, because a link checker reads all of docs/;
 *   2. the moved file's own relative links, re-expressed from its new folder;
 * and then checks that it broke nothing. If the move would leave any link
 * missing that resolved before, everything is put back and the entry is not
 * archived.
 *
 * Links that are not relative file paths (http:, mailto:, #anchors, /absolute)
 * are left alone. Anchors and titles on a rewritten link are kept.
 */

const fs = require('fs');
const path = require('path');

// [text](target "title") and ![alt](target): group 2 is the target, optionally
// in <angle brackets>. Reference definitions: `[id]: target`.
const INLINE = /(\]\()(<[^>]*>|[^)\s]+)((?:\s+"[^"]*")?\))/g;
const REFDEF = /^(\s{0,3}\[[^\]]+\]:\s*)(<[^>]*>|\S+)/gm;

function isRelativeFileLink(target) {
  const t = target.replace(/^<|>$/g, '');
  if (!t || t.startsWith('#') || t.startsWith('/')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return false; // http:, mailto:, file:, …
  return true;
}

/** Split `path#anchor` / `path?q` into the file part and the rest. */
function splitTarget(target) {
  const angled = target.startsWith('<') && target.endsWith('>');
  const t = angled ? target.slice(1, -1) : target;
  const i = t.search(/[#?]/);
  return { file: i === -1 ? t : t.slice(0, i), rest: i === -1 ? '' : t.slice(i), angled };
}

function decode(p) {
  try { return decodeURIComponent(p); } catch (_) { return p; }
}

/** Absolute path a relative link in `fromFile` points at. */
function resolveLink(fromFile, filePart) {
  return path.resolve(path.dirname(fromFile), decode(filePart));
}

/** A relative link from `fromFile` to `toAbs`, POSIX-style, as markdown expects. */
function linkFrom(fromFile, toAbs, { encodeSpaces }) {
  let rel = path.relative(path.dirname(fromFile), toAbs).split(path.sep).join('/');
  if (encodeSpaces) rel = rel.replace(/ /g, '%20');
  return rel;
}

/**
 * Rewrite the relative links in `text` (a file at `fromFile`) with `map`:
 * given the absolute path a link resolves to, return the new absolute target,
 * or null to leave the link as it is.
 */
function rewriteLinks(text, fromFile, map) {
  const fix = (target) => {
    if (!isRelativeFileLink(target)) return target;
    const { file, rest, angled } = splitTarget(target);
    if (!file) return target;
    const next = map(resolveLink(fromFile, file));
    if (!next) return target;
    const rel = linkFrom(fromFile, next, { encodeSpaces: !angled && /%20/.test(file) });
    return angled ? `<${rel}${rest}>` : `${rel}${rest}`;
  };
  return text
    .replace(INLINE, (m, open, target, close) => open + fix(target) + close)
    .replace(REFDEF, (m, lead, target) => lead + fix(target));
}

/** Every relative file link in `text`, as the absolute path it resolves to. */
function linkTargets(text, fromFile) {
  const out = [];
  const take = (target) => {
    if (!isRelativeFileLink(target)) return;
    const { file } = splitTarget(target);
    if (file) out.push(resolveLink(fromFile, file));
  };
  for (const m of text.matchAll(INLINE)) take(m[2]);
  for (const m of text.matchAll(REFDEF)) take(m[2]);
  return out;
}

function markdownFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p); } else if (e.name.endsWith('.md')) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Links under scanRoot that point at a file that does not exist: Set of "from -> to". */
function brokenLinks(scanRoot) {
  const broken = new Set();
  for (const f of markdownFiles(scanRoot)) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    for (const to of linkTargets(text, f)) if (!fs.existsSync(to)) broken.add(`${f} -> ${to}`);
  }
  return broken;
}

/**
 * Move `file` (an absolute path to a learning) to `<baseDir>/_archive/<domain>/`.
 *
 * @param {object} p
 * @param {string} p.file      the learning to archive
 * @param {string} p.baseDir   the learnings root that holds `<domain>/` and `_archive/`
 * @param {string} p.domain
 * @param {string} p.scanRoot  where inbound links are looked for (the project's docs/)
 * @returns {{archived: boolean, to: string|null, rewritten: string[], reason?: string}}
 */
function archiveLearning({ file, baseDir, domain, scanRoot }) {
  const from = path.resolve(file);
  const to = path.join(baseDir, '_archive', domain, path.basename(file));
  const root = scanRoot || baseDir;
  if (fs.existsSync(to)) return { archived: false, to: null, rewritten: [], reason: `already in the archive: ${to}` };

  const before = brokenLinks(root);
  const originals = new Map(); // file → its text before this move, for undo
  const rewritten = [];

  // 1. Inbound: links elsewhere that resolve to the old path.
  for (const f of markdownFiles(root)) {
    if (path.resolve(f) === from) continue;
    const text = fs.readFileSync(f, 'utf8');
    const next = rewriteLinks(text, f, (abs) => (abs === from ? to : null));
    if (next !== text) { originals.set(f, text); fs.writeFileSync(f, next); rewritten.push(f); }
  }

  // 2. The moved file's own links, re-expressed from its new folder. A link to
  // itself follows it.
  const own = fs.readFileSync(from, 'utf8');
  const ownNext = rewriteMovedFile(own, from, to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  if (ownNext !== own) { fs.writeFileSync(to, ownNext); rewritten.push(to); }

  // 3. Prove it broke nothing: every link that resolved before still resolves.
  const after = brokenLinks(root);
  const introduced = [...after].filter((b) => !before.has(b));
  if (introduced.length) {
    fs.writeFileSync(to, own);
    fs.renameSync(to, from);
    for (const [f, text] of originals) fs.writeFileSync(f, text);
    return { archived: false, to: null, rewritten: [], reason: `would break ${introduced.length} link(s): ${introduced.slice(0, 3).join('; ')}` };
  }
  return { archived: true, to, rewritten };
}

/** Re-express each relative link of a file moving from `from` to `to`. */
function rewriteMovedFile(text, from, to) {
  const fix = (target) => {
    if (!isRelativeFileLink(target)) return target;
    const { file, rest, angled } = splitTarget(target);
    if (!file) return target;
    const abs = resolveLink(from, file);
    const dest = abs === path.resolve(from) ? to : abs;
    const rel = linkFrom(to, dest, { encodeSpaces: !angled && /%20/.test(file) });
    return angled ? `<${rel}${rest}>` : `${rel}${rest}`;
  };
  return text
    .replace(INLINE, (m, open, target, close) => open + fix(target) + close)
    .replace(REFDEF, (m, lead, target) => lead + fix(target));
}

module.exports = { archiveLearning, rewriteLinks, linkTargets, brokenLinks };
