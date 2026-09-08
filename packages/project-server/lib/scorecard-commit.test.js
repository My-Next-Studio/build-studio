'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { commitScorecard } = require('./scorecard-commit');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd }).toString();
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-commit-test-'));
  git(dir, 'init');
  git(dir, 'config', 'user.email', 'test@test.local');
  git(dir, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-m', 'seed');
  return dir;
}

/** A project with a scorecard row already appended, as a finished run leaves it. */
function seedScorecard(dir) {
  const statePath = path.join(dir, '.build-studio');
  fs.mkdirSync(statePath, { recursive: true });
  fs.writeFileSync(path.join(statePath, 'scorecard.jsonl'),
    '{"wfId":"w1","role":"QA","step":"qa_validation"}\n');
  return statePath;
}

function cleanRepo(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

test('commits the scorecard and names the workflow type in the message', async () => {
  const dir = makeRepo();
  const statePath = seedScorecard(dir);
  const r = await commitScorecard(dir, statePath, {}, { type: 'bugfix' });
  assert.equal(r.committed, true);
  assert.match(git(dir, 'log', '-1', '--pretty=%s'), /^chore\(scorecard\): record bugfix run$/m);
  assert.equal(git(dir, 'status', '--porcelain').trim(), '');
  cleanRepo(dir);
});

test('falls back to a generic label when the workflow has no type', async () => {
  const dir = makeRepo();
  const statePath = seedScorecard(dir);
  await commitScorecard(dir, statePath, {}, {});
  assert.match(git(dir, 'log', '-1', '--pretty=%s'), /record workflow run/);
  cleanRepo(dir);
});

// The reason this uses a pathspec-scoped commit at all: agents may hold the
// working tree when a run completes. A commit that swept their staged work
// would be far worse than the manual step this replaces.
test('leaves a concurrently staged file staged and uncommitted', async () => {
  const dir = makeRepo();
  const statePath = seedScorecard(dir);
  fs.writeFileSync(path.join(dir, 'agent-work.txt'), 'in progress\n');
  git(dir, 'add', 'agent-work.txt');

  const r = await commitScorecard(dir, statePath, {}, { type: 'bugfix' });
  assert.equal(r.committed, true);

  // The agent's file is still staged, and NOT in the commit we just made.
  assert.match(git(dir, 'status', '--porcelain'), /^A  agent-work\.txt$/m);
  const files = git(dir, 'show', '--name-only', '--pretty=', 'HEAD');
  assert.match(files, /\.build-studio\/scorecard\.jsonl/);
  assert.doesNotMatch(files, /agent-work\.txt/);
  cleanRepo(dir);
});

test('respects scorecard.auto_commit: false', async () => {
  const dir = makeRepo();
  const statePath = seedScorecard(dir);
  const r = await commitScorecard(dir, statePath, { scorecard: { auto_commit: false } }, {});
  assert.equal(r.committed, false);
  assert.match(r.reason, /disabled/);
  assert.match(git(dir, 'status', '--porcelain'), /\.build-studio/);
  cleanRepo(dir);
});

test('skips a project that is not a git repository', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-nogit-'));
  const statePath = seedScorecard(dir);
  const r = await commitScorecard(dir, statePath, {}, {});
  assert.equal(r.committed, false);
  assert.match(r.reason, /not a git repository/);
  cleanRepo(dir);
});

// statePath is configurable, so it can be pointed outside the project. git
// would reject a pathspec that escapes the work tree; refuse before shelling out.
test('refuses a state path outside the repo', async () => {
  const dir = makeRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'scorecard-outside-'));
  let called = false;
  const r = await commitScorecard(dir, outside, {}, {}, {
    commit: async () => { called = true; return { committed: true, sha: 'x', reason: 'committed' }; },
  });
  assert.equal(r.committed, false);
  assert.match(r.reason, /outside the repo/);
  assert.equal(called, false, 'must not shell out to git');
  cleanRepo(dir); cleanRepo(outside);
});

// The failure contract the caller depends on: a refused commit is reported,
// never thrown, so a workflow's completion path cannot be broken by git.
test('reports a git failure instead of throwing', async () => {
  const dir = makeRepo();
  const statePath = seedScorecard(dir);
  const r = await commitScorecard(dir, statePath, {}, {}, {
    commit: async () => ({ committed: false, sha: null, reason: 'repo busy (merge/rebase in progress)' }),
  });
  assert.equal(r.committed, false);
  assert.match(r.reason, /repo busy/);
  cleanRepo(dir);
});
