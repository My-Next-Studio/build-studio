'use strict';

/**
 * Can a patched version actually be installed, or must upstream move first?
 *
 * This exists because "a patch is published but Dependabot opened no PR" turned
 * out to describe two situations that need opposite responses, and the Monitor
 * tab was labelling both of them *"pinned — decide"*:
 *
 *  1. Every package that depends on the vulnerable one already permits the
 *     patched version. Nothing is blocked; the lockfile simply has not been
 *     regenerated. One command fixes it. Not a decision at all.
 *  2. Some parent's range excludes the patched version (`vite` wanting
 *     `^0.27.0` when the fix is `0.28.1`). Nothing you run locally will resolve
 *     it — the parent has to widen its range first.
 *
 * Measured on this installation, two of three "decisions" were case 1: a direct
 * `cryptography>=42.0` whose lockfile pinned an older build, and a transitive
 * `@babel/core` whose parents allowed `^7.24.4` against a `7.29.6` fix. Telling
 * someone to make a judgement call when the answer is one command is the kind of
 * label that teaches people to stop reading the list.
 *
 * ── Fail closed ──────────────────────────────────────────────────────────────
 *
 * Every function here returns null the moment it meets something it does not
 * confidently understand, and the caller keeps the older, vaguer label. That is
 * deliberate and it is why this file does not depend on a semver library: the
 * cost of a wrong "refresh your lockfile" is a command that does nothing and a
 * user who trusts the badge less, and the cost of a wrong "wait for upstream" is
 * a fix that never gets applied. Saying "I am not sure" is cheaper than both, so
 * the grammar handled here is narrow on purpose and everything else opts out.
 */

// ─── Versions ────────────────────────────────────────────────────────────────

/**
 * "1.2.3" → [1,2,3]. Accepts a leading `v` and 1–3 numeric components (npm and
 * PEP 440 both allow `42.0`). Returns null for anything with a pre-release or
 * build suffix — comparing those correctly is a subtle job with its own rules in
 * each ecosystem, and advisory patch versions are stable releases in practice.
 */
function parseVersion(v) {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

/** -1 / 0 / 1 */
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/** The first non-zero component — what `^` pivots on for 0.x versions. */
function caretUpperBound(v) {
  if (v[0] !== 0) return [v[0] + 1, 0, 0];
  if (v[1] !== 0) return [0, v[1] + 1, 0];
  return [0, 0, v[2] + 1];
}

// ─── npm ranges ──────────────────────────────────────────────────────────────

const COMPARATOR = /^(>=|<=|>|<|=|)\s*v?(\d+(?:\.\d+)?(?:\.\d+)?)$/;

/** One space-free npm term. null = not understood. */
function satisfiesTerm(version, term) {
  const t = term.trim();
  if (!t || t === '*' || t === 'x' || t === 'X' || t === 'latest') return true;

  if (t.startsWith('^') || t.startsWith('~')) {
    const base = parseVersion(t.slice(1));
    if (!base) return null;
    if (compareVersions(version, base) < 0) return false;
    // ~1.2.3 allows patch moves only; ^1.2.3 allows minor too — and for 0.x, ^
    // narrows to the first non-zero component, which is the whole reason
    // esbuild's ^0.27.0 excludes 0.28.1.
    const upper = t[0] === '~' ? [base[0], base[1] + 1, 0] : caretUpperBound(base);
    return compareVersions(version, upper) < 0;
  }

  const m = COMPARATOR.exec(t);
  if (!m) return null;
  const target = parseVersion(m[2]);
  if (!target) return null;
  const c = compareVersions(version, target);
  switch (m[1]) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    default: return c === 0;
  }
}

/**
 * A full npm range: `||` alternatives of space-separated AND terms.
 * Hyphen ranges ("1.2.3 - 2.0.0") are not handled and return null.
 */
function satisfiesNpmRange(versionStr, range) {
  const version = parseVersion(versionStr);
  if (!version || typeof range !== 'string' || !range.trim()) return null;
  if (range.includes(' - ')) return null;

  for (const alt of range.split('||')) {
    const terms = alt.trim().split(/\s+/).filter(Boolean);
    if (!terms.length) continue;
    let all = true;
    for (const term of terms) {
      const ok = satisfiesTerm(version, term);
      if (ok === null) return null;
      if (!ok) { all = false; break; }
    }
    if (all) return true;
  }
  return false;
}

// ─── PEP 440 (the subset that appears in a pyproject) ────────────────────────

const PEP_CLAUSE = /^(>=|<=|==|>|<)\s*v?(\d+(?:\.\d+)?(?:\.\d+)?)$/;

