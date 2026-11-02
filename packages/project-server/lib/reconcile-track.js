'use strict';

/**
 * Reconcile tracks — the preparation half of bringing work built outside Build
 * Studio home (docs/plans/reconciliation-workflow.md, "The reconcile track").
 *
 * A track runs alongside the project's single workflow slot, because it waits
 * on the owner for days while ordinary runs go on (owner decision 2026-11-02).
 * So it keeps its own state, one directory per track under `tmp/reconcile/`,
 * which every managed project already ignores:
 *
 *   tmp/reconcile/<record-id>/track.json   the step machine
 *   tmp/reconcile/<record-id>/intake.md    the intake report, for people
 *   tmp/reconcile/<record-id>/intake.json  the same, for the engine
 *
 * While a track is open its id floor holds: `backlog.nextItemId` gives no id at
 * or below the highest one the incoming branch allocated on its own, so an item
 * filed in the project meanwhile never collides with one that comes home.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const intakeLib = require('./reconcile-intake');

const STEPS = ['intake', 'intent_interview', 'integration', 'align', 'team_review', 'owner_decision', 'apply', 'ready'];
const OPEN = 'open';

function tracksRoot(projectRoot) {
  return path.join(projectRoot, 'tmp', 'reconcile');
}

function trackDir(projectRoot, id) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(id || ''))) throw new Error(`invalid track id: ${id}`);
  return path.join(tracksRoot(projectRoot), id);
}

function loadTrack(projectRoot, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(trackDir(projectRoot, id), 'track.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

/** Write via a temp file and rename, so a reader never sees half a track. */
function saveTrack(projectRoot, track) {
  const dir = trackDir(projectRoot, track.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'track.json');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...track, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function listTracks(projectRoot) {
  let names = [];
  try { names = fs.readdirSync(tracksRoot(projectRoot)); } catch (_) { return []; }
  return names
    .map((n) => { try { return loadTrack(projectRoot, n); } catch (_) { return null; } })
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** The highest number per id prefix in a list like ['DR-148', 'PRD-068']. */
function floorFromIds(ids) {
  const floor = {};
  for (const id of ids || []) {
    const m = String(id).match(/^([A-Z]{2,6})-(\d{1,5})$/);
    if (m) floor[m[1]] = Math.max(floor[m[1]] || 0, Number(m[2]));
  }
  return floor;
}

/**
 * The id floor for `prefix` across the project's open tracks: 0 when none is
 * open. Never throws: an unreadable track must not stop an item being filed.
 */
function idFloor(projectRoot, prefix) {
  let max = 0;
  try {
    for (const t of listTracks(projectRoot)) {
      if (t.status === OPEN && t.floor && Number(t.floor[prefix]) > max) max = Number(t.floor[prefix]);
    }
  } catch (_) { /* no floor */ }
  return max;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'source';
}

/** The record's body: what intake knows, plus the sections the interview fills. */
function recordBody(inv, { brief } = {}) {
  const src = inv.source.path ? `\`${inv.source.path}\`, branch \`${inv.source.branch || 'HEAD'}\`` : `\`${inv.source.ref}\``;
  const triggers = inv.risk.triggers.length
    ? inv.risk.triggers.map((t) => `  - ${t.label}: ${t.examples.map((e) => `\`${e}\``).join(', ')}${t.count > t.examples.length ? ', …' : ''}`).join('\n')
    : '  - none';
  const collisions = inv.ids.collisions.length
    ? `\n- **Collisions** (renumbered on the incoming side at integration): ${inv.ids.collisions.map((c) => c.id).join(', ')}.`
    : '';
  const large = inv.bulky.filter((b) => b.large).sort((a, b) => b.size - a.size).slice(0, 8)
    .map((b) => `\`${b.path}\` (${(b.size / 1048576).toFixed(1)} MB)`);
  return [
    'Reconcile record for work built outside Build Studio. The acceptance criteria below come from the owner\'s answers in the intent interview; the branch\'s own PRDs, UX specs and validation records are the builder\'s claims.',
    '',
    '## Source',
    '',
    `${src}, pinned on \`${inv.source.pin}\` at \`${inv.source.sha.slice(0, 10)}\` (${inv.source.commits} commit(s) since the merge-base); target \`${inv.target.ref}\` at \`${inv.target.sha.slice(0, 10)}\`; merge-base \`${inv.mergeBase.slice(0, 10)}\`.${brief ? ` Brief: \`${brief}\` (context, not truth).` : ''}`,
    '',
    '## Intake',
    '',
    `- Dry-run merge: ${inv.merge.clean ? 'clean' : `${inv.merge.conflicts.length} conflicting file(s)`}. Files changed: ${inv.files.length}.`,
    `- Suggested risk tier: **${inv.risk.tier[0].toUpperCase()}${inv.risk.tier.slice(1)}**. Triggers:`,
    triggers,
    `- Ids allocated by the source: ${inv.ids.added.length ? inv.ids.added.join(', ') : 'none'}.${collisions}`,
    `- Binaries and large files: ${inv.bulky.length}${large.length ? `; largest: ${large.join(', ')}` : ''}.`,
    '- The full intake report is kept with the track, outside the repository.',
    '',
    '## What comes home',
    '',
    '_Filled in by the intent interview. Paths that stay out go in the `reconcile-keep-out` block below, one per line; each ends up as it is on the target, or absent if the target lacks it._',
    '',
    '```reconcile-keep-out',
    '```',
    '',
    '## Change groups',
    '',
    '## Approved behaviour',
    '',
    '## Bulky files',
    '',
    '## Risk tier',
    '',
    '## Open questions',
    '',
  ].join('\n');
}

