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

// ─── npm's own verdict ───────────────────────────────────────────────────────
//
// classifyNpm above answers "can the patched version be installed given the
// parents' CURRENT versions". That is the wrong question, and shipping it was a
// mistake worth recording: npm is also free to update those parents.
//
// Measured on this installation, every single "blocked upstream" row was wrong
// because of it. `miniflare` pins `undici` to exactly 7.24.8, so the range math
// called it blocked — but miniflare arrives via `wrangler ^4.98.0`, and a
// wrangler inside that same range ships a miniflare pinning the patched 7.28.0.
// One `npm update` away, reported as "nothing you can run".
//
// `npm audit --json` answers the right question, with the full registry behind
// it, and distinguishes the case range math cannot see at all: a fix that
// requires a semver-major bump of an ancestor, which genuinely is a decision.
// So for npm we ask npm, and the range math is kept only for the direction it
// is still sound in — see classifyNpmFromAudit's caller.

/**
 * @param {object} dryRun  parsed `npm audit fix --dry-run --json`
 * @param {string} pkgName
 * @param {string|null} ghsaId  when known, require npm to have THIS advisory —
 *        `fixAvailable` is per package, so a package whose entry does not
 *        mention our advisory tells us nothing about our advisory.
 * @returns {{verdict:'refresh'|'breaking'|'upstream', fix?:object}|null}
 */
function classifyNpmFromAuditFix(dryRun, pkgName, ghsaId) {
  if (!dryRun || typeof dryRun !== 'object') return null;
  const vulns = dryRun.audit && dryRun.audit.vulnerabilities;
  if (!vulns || typeof vulns !== 'object') return null;
  const entry = vulns[pkgName];
  if (!entry || typeof entry !== 'object') return null;

  if (ghsaId) {
    const via = Array.isArray(entry.via) ? entry.via : [];
    const mentioned = via.some((v) => v && typeof v === 'object'
      && String(v.url || '').toUpperCase().includes(String(ghsaId).toUpperCase()));
    if (!mentioned) return null;
  }

  const fa = entry.fixAvailable;
  if (fa === false) return { verdict: 'upstream' };

  // The decisive check, and the reason this reads a `--dry-run` rather than a
  // plain audit: `fixAvailable: true` does NOT mean running the command changes
  // anything. Reported from a real project — `npm audit fix` answered "up to
  // date", left the advisories in place, and told the user to run `npm audit
  // fix` again, which did the same. Both affected projects here reported
  // fixAvailable: true alongside added/removed/changed all zero.
  //
  // So npm's own plan is what gets believed, not its summary of it. If npm
  // would touch nothing, there is nothing to run, whatever the flag says.
  const willChange = (Number(dryRun.added) || 0)
    + (Number(dryRun.removed) || 0)
    + (Number(dryRun.changed) || 0) > 0;
  if (!willChange) return { verdict: 'upstream' };

  if (fa && typeof fa === 'object') {
    // { name, version, isSemVerMajor } — a fix exists but reaching it means
    // moving an ancestor across a major boundary. Not a refresh, not a wait.
    return fa.isSemVerMajor
      ? { verdict: 'breaking', fix: { name: fa.name, version: fa.version } }
      : { verdict: 'refresh' };
  }
  if (fa === true) return { verdict: 'refresh' };
  return null;
}

// ─── What `npm update` would do ──────────────────────────────────────────────
//
// `npm audit fix` is not the last word, and believing it was left a real fix
// reported as "blocked upstream" for a second time.
//
// audit fix only bumps packages it can reach along the ADVISORY's own dependency
// chain. It will not update an unrelated-looking parent that merely happens to
// carry a newer copy of the vulnerable package. Observed: esbuild 0.27.4 was
// flagged, `npm audit fix` planned nothing — but `tsx` was declared `^4.21.0`,
// and tsx 4.23.8 (already inside that range) requires `esbuild ~0.28.0`. One
// `npm update tsx` moved esbuild to 0.28.1 and cleared the advisory.
//
// So when audit fix gives up, ask what `npm update` would do. It respects the
// ranges already in package.json — nothing here proposes widening them — and
// its plan is again the evidence, not a summary of one.
//
// `npm update --dry-run` ignores `--json` (verified on npm 11), so the plan
// arrives as lines of `change <name> <from> => <to>` / `add <name> <version>`.

/** Parse the plan into name → resulting version. Unrecognised lines are skipped. */
function parseNpmUpdatePlan(text) {
  const planned = new Map();
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    let m = /^change\s+(\S+)\s+(\S+)\s*=>\s*(\S+)$/.exec(line);
    if (m) { planned.set(m[1], m[3]); continue; }
    m = /^add\s+(\S+)\s+(\S+)$/.exec(line);
    if (m) { planned.set(m[1], m[2]); }
  }
  return planned;
}