/**
 * Comma-separated clauses, all of which must hold. `~=`, `!=`, `===`, wildcards
 * and epochs are not handled and return null — they are rare in a dependency
 * constraint and guessing at them is exactly what this module refuses to do.
 */
function satisfiesPep440(versionStr, spec) {
  const version = parseVersion(versionStr);
  if (!version || typeof spec !== 'string' || !spec.trim()) return null;

  for (const raw of spec.split(',')) {
    const m = PEP_CLAUSE.exec(raw.trim());
    if (!m) return null;
    const target = parseVersion(m[2]);
    if (!target) return null;
    const c = compareVersions(version, target);
    const ok = m[1] === '>=' ? c >= 0
      : m[1] === '<=' ? c <= 0
      : m[1] === '>' ? c > 0
      : m[1] === '<' ? c < 0
      : c === 0;
    if (!ok) return false;
  }
  return true;
}

// ─── Who depends on the vulnerable package ───────────────────────────────────

/**
 * Every range declared against `pkgName` in a lockfile-v2/v3 `packages` map,
 * including the root entry — a direct dependency's own constraint governs it
 * exactly as a parent's does.
 */
function npmRangesFor(lock, pkgName) {
  const packages = lock && lock.packages;
  if (!packages || typeof packages !== 'object') return null;
  const ranges = [];
  for (const [owner, meta] of Object.entries(packages)) {
    if (!meta || typeof meta !== 'object') continue;
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      const range = meta[field] && meta[field][pkgName];
      if (typeof range === 'string') ranges.push({ owner: owner || '(root)', range });
    }
  }
  return ranges;
}

/**
 * @returns {'refresh'|'upstream'|null} null when we could not tell
 */
function classifyNpm({ lockJson, pkgName, patchedVersion }) {
  if (!patchedVersion) return null;
  let lock;
  try { lock = typeof lockJson === 'string' ? JSON.parse(lockJson) : lockJson; }
  catch { return null; }

  const ranges = npmRangesFor(lock, pkgName);
  // No declared range anywhere: the package is in the tree but nothing we can
  // read constrains it. That is not evidence either way.
  if (!ranges || ranges.length === 0) return null;

  const blockers = [];
  for (const { owner, range } of ranges) {
    const ok = satisfiesNpmRange(patchedVersion, range);
    if (ok === null) return null; // one unparseable range poisons the verdict
    if (!ok) blockers.push({ owner, range });
  }
  return blockers.length ? 'upstream' : 'refresh';
}

/**
 * Python constraints live in pyproject.toml, not in the lock the advisory names.
 * Read without a TOML parser: find the dependency arrays and pick out the entry
 * for this package. Anything unexpected → null.
 */
function pyprojectConstraint(text, pkgName) {
  if (typeof text !== 'string' || !pkgName) return null;
  const name = pkgName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[-_]/g, '[-_]');
  // "cryptography>=42.0", 'cryptography >= 42.0', "cryptography[extra]>=42.0"
  const re = new RegExp(`["']\\s*${name}\\s*(?:\\[[^\\]]*\\])?\\s*([^"']*)["']`, 'i');
  const m = re.exec(text);
  if (!m) return null;
  const spec = m[1].trim().replace(/^;.*$/, '').trim();
  return spec || '*'; // bare "cryptography" — unconstrained
}

/** @returns {'refresh'|'upstream'|null} */
function classifyPip({ pyprojectText, pkgName, patchedVersion }) {
  if (!patchedVersion) return null;
  const spec = pyprojectConstraint(pyprojectText, pkgName);
  if (spec === null) return null;
  if (spec === '*') return 'refresh';
  const ok = satisfiesPep440(patchedVersion, spec);
  if (ok === null) return null;
  return ok ? 'refresh' : 'upstream';
}

/**
 * The command that actually resolves a `refresh`. Shown verbatim in the UI —
 * a badge saying "one command" without naming it just relocates the puzzle.
 */
function refreshCommand(ecosystem, pkgName, manifestPath) {
  const dir = manifestPath && manifestPath.includes('/')
    ? manifestPath.slice(0, manifestPath.lastIndexOf('/'))
    : null;
  const cd = dir ? `cd ${dir} && ` : '';
  switch (String(ecosystem || '').toLowerCase()) {
    case 'npm': return `${cd}npm update ${pkgName}`;
    case 'pip': return `${cd}uv lock --upgrade-package ${pkgName}`;
    default: return null;
  }
}

module.exports = {
  parseVersion,
  compareVersions,
  satisfiesNpmRange,
  satisfiesPep440,
  npmRangesFor,
  classifyNpm,
  classifyPip,
  pyprojectConstraint,
  refreshCommand,
};
