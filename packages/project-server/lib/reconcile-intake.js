#!/usr/bin/env node
/**
 * reconcile-intake — inventory a branch built outside Build Studio before it
 * is brought home (docs/plans/reconciliation-workflow.md, step 1).
 *
 * It answers, before anyone merges or reviews anything:
 *   - Is the source committed? A source with modified or untracked files is
 *     refused, with the list. The owner commits there; this script never
 *     writes in the source checkout (owner decision 2026-11-01).
 *   - Which exact revision is it? The source is fetched into the project's
 *     repository and pinned on refs/build-studio/reconcile/<id>/source, so the
 *     review is tied to one SHA, which stays traceable after the source is gone.
 *   - Does it merge? `git merge-tree --write-tree` is a dry run: it touches
 *     neither the working tree nor any branch.
 *   - What does it touch, how risky is that, and which ids did it allocate
 *     that the target has also allocated since the two parted?
 *
 * The only writes are to the project's repository: fetched objects and the
 * pin ref.
 *
 * Usage:
 *   node reconcile-intake.js --source <path> [--branch <name>]   # another clone or worktree
 *   node reconcile-intake.js --ref <branch-or-commit>            # already in the project repo
 *     [--project <path>] [--target <ref>] [--id <slug>] [--docs <rel>] [--json]
 * Exit code 0 with an inventory, 2 when the source is refused, 1 on error.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PIN_PREFIX = 'refs/build-studio/reconcile';
const LARGE_BYTES = 1024 * 1024;

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, ...opts });
}

// ─── Path classes and the risk tier ─────────────────────────────────────────

// Order matters only for the label shown; a path can be in several classes.
// Sensitive classes are the plan's Sensitive tier triggers. The patterns are
// a heuristic by design: the owner sees the triggering paths and may lower the
// tier with a reason, so a false positive costs a sentence, a miss costs a
// review that never happened.
const CLASSES = [
  { key: 'ci', label: 'CI workflow changed', sensitive: true,
    test: (p) => /^\.github\/workflows\/|^\.gitlab-ci|^\.circleci\/|(^|\/)fastlane\/|(^|\/)bitrise\.ya?ml$/.test(p) },
  { key: 'signing', label: 'Signing or capabilities changed', sensitive: true,
    test: (p) => /\.entitlements$|\.mobileprovision$|(^|\/)ExportOptions[^/]*\.plist$/.test(p) },
  { key: 'dependencies', label: 'Dependencies changed', sensitive: true,
    test: (p) => /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Package\.swift|Package\.resolved|Podfile(\.lock)?|Gemfile(\.lock)?|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|go\.(mod|sum)|Cargo\.(toml|lock)|build\.gradle(\.kts)?|libs\.versions\.toml)$/.test(p) },
  { key: 'migrations', label: 'Data model or migrations changed', sensitive: true,
    test: (p) => /(^|\/)migrations?\/|\.xcdatamodeld?(\/|$)|(^|\/)schema\.(prisma|sql|graphql)$|\.sql$/.test(p) },
  { key: 'auth', label: 'Authentication code changed', sensitive: true,
    // Not "session": in managed apps it as often means a work session as a login.
    test: (p) => /auth(?!or)|login|signin|sign-in|password|keychain/i.test(p) },
  { key: 'payments', label: 'Payments or entitlements changed', sensitive: true,
    // An `.entitlements` file is app capabilities, classed under signing.
    test: (p) => /paywall|purchase|storekit|entitlement(?!s$)|subscription|billing|stripe|payment/i.test(p) },
  { key: 'privacy', label: 'Analytics, consent or privacy changed', sensitive: true,
    test: (p) => /analytics|consent|privacy|tracking|telemetry|\.xcprivacy$/i.test(p) },
  { key: 'test', label: 'Tests',
    test: (p) => /(^|\/)(tests?|__tests__|e2e|spec)\/|[^/]*(UITests|Tests)\/|\.(test|spec)\.[a-z]+$/i.test(p) },
  { key: 'copy', label: 'Copy and localisation',
    test: (p) => /\.(xcstrings|strings|stringsdict|po|arb)$|(^|\/)(locales?|i18n|l10n)\//i.test(p) },
  { key: 'asset', label: 'Assets',
    test: (p) => /\.xcassets\/|\.(png|jpe?g|gif|webp|svg|heic|ico|pdf|mp4|mov|webm|m4a|mp3|wav|woff2?|ttf|otf)$/i.test(p) },
  { key: 'style', label: 'Stylesheets', test: (p) => /\.(css|scss|sass|less)$/i.test(p) },
];

/** Classes of one path. `docs` and `code` are the fallbacks. */
function classifyPath(p, docsRel = 'docs') {
  const out = CLASSES.filter((c) => c.test(p)).map((c) => c.key);
  const inDocs = p === docsRel || p.startsWith(`${docsRel}/`) || /^[^/]+\.md$/i.test(p);
  if (inDocs) return ['docs', ...out.filter((k) => k === 'asset')];
  if (out.length === 0) out.push('code');
  return out;
}

