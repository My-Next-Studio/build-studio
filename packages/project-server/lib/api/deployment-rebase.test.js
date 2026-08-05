const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createDeploymentRouter } = require('./deployment');

// Real git repositories, not mocks. Rebase semantics — what --autostash does on
// abort, whether a conflicted reapply still exits zero, what a half-finished
// rebase leaves on disk — are the whole subject here, and a stubbed git would
// only ever confirm what I already believed.

let tmp, remote, local, server, baseUrl;

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

function commit(cwd, file, content, message) {
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, ['add', file]);
  git(cwd, ['commit', '-m', message]);
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-rebase-'));
  remote = path.join(tmp, 'remote.git');
  local = path.join(tmp, 'local');

  // A bare origin with one commit on main, then a clone.
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['config', 'user.email', 'test@example.com']);
  git(seed, ['config', 'user.name', 'Test']);
  commit(seed, 'README.md', 'base\n', 'base');
  git(tmp, ['clone', '-q', '--bare', seed, remote]);
  git(tmp, ['clone', '-q', remote, local]);
  git(local, ['config', 'user.email', 'test@example.com']);
  git(local, ['config', 'user.name', 'Test']);

  const config = { projectRoot: local, deployment: { versioning: 'none' }, name: 'rebase-test' };
  const gitOps = { getStatus: () => ({ stagedFiles: [], unstagedFiles: [], untrackedFiles: [] }) };
  // A monitor stub: these tests never touch GitHub, and the real one would shell
  // out to `gh` on construction paths we do not care about here.
  const monitor = { getCi: () => ({ value: null, error: null }), prime: () => {} };

  const app = express();
  app.use(express.json());
  app.use('/api', createDeploymentRouter(config, gitOps, { monitor }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const rebase = () => fetch(`${baseUrl}/api/deployment/rebase`, { method: 'POST' });
const deployment = () => fetch(`${baseUrl}/api/deployment`).then((r) => r.json());

/** Advance origin/main by committing in a second clone and pushing. */
function advanceRemote(file, content, message) {
  const other = path.join(tmp, `other-${Math.abs(file.length * 7 + message.length)}`);
  git(tmp, ['clone', '-q', remote, other]);
  git(other, ['config', 'user.email', 'other@example.com']);
  git(other, ['config', 'user.name', 'Other']);
  commit(other, file, content, message);
  git(other, ['push', '-q', 'origin', 'main']);
}

test('replays a local commit on top of a remote that moved', async () => {
  commit(local, 'mine.md', 'mine\n', 'my local work');
  advanceRemote('theirs.md', 'theirs\n', 'their work');

  const res = await rebase();
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.replayed, 1);

  // My commit now sits ON TOP of theirs, and both files exist.
  assert.ok(fs.existsSync(path.join(local, 'theirs.md')));
  assert.strictEqual(git(local, ['log', '-1', '--format=%s']), 'my local work');
  assert.strictEqual(git(local, ['rev-list', '--count', 'HEAD..origin/main']), '0');
});

test('fetches before deciding — a remote change made after the last fetch still counts', async () => {
  // No fetch has run since the clone, so the cached ref says up-to-date. The
  // route must not believe it. This is the exact real-world case: a Dependabot
  // PR merged on github.com seconds ago.
  commit(local, 'mine.md', 'mine\n', 'my local work');
  advanceRemote('theirs.md', 'theirs\n', 'their work');
  assert.strictEqual(git(local, ['rev-list', '--count', 'HEAD..origin/main']), '0',
    'precondition: the stale ref claims there is nothing to get');

  const body = await (await rebase()).json();
  assert.strictEqual(body.ok, true);
  assert.strictEqual(body.replayed, 1);
});

test('reports already-up-to-date as success, not failure', async () => {
  const res = await rebase();
  const body = await res.json();
  assert.strictEqual(res.status, 200);
  assert.strictEqual(body.alreadyUpToDate, true);
});

test('carries uncommitted work across the rebase', async () => {
  commit(local, 'mine.md', 'mine\n', 'my local work');
  advanceRemote('theirs.md', 'theirs\n', 'their work');
  fs.writeFileSync(path.join(local, 'wip.md'), 'work in progress\n');
  git(local, ['add', 'wip.md']);

  const body = await (await rebase()).json();
  assert.strictEqual(body.ok, true);
  // The staged file survived, and did not become a commit.
  assert.strictEqual(fs.readFileSync(path.join(local, 'wip.md'), 'utf8'), 'work in progress\n');
  assert.strictEqual(git(local, ['log', '-1', '--format=%s']), 'my local work');
});

test('a conflict aborts and leaves the repo exactly as it was', async () => {
  commit(local, 'shared.md', 'my version\n', 'my edit');
  advanceRemote('shared.md', 'their version\n', 'their edit');
  const before = git(local, ['rev-parse', 'HEAD']);

  const res = await rebase();
  const body = await res.json();
  assert.strictEqual(res.status, 409);
  assert.strictEqual(body.aborted, true);
  assert.deepStrictEqual(body.conflicts, ['shared.md']);

  // The defining property: nothing moved, and no rebase is left in progress.
  assert.strictEqual(git(local, ['rev-parse', 'HEAD']), before);
  assert.strictEqual(fs.readFileSync(path.join(local, 'shared.md'), 'utf8'), 'my version\n');
  const gitDir = path.join(local, '.git');
  assert.strictEqual(fs.existsSync(path.join(gitDir, 'rebase-merge')), false);
  assert.strictEqual(fs.existsSync(path.join(gitDir, 'rebase-apply')), false);
});

test('refuses to touch a rebase someone else started', async () => {
  // Manufacture a genuine half-finished rebase, the state a terminal session
  // would be in mid-resolution. Aborting it here would destroy that work.
  commit(local, 'shared.md', 'my version\n', 'my edit');
  advanceRemote('shared.md', 'their version\n', 'their edit');
  git(local, ['fetch', '-q', 'origin']);
  try { git(local, ['rebase', 'origin/main']); } catch { /* expected: conflicts */ }
  assert.ok(fs.existsSync(path.join(local, '.git', 'rebase-merge')), 'precondition: rebase in progress');

  const res = await rebase();
  assert.strictEqual(res.status, 409);
  assert.match((await res.json()).error, /already in progress/i);
  // Still there — we did not abort it.
  assert.ok(fs.existsSync(path.join(local, '.git', 'rebase-merge')));

  git(local, ['rebase', '--abort']);
});

test('an interrupted rebase is reported, not papered over as success', async () => {
  // A project-server killed mid-rebase (a deploy, a crash) leaves .git/rebase-merge
  // behind with a clean tree and no conflict files — this actually happened during
  // a deploy. Simulated here by parking the repo in that state directly, because
  // the state, not how it got there, is what the route has to notice.
  commit(local, 'mine.md', 'mine\n', 'my local work');
  advanceRemote('theirs.md', 'theirs\n', 'their work');
  const res = await rebase();
  const body = await res.json();
  assert.strictEqual(body.ok, true, 'precondition: a clean rebase normally succeeds');

  // Now park it and confirm the guard fires rather than the success path.
  fs.mkdirSync(path.join(local, '.git', 'rebase-merge'), { recursive: true });
  const parked = await rebase();
  const parkedBody = await parked.json();
  assert.strictEqual(parked.status, 409);
  assert.strictEqual(parkedBody.rebaseInProgress, true);
  assert.match(parkedBody.error, /git rebase --abort/);

  fs.rmSync(path.join(local, '.git', 'rebase-merge'), { recursive: true, force: true });
});

test('a detached HEAD is named, not turned into "invalid refspec"', async () => {
  // Reported from a real project: `git branch --show-current` is empty when
  // detached, so `git push origin ''` reached git and came back with a refspec
  // error that named neither the cause nor the fix.
  commit(local, 'mine.md', 'mine\n', 'my local work');
  git(local, ['checkout', '-q', '--detach', 'HEAD']);

  const push = await fetch(`${baseUrl}/api/deployment/push`, { method: 'POST' });
  const pushBody = await push.json();
  assert.strictEqual(push.status, 400);
  assert.strictEqual(pushBody.detachedHead, true);
  assert.match(pushBody.error, /detached/i);
  assert.doesNotMatch(pushBody.error, /refspec/i);
  assert.match(pushBody.error, /git branch/, 'tells you how to save a detached commit');

  const rb = await rebase();
  assert.strictEqual(rb.status, 400);
  assert.match((await rb.json()).error, /detached/i);

  const info = await deployment();
  assert.strictEqual(info.detachedHead, true);
  assert.strictEqual(info.branch, null);
  assert.strictEqual(info.canRebase, false, 'neither action is offered without a branch');
});

test('GET /deployment reports canRebase and the ref it would use', async () => {
  advanceRemote('theirs.md', 'theirs\n', 'their work');
  // First call schedules the background fetch and may still see stale refs...
  await deployment();
  // ...so wait for the fetch to land, then read again.
  await new Promise((r) => setTimeout(r, 1500));
  const info = await deployment();
  assert.strictEqual(info.behind, 1);
  assert.strictEqual(info.canRebase, true);
  assert.strictEqual(info.compareRef, 'origin/main');
  assert.ok(info.remoteFetchedAt, 'freshness is reported so the UI need not guess');
});

test('canRebase is false when nothing is upstream', async () => {
  await deployment();
  await new Promise((r) => setTimeout(r, 1500));
  const info = await deployment();
  assert.strictEqual(info.behind, 0);
  assert.strictEqual(info.canRebase, false);
});