/**
 * Every installed copy of `pkgName`, with the version at each location.
 *
 * npm installs a package more than once whenever two parents want incompatible
 * ranges, and the plan above names packages WITHOUT paths — so with several
 * copies present, "change undici 7.24.8 => 7.29.0" cannot be attributed to one
 * of them. Enumerating the copies is what makes that ambiguity detectable.
 */
function npmInstalledCopies(lock, pkgName) {
  const packages = lock && lock.packages;
  if (!packages || typeof packages !== 'object' || !pkgName) return null;
  const suffix = `node_modules/${pkgName}`;
  const copies = [];
  for (const [key, meta] of Object.entries(packages)) {
    if (key === suffix || key.endsWith(`/${suffix}`)) {
      copies.push({ path: key, version: (meta && meta.version) || null });
    }
  }
  return copies;
}

/**
 * Would `npm update` land a version at or past the patch?
 *
 * @param {Map} planned  from parseNpmUpdatePlan
 * @param {Array|null} installedCopies  from npmInstalledCopies — REQUIRED, and
 *        the verdict is withheld unless there is exactly one copy. This closes
 *        a hole that nearly shipped: my-next-studio-web carried a hoisted
 *        `undici@7.29.0` (patched) beside a nested
 *        `miniflare/node_modules/undici@7.28.0` (vulnerable). A plan bumping the
 *        hoisted copy would have read as fixing the advisory while the
 *        vulnerable one sat untouched — a false "run one command" of exactly the
 *        kind this module exists to prevent. With one copy there is nothing to
 *        confuse; with several, npm's text plan simply does not carry enough
 *        information, so the answer is no answer.
 * @returns {'refresh'|null} null = no opinion, keep whatever the caller had
 */
function classifyNpmFromUpdatePlan(planned, pkgName, patchedVersion, installedCopies) {
  if (!(planned instanceof Map) || !pkgName || !patchedVersion) return null;
  if (!Array.isArray(installedCopies) || installedCopies.length !== 1) return null;
  const to = planned.get(pkgName);
  const a = parseVersion(to);
  const b = parseVersion(patchedVersion);
  if (!a || !b) return null;
  return compareVersions(a, b) >= 0 ? 'refresh' : null;
}

/** `node_modules/a/node_modules/b` → `b`; scoped names survive intact. */
function packageNameFromLockKey(key) {
  const i = String(key || '').lastIndexOf('node_modules/');
  return i === -1 ? null : key.slice(i + 'node_modules/'.length) || null;
}

/**
 * The narrowest command that does the job: the parents of the vulnerable
 * package that this plan would actually move. Bare `npm update` would work too,
 * but it also moves every other dependency in the project — a much larger
 * action than the row is asking for, and not one to suggest casually.
 */
function npmUpdateTargets(planned, lock, pkgName) {
  const ranges = npmRangesFor(lock, pkgName);
  if (!ranges || !(planned instanceof Map)) return [];
  const names = new Set();
  for (const { owner } of ranges) {
    const name = packageNameFromLockKey(owner);
    if (name && planned.has(name)) names.add(name);
  }
  return [...names].sort();
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
    // `npm audit fix` rather than `npm update <pkg>`: the fix frequently lies in
    // bumping an ANCESTOR, not the vulnerable package itself, and `npm update
    // undici` does nothing when miniflare pins it. audit fix resolves the whole
    // chain, and is the command npm's own verdict is describing.
    case 'npm': return `${cd}npm audit fix`;
    case 'pip': return `${cd}uv lock --upgrade-package ${pkgName}`;
    default: return null;
  }
}

/** The targeted install a `breaking` row needs, so the review has a subject. */
function breakingCommand(fix, manifestPath) {
  if (!fix || !fix.name || !fix.version) return null;
  const dir = manifestPath && manifestPath.includes('/')
    ? manifestPath.slice(0, manifestPath.lastIndexOf('/')) : null;
  return `${dir ? `cd ${dir} && ` : ''}npm install ${fix.name}@${fix.version}`;
}

module.exports = {
  parseVersion,
  compareVersions,
  satisfiesNpmRange,
  satisfiesPep440,
  npmRangesFor,
  classifyNpm,
  classifyNpmFromAuditFix,
  parseNpmUpdatePlan,
  npmInstalledCopies,
  classifyNpmFromUpdatePlan,
  npmUpdateTargets,
  packageNameFromLockKey,
  classifyPip,
  pyprojectConstraint,
  refreshCommand,
  breakingCommand,
};
