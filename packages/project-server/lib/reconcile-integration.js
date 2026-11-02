'use strict';

/**
 * The reconcile track's integration step (docs/plans/reconciliation-workflow.md,
 * "Integration branch"): build `reconcile/<record-id>` from the target, with the
 * pinned source as ONE import commit holding only what comes home.
 *
 *   1. Renumber. Ids the source allocated that the target has also used since
 *      are renumbered on a branch cut from the pin, `reconcile/<id>-incoming`,
 *      which carries only that change so it can be reviewed alone. The target
 *      wins.
 *   2. Import. `git merge --squash` of the incoming branch into the target: the
 *      merge machinery's three-way result, but none of the source's history.
 *      (A history merge brought 57 MB, including the excluded files, for a
 *      21 MB result in the first case.)
 *   3. Keep out. Every path in the record's `reconcile-keep-out` block is
 *      restored to the target's version, or removed if the target lacks it.
 *   4. LFS. Files under docs/ are renormalised, so design sources a
 *      .gitattributes rule names are stored as LFS pointers.
 *   5. Commit, once.
 *
 * A conflict stops at step 2 with the conflicting paths. The owner (or an
 * agent) resolves them in the track's worktree, then `continueIntegration`
 * finishes steps 3–5.
 *
 * Runs in its own worktree, `tmp/.worktrees/reconcile-<record-id>`, so the
 * project checkout, where ordinary runs work, is never switched.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const tracks = require('./reconcile-track');
const { parseKeepOut } = require('./reconcile-sessions');
const { idReport } = require('./reconcile-intake');

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28, ...opts });
}

function tryGit(cwd, args) {
  try { return { ok: true, out: git(cwd, args) }; } catch (e) { return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || e.message) }; }
}

function defaultBranch(projectRoot) {
  const r = tryGit(projectRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (r.ok) return r.out.trim().replace(/^origin\//, '');
  for (const b of ['main', 'master']) if (tryGit(projectRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).ok) return b;
  throw new Error('could not tell the default branch');
}

const ID_IN_NAME = /^([A-Z]{2,6})-(\d{1,5})(?=[-_.])/;

/** The highest number per prefix among file basenames under docs/ in a tree. */
function maxIdsInTree(cwd, rev, docsRel) {
  const max = {};
  const raw = tryGit(cwd, ['ls-tree', '-r', '--name-only', '-z', rev, '--', docsRel]);
  if (!raw.ok) return max;
  for (const p of raw.out.split('\0').filter(Boolean)) {
    const m = path.basename(p).match(ID_IN_NAME);
    if (m) max[m[1]] = Math.max(max[m[1]] || 0, Number(m[2]));
  }
  return max;
}

/**
 * New ids for the colliding ones: above everything either side has used, and
 * above the track's floor. Returns { 'EX-002': 'EX-009', … }.
 */
function renumberMap(collisions, { targetMax, sourceMax, floor }) {
  const next = {};
  const map = {};
  for (const id of [...collisions].sort()) {
    const [prefix, num] = id.split('-');
    if (next[prefix] == null) {
      next[prefix] = Math.max(targetMax[prefix] || 0, sourceMax[prefix] || 0, Number((floor || {})[prefix]) || 0) + 1;
    }
    map[id] = `${prefix}-${String(next[prefix]).padStart(num.length, '0')}`;
    next[prefix] += 1;
  }
  return map;
}

/** Rewrite every reference to a mapped id, in one pass per file so no rename chains. */
function rewriteIds(text, map) {
  const ids = Object.keys(map);
  if (!ids.length) return text;
  const re = new RegExp(`\\b(${ids.map((i) => i.replace(/[-]/g, '\\-')).join('|')})\\b`, 'g');
  return text.replace(re, (m) => map[m]);
}

/** Renumber in a worktree: rename files named after an id, rewrite text references, commit. */
function applyRenumber(cwd, map, recordId) {
  const ids = Object.keys(map);
  for (const p of git(cwd, ['ls-files', '-z']).split('\0').filter(Boolean)) {
    const m = path.basename(p).match(ID_IN_NAME);
    const id = m && `${m[1]}-${m[2]}`;
    if (id && map[id]) {
      const to = path.join(path.dirname(p), path.basename(p).replace(id, map[id]));
      git(cwd, ['mv', p, to]);
    }
  }
  const files = tryGit(cwd, ['grep', '-l', '-z', '-I', ...ids.flatMap((i) => ['-e', i])]);
  for (const p of (files.ok ? files.out : '').split('\0').filter(Boolean)) {
    const abs = path.join(cwd, p);
    const before = fs.readFileSync(abs, 'utf8');
    const after = rewriteIds(before, map);
    if (after !== before) fs.writeFileSync(abs, after);
  }
  git(cwd, ['add', '-A']);
  const list = ids.sort().map((i) => `${i} → ${map[i]}`).join(', ');
  git(cwd, ['commit', '-q', '-m', `chore(${recordId}): renumber the incoming ids that collide with the target`, '-m', `${list}. File names and references only; the target keeps its ids.`]);
}

