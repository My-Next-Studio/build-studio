'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { scopedCommit, repoBusy } = require('./scoped-commit');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd }).toString();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-commit-test-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@test.local');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'seed');
  return dir;
}

function cleanRepo(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

test('commits exactly the scoped paths and returns a sha', async () => {
  const dir = makeRepo();
  fs.mkdirSync(path.join(dir, 'docs/backlog'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs/backlog/XX-001.md'), 'bug\n');
  fs.writeFileSync(path.join(dir, 'docs/state.md'), 'state\n');
  const r = await scopedCommit(dir, ['docs/backlog/XX-001.md', 'docs/state.md'], 'chore(support): file XX-001');
  assert.equal(r.committed, true);
  assert.ok(r.sha);
  const show = git(dir, 'show', '--stat', '--name-only', 'HEAD');
  assert.match(show, /docs\/backlog\/XX-001\.md/);
  assert.match(show, /docs\/state\.md/);
  cleanRepo(dir);
});

test('does not sweep concurrently staged unrelated work', async () => {
  const dir = makeRepo();
  // An "agent" has staged unrelated work mid-flight.
  fs.writeFileSync(path.join(dir, 'agent-work.txt'), 'wip\n');
  git(dir, 'add', 'agent-work.txt');
  fs.writeFileSync(path.join(dir, 'bug.md'), 'bug\n');
  const r = await scopedCommit(dir, ['bug.md'], 'chore(support): file bug');
  assert.equal(r.committed, true);
  const committed = git(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n');
  assert.deepEqual(committed, ['bug.md']); // agent-work.txt NOT in the commit
  const status = git(dir, 'status', '--porcelain');
  assert.match(status, /^A {2}agent-work\.txt$/m); // still staged, untouched
  cleanRepo(dir);
});

test('concurrent actor already committed the paths → success without a new commit', async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, 'bug.md'), 'bug\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'agent sweep'); // the sweep-all case
  const before = git(dir, 'rev-parse', 'HEAD').trim();
  const r = await scopedCommit(dir, ['bug.md'], 'chore(support): file bug');
  assert.equal(r.committed, true);
  assert.equal(r.sha, null);
  assert.match(r.reason, /concurrent/);
  assert.equal(git(dir, 'rev-parse', 'HEAD').trim(), before); // no extra commit
  cleanRepo(dir);
});

test('merge in progress → retries then surrenders with reason; files stay in tree', async () => {
  const dir = makeRepo();
  fs.writeFileSync(path.join(dir, '.git/MERGE_HEAD'), 'deadbeef\n'); // simulate mid-merge
  assert.equal(repoBusy(dir), true);
  fs.writeFileSync(path.join(dir, 'bug.md'), 'bug\n');
  const r = await scopedCommit(dir, ['bug.md'], 'msg', { attempts: 2, delayMs: 20 });
  assert.equal(r.committed, false);
  assert.match(r.reason, /busy/);
  assert.equal(fs.readFileSync(path.join(dir, 'bug.md'), 'utf8'), 'bug\n');
  cleanRepo(dir);
});

test('not a git repo → clean failure, never throws', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-commit-nogit-'));
  fs.writeFileSync(path.join(dir, 'bug.md'), 'bug\n');
  const r = await scopedCommit(dir, ['bug.md'], 'msg', { attempts: 1 });
  assert.equal(r.committed, false);
  cleanRepo(dir);
});