/** The commit a source names, without pinning it (to name the track). */
function sourceSha(projectRoot, { sourcePath, branch, ref }) {
  if (sourcePath) {
    return execFileSync('git', ['rev-parse', '--verify', `${branch ? `refs/heads/${branch}` : 'HEAD'}^{commit}`], { cwd: sourcePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }
  return execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * Start a track: run intake, and file the reconcile record above the floor.
 *
 * Returns { refused: true, inventory, markdown } for an uncommitted source,
 * otherwise { track, recordId, commit }. The record is filed on whatever branch
 * the main checkout has out, as every backlog filing is.
 *
 * deps (for tests): { commit(projectRoot, paths, message) → Promise<{committed}> }
 */
async function startTrack({ projectRoot, docsRel = 'docs', config = null, sourcePath = null, branch = null, ref = null, brief = null }, deps = {}) {
  const backlog = require('./backlog');
  projectRoot = path.resolve(projectRoot);
  if (!sourcePath && !ref) throw new Error('name the source: a path to a clone or worktree, or a ref in this repository');
  if (sourcePath) {
    sourcePath = path.resolve(sourcePath);
    if (!branch) {
      try { branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: sourcePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { branch = null; }
    }
    const status = intakeLib.sourceStatus(sourcePath);
    if (!status.clean) {
      const refused = { refused: true, source: { path: sourcePath, branch }, status };
      return { refused: true, inventory: refused, markdown: intakeLib.renderMarkdown(refused) };
    }
  }
  const sha = sourceSha(projectRoot, { sourcePath, branch, ref });
  const pinId = `${slug(branch || ref)}-${sha.slice(0, 8)}`;
  const inv = intakeLib.intake({ projectRoot, sourcePath, branch, ref, id: pinId, docsRel });

  // The track exists, with its floor, before the record is filed: the record
  // itself must take an id above the source's own.
  const now = new Date().toISOString();
  const steps = Object.fromEntries(STEPS.map((s) => [s, { status: 'pending' }]));
  steps.intake = { status: 'done', completedAt: now };
  let track = {
    id: pinId,
    status: OPEN,
    createdAt: now,
    source: inv.source,
    target: inv.target,
    mergeBase: inv.mergeBase,
    brief: brief || null,
    tier: inv.risk.tier,
    idsAdded: inv.ids.added,
    collisions: inv.ids.collisions.map((c) => c.id),
    floor: floorFromIds(inv.ids.added),
    currentStep: 'intent_interview',
    steps,
  };
  saveTrack(projectRoot, track);
  const stagingDir = trackDir(projectRoot, pinId);
  fs.writeFileSync(path.join(stagingDir, 'intake.json'), `${JSON.stringify(inv, null, 2)}\n`);
  fs.writeFileSync(path.join(stagingDir, 'intake.md'), `${intakeLib.renderMarkdown(inv)}\n`);

  let created;
  try {
    created = backlog.createItem(projectRoot, docsRel, {
      title: `Reconcile ${branch || ref}`,
      type: 'Task',
      body: recordBody(inv, { brief }),
      config,
      ...backlog.topOfBacklog(projectRoot, docsRel, 'Reconcile'),
    });
  } catch (err) {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    throw err;
  }

  // The track is named after its record from here on.
  const recordId = created.id;
  const finalDir = trackDir(projectRoot, recordId);
  fs.renameSync(stagingDir, finalDir);
  track = { ...track, id: recordId, pinId, record: path.join(docsRel, 'backlog', `${recordId}.md`) };
  saveTrack(projectRoot, track);

  let commit = null;
  if (fs.existsSync(path.join(projectRoot, '.git'))) {
    const doCommit = deps.commit || require('./scoped-commit').scopedCommit;
    const rel = (p) => path.relative(projectRoot, p);
    commit = await doCommit(projectRoot, [
      rel(backlog.itemFilePath(projectRoot, docsRel, recordId)),
      rel(backlog.backlogIndexPath(projectRoot, docsRel)),
    ], `docs(${recordId}): open the reconcile record for ${branch || ref}`);
  }
  return { refused: false, track, recordId, commit };
}

/**
 * File a backlog item on the track's integration branch (the owner's decisions,
 * the apply step). Its id clears the project's own ids and the floor, and the
 * floor is raised to it, so the project does not hand the same id out
 * meanwhile. Committed in the worktree.
 *
 * deps (for tests): { commit(cwd, paths, message) → Promise<{committed}> }
 */
async function fileItemOnBranch({ projectRoot, docsRel = 'docs', config = null, id, item }, deps = {}) {
  const backlog = require('./backlog');
  const track = loadTrack(projectRoot, id);
  if (!track) throw new Error(`no reconcile track ${id}`);
  if (track.status !== OPEN) throw new Error(`reconcile track ${id} is ${track.status}`);
  if (!track.worktree || !fs.existsSync(track.worktree)) throw new Error(`reconcile track ${id} has no worktree yet; run integration first`);
  const prefix = backlog.deriveItemPrefix(projectRoot, docsRel, config);
  const projectNext = Number(backlog.nextItemId(projectRoot, docsRel, prefix).split('-')[1]);
  const created = backlog.createItem(track.worktree, docsRel, { ...item, config, idFloor: projectNext - 1 });
  const num = Number(created.id.split('-')[1]);
  const fresh = loadTrack(projectRoot, id);
  saveTrack(projectRoot, { ...fresh, floor: { ...(fresh.floor || {}), [prefix]: Math.max(Number((fresh.floor || {})[prefix]) || 0, num) } });
  const doCommit = deps.commit || require('./scoped-commit').scopedCommit;
  const rel = (p) => path.relative(track.worktree, p);
  const commit = await doCommit(track.worktree, [
    rel(backlog.itemFilePath(track.worktree, docsRel, created.id)),
    rel(backlog.backlogIndexPath(track.worktree, docsRel)),
  ], `docs(${created.id}): add to the backlog (${id})`);
  return { ...created, commit };
}

/** Close a track without merging. Its floor is lifted; the pin stays. */
function cancelTrack(projectRoot, id, reason = null) {
  const track = loadTrack(projectRoot, id);
  if (!track) throw new Error(`no reconcile track ${id}`);
  const next = { ...track, status: 'cancelled', cancelledAt: new Date().toISOString(), cancelReason: reason };
  saveTrack(projectRoot, next);
  return next;
}

module.exports = {
  STEPS, OPEN,
  tracksRoot, trackDir, loadTrack, saveTrack, listTracks,
  floorFromIds, idFloor, recordBody, startTrack, fileItemOnBranch, cancelTrack,
};