function unmergedPaths(cwd) {
  const r = tryGit(cwd, ['diff', '--name-only', '--diff-filter=U']);
  return r.ok ? r.out.split('\n').filter(Boolean).sort() : [];
}

function hasConflictMarkers(cwd, paths) {
  return paths.filter((p) => {
    try { return /^(<{7}|>{7}) /m.test(fs.readFileSync(path.join(cwd, p), 'utf8')); } catch (_) { return false; }
  });
}

/** Steps 3–5: keep-out, LFS, the one commit. */
function finishImport(cwd, { track, keepOut, targetSha, docsRel, renumbered }) {
  for (const p of keepOut) {
    const onTarget = tryGit(cwd, ['cat-file', '-e', `${targetSha}:${p}`]).ok;
    const isDirOnTarget = onTarget && git(cwd, ['cat-file', '-t', `${targetSha}:${p}`]).trim() === 'tree';
    git(cwd, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', p]);
    fs.rmSync(path.join(cwd, p), { recursive: true, force: true });
    if (onTarget || isDirOnTarget) git(cwd, ['checkout', targetSha, '--', p]);
  }
  // Store design sources as LFS pointers where .gitattributes says so; a no-op otherwise.
  if (fs.existsSync(path.join(cwd, docsRel))) tryGit(cwd, ['add', '--renormalize', '--', docsRel]);
  const src = track.source || {};
  const lines = [
    `One import commit, per the reconcile plan: the source's final tree, pinned at ${String(src.sha).slice(0, 10)} (${src.pin}), without what stays out. Its history is not merged; it stays on the pin${src.path ? ` and in ${src.path}` : ''}.`,
  ];
  if (keepOut.length) lines.push(`Kept out (as on the target): ${keepOut.join(', ')}.`);
  const ren = Object.entries(renumbered || {});
  if (ren.length) lines.push(`Renumbered on the incoming side: ${ren.map(([a, b]) => `${a} → ${b}`).join(', ')}.`);
  lines.push(`The record is ${track.record}. This is the builder's implementation as it came home; the align step makes it meet the approved acceptance criteria.`);
  git(cwd, ['commit', '-q', '--allow-empty', '-m', `feat(${track.id}): import ${src.branch || src.ref || 'the source'}`, '-m', lines.join('\n\n')]);
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

/**
 * Run the integration step. Returns the saved track. Its step is `done` with
 * `importCommit`, or `conflict` with `conflicts` (the paths) for the owner.
 */
function integrate({ projectRoot, docsRel = 'docs', id }) {
  projectRoot = path.resolve(projectRoot);
  let track = tracks.loadTrack(projectRoot, id);
  if (!track) throw new Error(`no reconcile track ${id}`);
  if (track.status !== tracks.OPEN) throw new Error(`reconcile track ${id} is ${track.status}`);
  if (track.steps.intent_interview && track.steps.intent_interview.status !== 'done') {
    throw new Error('finish the intent interview first: the integration reads what stays out from the record');
  }
  const wt = path.join(projectRoot, 'tmp', '.worktrees', `reconcile-${id}`);
  const branch = `reconcile/${id}`;
  if (fs.existsSync(wt) || tryGit(projectRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok) {
    throw new Error(`${branch} or its worktree already exists; continue or abort the integration instead`);
  }

  const target = defaultBranch(projectRoot);
  const targetSha = git(projectRoot, ['rev-parse', '--verify', `${target}^{commit}`]).trim();
  const pin = track.source.pin;
  const pinSha = git(projectRoot, ['rev-parse', '--verify', `${pin}^{commit}`]).trim();
  const base = git(projectRoot, ['merge-base', targetSha, pinSha]).trim();
  // The record names what stays out; read it as it is on the target, where the interview wrote it.
  const recordText = tryGit(projectRoot, ['show', `${targetSha}:${track.record}`]);
  const keepOut = parseKeepOut(recordText.ok ? recordText.out : fs.readFileSync(path.join(projectRoot, track.record), 'utf8'));

  // 1. Renumber, on a branch cut from the pin.
  const ids = idReport(projectRoot, { base, source: pinSha, target: targetSha, docsRel });
  const map = renumberMap(ids.collisions.map((c) => c.id), {
    targetMax: maxIdsInTree(projectRoot, targetSha, docsRel),
    sourceMax: maxIdsInTree(projectRoot, pinSha, docsRel),
    floor: track.floor,
  });
  let incoming = pinSha;
  const incomingBranch = `reconcile/${id}-incoming`;
  if (Object.keys(map).length) {
    const iwt = path.join(projectRoot, 'tmp', '.worktrees', `reconcile-${id}-incoming`);
    git(projectRoot, ['worktree', 'add', '-q', '-b', incomingBranch, iwt, pinSha]);
    try {
      applyRenumber(iwt, map, id);
      incoming = git(iwt, ['rev-parse', 'HEAD']).trim();
    } finally {
      tryGit(projectRoot, ['worktree', 'remove', '--force', iwt]);
    }
  }

  // 2. Import, without history.
  git(projectRoot, ['worktree', 'add', '-q', '-b', branch, wt, targetSha]);
  const merged = tryGit(wt, ['merge', '--squash', '--no-commit', incoming]);
  const floor = { ...(track.floor || {}) };
  for (const to of Object.values(map)) {
    const [p, n] = to.split('-');
    floor[p] = Math.max(Number(floor[p]) || 0, Number(n));
  }
  track = {
    ...track,
    worktree: wt,
    branch,
    target: { ...track.target, ref: target, integratedOn: targetSha },
    integration: { base, incoming, incomingBranch: Object.keys(map).length ? incomingBranch : null, renumbered: map, keepOut },
    floor,
  };
  const conflicts = unmergedPaths(wt);
  if (!merged.ok && conflicts.length) {
    track = {
      ...track,
      currentStep: 'integration',
      steps: { ...track.steps, integration: { status: 'conflict', conflicts, startedAt: new Date().toISOString() } },
    };
    tracks.saveTrack(projectRoot, track);
    return track;
  }
  if (!merged.ok) throw new Error(`the import failed: ${merged.err.trim()}`);
  return complete(projectRoot, track, targetSha, docsRel);
}

function complete(projectRoot, track, targetSha, docsRel) {
  const importCommit = finishImport(track.worktree, {
    track, keepOut: track.integration.keepOut, targetSha, docsRel, renumbered: track.integration.renumbered,
  });
  const now = new Date().toISOString();
  const next = {
    ...track,
    currentStep: 'align',
    steps: {
      ...track.steps,
      integration: { ...track.steps.integration, status: 'done', completedAt: now, importCommit, conflicts: undefined },
      align: { ...(track.steps.align || {}), status: 'pending' },
    },
  };
  tracks.saveTrack(projectRoot, next);
  return next;
}

/**
 * After the owner (or an agent) resolved the conflicts in the worktree: check
 * nothing is left unmerged or marked, then keep-out, LFS, commit.
 */
function continueIntegration({ projectRoot, docsRel = 'docs', id }) {
  projectRoot = path.resolve(projectRoot);
  const track = tracks.loadTrack(projectRoot, id);
  if (!track) throw new Error(`no reconcile track ${id}`);
  const step = track.steps.integration || {};
  if (step.status !== 'conflict') throw new Error(`integration of ${id} is not waiting on a conflict`);
  const still = unmergedPaths(track.worktree);
  if (still.length) throw new Error(`still unmerged: ${still.join(', ')} (resolve and git add them)`);
  const marked = hasConflictMarkers(track.worktree, step.conflicts || []);
  if (marked.length) throw new Error(`conflict markers left in: ${marked.join(', ')}`);
  return complete(projectRoot, track, track.target.integratedOn, docsRel);
}

/** Throw the integration away (worktree and branches), back to pending. The pin stays. */
function abortIntegration({ projectRoot, id }) {
  projectRoot = path.resolve(projectRoot);
  const track = tracks.loadTrack(projectRoot, id);
  if (!track) throw new Error(`no reconcile track ${id}`);
  if (track.worktree) tryGit(projectRoot, ['worktree', 'remove', '--force', track.worktree]);
  tryGit(projectRoot, ['branch', '-D', `reconcile/${id}`]);
  tryGit(projectRoot, ['branch', '-D', `reconcile/${id}-incoming`]);
  const next = {
    ...track,
    worktree: null,
    branch: null,
    integration: null,
    currentStep: 'integration',
    steps: { ...track.steps, integration: { status: 'pending' } },
  };
  tracks.saveTrack(projectRoot, next);
  return next;
}

module.exports = { integrate, continueIntegration, abortIntegration, renumberMap, rewriteIds, maxIdsInTree };