const LIGHT_CLASSES = new Set(['docs', 'copy', 'asset', 'style']);

/**
 * Suggested tier from classified files: Sensitive when any file triggers a
 * sensitive class, Light when every file is documentation, copy, an asset or
 * a stylesheet, Standard otherwise. Triggers carry up to three example paths.
 */
function suggestTier(files) {
  const triggers = [];
  for (const c of CLASSES.filter((x) => x.sensitive)) {
    const hits = files.filter((f) => f.classes.includes(c.key)).map((f) => f.path);
    if (hits.length) triggers.push({ class: c.key, label: c.label, count: hits.length, examples: hits.slice(0, 3) });
  }
  if (triggers.length) return { tier: 'sensitive', triggers };
  if (files.every((f) => f.classes.every((k) => LIGHT_CLASSES.has(k)))) return { tier: 'light', triggers: [] };
  return { tier: 'standard', triggers: [] };
}

// ─── Ids ────────────────────────────────────────────────────────────────────

const ID_RE = /^([A-Z]{2,6})-(\d{1,5})(?=[-_.])/;

/** Ids named by file basenames under docs/ in a tree: {'PRD-068': [paths]}. */
function idsInTree(projectRoot, rev, docsRel) {
  const ids = new Map();
  let raw = '';
  try { raw = git(projectRoot, ['ls-tree', '-r', '--name-only', '-z', rev, '--', docsRel]); } catch (_) { return ids; }
  for (const p of raw.split('\0').filter(Boolean)) {
    const m = path.basename(p).match(ID_RE);
    if (!m) continue;
    const id = `${m[1]}-${m[2]}`;
    if (!ids.has(id)) ids.set(id, []);
    ids.get(id).push(p);
  }
  return ids;
}

/**
 * Ids the source allocated (absent at the merge-base), and those the target
 * has also allocated since — the same id meaning two different things. The
 * target wins; the incoming side is renumbered at integration.
 */
function idReport(projectRoot, { base, source, target, docsRel }) {
  const atBase = idsInTree(projectRoot, base, docsRel);
  const inSource = idsInTree(projectRoot, source, docsRel);
  const inTarget = idsInTree(projectRoot, target, docsRel);
  const added = [...inSource.keys()].filter((id) => !atBase.has(id)).sort(byId);
  const collisions = added.filter((id) => inTarget.has(id))
    .map((id) => ({ id, source: inSource.get(id), target: inTarget.get(id) }));
  return { added, collisions };
}

function byId(a, b) {
  const [pa, na] = a.split('-'); const [pb, nb] = b.split('-');
  return pa === pb ? Number(na) - Number(nb) : pa.localeCompare(pb);
}

// ─── The source ─────────────────────────────────────────────────────────────

/**
 * Uncommitted state of a checkout: modified/staged/deleted and untracked
 * files, untracked ones with their size. Ignored files are not listed: git
 * would not bring them home either.
 */
function sourceStatus(sourcePath) {
  const raw = git(sourcePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = raw.split('\0');
  const modified = [];
  const untracked = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e) continue;
    const xy = e.slice(0, 2);
    const p = e.slice(3);
    if (xy[0] === 'R' || xy[0] === 'C') i++; // -z puts the old path in the next field
    if (xy === '??') {
      let size = null;
      try { size = fs.statSync(path.join(sourcePath, p)).size; } catch (_) { /* gone meanwhile */ }
      untracked.push({ path: p, size });
    } else {
      modified.push({ path: p, status: xy.trim() });
    }
  }
  return { clean: modified.length === 0 && untracked.length === 0, modified, untracked };
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'source';
}

/**
 * Fetch the source into the project and pin it. A pin that already exists for
 * this id must point at the same commit: the record is tied to one SHA, and a
 * new revision is a new intake.
 */
function pinSource(projectRoot, { sourcePath, branch, ref, id }) {
  const pin = `${PIN_PREFIX}/${id}/source`;
  let sha;
  if (sourcePath) {
    const srcRef = branch ? `refs/heads/${branch}` : 'HEAD';
    sha = git(sourcePath, ['rev-parse', '--verify', `${srcRef}^{commit}`]).trim();
    git(projectRoot, ['fetch', '--quiet', '--no-tags', sourcePath, srcRef]);
    const fetched = git(projectRoot, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).trim();
    if (fetched !== sha) throw new Error(`the source moved while it was fetched (${sha.slice(0, 8)} → ${fetched.slice(0, 8)}); run intake again`);
  } else {
    sha = git(projectRoot, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  }
  let existing = null;
  try { existing = git(projectRoot, ['rev-parse', '--verify', '--quiet', pin]).trim(); } catch (_) { /* not pinned yet */ }
  if (existing && existing !== sha) {
    throw new Error(`${pin} already pins ${existing.slice(0, 8)}, not ${sha.slice(0, 8)}. A new revision is a new intake: pass a different --id.`);
  }
  if (!existing) git(projectRoot, ['update-ref', pin, sha]);
  return { pin, sha };
}

function defaultBranch(projectRoot) {
  try {
    return git(projectRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).trim().replace(/^origin\//, '');
  } catch (_) {
    for (const b of ['main', 'master']) {
      try { git(projectRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]); return b; } catch (_) { /* next */ }
    }
  }
  throw new Error('could not tell the default branch; pass --target');
}

// ─── The diff ───────────────────────────────────────────────────────────────

/** Blob sizes of every file in a tree, from one `ls-tree -l`. */
function treeSizes(projectRoot, rev) {
  const sizes = new Map();
  for (const rec of git(projectRoot, ['ls-tree', '-r', '-l', '-z', rev]).split('\0')) {
    const m = rec.match(/^\d+ blob [0-9a-f]+\s+(\d+)\t(.+)$/s);
    if (m) sizes.set(m[2], Number(m[1]));
  }
  return sizes;
}

/** Files the source changed since the merge-base, classified, with their size in the source. */
function changedFiles(projectRoot, { base, source, docsRel }) {
  const status = new Map();
  const ns = git(projectRoot, ['diff', '--name-status', '-z', '--no-renames', base, source]).split('\0');
  for (let i = 0; i + 1 < ns.length; i += 2) if (ns[i]) status.set(ns[i + 1], ns[i]);
  const sizes = treeSizes(projectRoot, source);
  const files = [];
  for (const rec of git(projectRoot, ['diff', '--numstat', '-z', '--no-renames', base, source]).split('\0')) {
    if (!rec) continue;
    const [added, deleted, ...rest] = rec.split('\t');
    const p = rest.join('\t');
    const binary = added === '-' && deleted === '-';
    const st = status.get(p) || 'M';
    const size = st === 'D' ? null : (sizes.get(p) ?? null);
    files.push({
      path: p, status: st, classes: classifyPath(p, docsRel), binary, size,
      added: binary ? null : Number(added), deleted: binary ? null : Number(deleted),
    });
  }
  return files;
}

/** Dry-run merge. Nothing is written but loose objects for the result tree. */
function dryRunMerge(projectRoot, target, source) {
  try {
    git(projectRoot, ['merge-tree', '--write-tree', '--name-only', '--no-messages', target, source]);
    return { clean: true, conflicts: [] };
  } catch (e) {
    if (e.status !== 1) throw e;
    const lines = String(e.stdout || '').split('\n').slice(1).filter(Boolean);
    return { clean: false, conflicts: [...new Set(lines)].sort() };
  }
}

// ─── Intake ─────────────────────────────────────────────────────────────────

/**
 * Run the intake. Returns { refused: true, status } for an uncommitted source,
 * otherwise the inventory. Throws on a git error the caller should see.
 */
function intake({ projectRoot, sourcePath, branch, ref, target, id, docsRel = 'docs' }) {
  projectRoot = path.resolve(projectRoot);
  if (!sourcePath && !ref) throw new Error('name the source: --source <path> or --ref <branch-or-commit>');
  if (sourcePath) {
    sourcePath = path.resolve(sourcePath);
    if (!branch) {
      try { branch = git(sourcePath, ['symbolic-ref', '--short', 'HEAD']).trim(); } catch (_) { branch = null; }
    }
    const status = sourceStatus(sourcePath);
    if (!status.clean) return { refused: true, source: { path: sourcePath, branch }, status };
  }
  const targetRef = target || defaultBranch(projectRoot);
  const name = id || slug(branch || ref);
  const { pin, sha } = pinSource(projectRoot, { sourcePath, branch, ref, id: name });
  const targetSha = git(projectRoot, ['rev-parse', '--verify', `${targetRef}^{commit}`]).trim();
  const base = git(projectRoot, ['merge-base', targetSha, sha]).trim();
  const count = (range) => Number(git(projectRoot, ['rev-list', '--count', range]).trim());
  const files = changedFiles(projectRoot, { base, source: sha, docsRel });
  return {
    refused: false,
    id: name,
    source: { path: sourcePath || null, branch: branch || null, ref: ref || null, sha, pin, commits: count(`${base}..${sha}`) },
    target: { ref: targetRef, sha: targetSha, commitsSinceBase: count(`${base}..${targetSha}`) },
    mergeBase: base,
    merge: dryRunMerge(projectRoot, targetSha, sha),
    files,
    risk: suggestTier(files),
    ids: idReport(projectRoot, { base, source: sha, target: targetSha, docsRel }),
    // Binaries, and text files large enough to question: the interview decides
    // what of design work (scenes, archives, video) belongs in git.
    bulky: files.filter((f) => f.size != null && (f.binary || f.size >= LARGE_BYTES))
      .map((f) => ({ path: f.path, size: f.size, binary: f.binary, large: f.size >= LARGE_BYTES })),
  };
}

// ─── Markdown ───────────────────────────────────────────────────────────────

function mb(n) { return n == null ? '?' : n >= LARGE_BYTES ? `${(n / LARGE_BYTES).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`; }
function list(items, fmt, max = 30) {
  const shown = items.slice(0, max).map(fmt);
  if (items.length > max) shown.push(`- … and ${items.length - max} more`);
  return shown.join('\n');
}

/** Markdown blocks joined by blank lines; a null block is left out. */
function blocks(...parts) {
  return parts.filter((p) => p != null).join('\n\n');
}

function renderMarkdown(r) {
  if (r.refused) {
    const { modified, untracked } = r.status;
    return blocks(
      '## Intake refused: the source has uncommitted work',
      `\`${r.source.path}\`${r.source.branch ? ` on \`${r.source.branch}\`` : ''} has ${modified.length} modified and ${untracked.length} untracked file(s). `
        + 'Commit what belongs to the work in the source, delete or ignore what does not, then run intake again. '
        + 'Nothing was fetched or written.',
      modified.length ? `### Modified (${modified.length})\n\n${list(modified, (f) => `- \`${f.status}\` ${f.path}`)}` : null,
      untracked.length ? `### Untracked (${untracked.length})\n\n${list(untracked, (f) => `- ${f.path} (${mb(f.size)})${f.size >= LARGE_BYTES ? ' **large**' : ''}`)}` : null,
    );
  }
  const counts = {};
  for (const f of r.files) for (const k of f.classes) counts[k] = (counts[k] || 0) + 1;
  const src = r.source.path ? `\`${r.source.path}\` on \`${r.source.branch || 'HEAD'}\`` : `\`${r.source.ref}\``;
  return blocks(
    `## Reconcile intake: ${r.id}`,
    [
      `- **Source:** ${src} at \`${r.source.sha.slice(0, 10)}\`, pinned on \`${r.source.pin}\` (${r.source.commits} commit(s) since the merge-base)`,
      `- **Target:** \`${r.target.ref}\` at \`${r.target.sha.slice(0, 10)}\` (${r.target.commitsSinceBase} commit(s) since the merge-base)`,
      `- **Merge-base:** \`${r.mergeBase.slice(0, 10)}\``,
      `- **Dry-run merge:** ${r.merge.clean ? 'clean' : `${r.merge.conflicts.length} conflicting file(s)`}`,
      `- **Files changed:** ${r.files.length} (${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')})`,
      `- **Suggested risk tier:** ${r.risk.tier[0].toUpperCase()}${r.risk.tier.slice(1)}`,
    ].join('\n'),
    r.risk.triggers.length ? `### Risk triggers\n\n${r.risk.triggers.map((t) => `- ${t.label} (${t.count}): ${t.examples.map((e) => `\`${e}\``).join(', ')}${t.count > t.examples.length ? ', …' : ''}`).join('\n')}` : null,
    r.merge.conflicts.length ? `### Conflicts\n\n${list(r.merge.conflicts, (p) => `- ${p}`)}` : null,
    `### Ids\n\n${r.ids.added.length ? `Allocated by the source: ${r.ids.added.join(', ')}.` : 'The source allocated no new ids.'}`,
    r.ids.collisions.length ? `**Collisions** (the target allocated the same id since the merge-base; the incoming side is renumbered):\n\n${r.ids.collisions.map((c) => `- ${c.id}: source ${c.source.join(', ')} · target ${c.target.join(', ')}`).join('\n')}` : null,
    r.bulky.length ? `### Binaries and large files (${r.bulky.length}, ${mb(r.bulky.reduce((n, b) => n + b.size, 0))})\n\n${list([...r.bulky].sort((a, b) => b.size - a.size), (b) => `- ${b.path} (${mb(b.size)})${b.large ? ' **large**' : ''}${b.binary ? '' : ' text'}`)}` : null,
    `### Files\n\n${list(r.files, (f) => `- \`${f.status}\` ${f.path} — ${f.classes.join(', ')}`, 400)}`,
  );
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--json') opts.json = true;
    else if (a === '--project') opts.projectRoot = val();
    else if (a === '--source') opts.sourcePath = val();
    else if (a === '--branch') opts.branch = val();
    else if (a === '--ref') opts.ref = val();
    else if (a === '--target') opts.target = val();
    else if (a === '--id') opts.id = val();
    else if (a === '--docs') opts.docsRel = val().replace(/^\.\//, '').replace(/\/$/, '');
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function main(argv = process.argv.slice(2)) {
  let result;
  try {
    const opts = parseArgs(argv);
    result = intake({ projectRoot: process.cwd(), ...opts });
    process.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : `${renderMarkdown(result)}\n`);
  } catch (e) {
    process.stderr.write(`reconcile-intake: ${(e.stderr && String(e.stderr).trim()) || e.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (result.refused) process.exitCode = 2;
}

if (require.main === module) {
  main();
}

module.exports = { intake, renderMarkdown, classifyPath, suggestTier, sourceStatus, idReport, dryRunMerge, main, PIN_PREFIX };
