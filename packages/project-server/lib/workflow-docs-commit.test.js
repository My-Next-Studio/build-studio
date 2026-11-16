'use strict';

// commitDocsSync: the workflow's backlog status commit survives another git
// process holding the index lock. Without the retry, a review's "mark
// Reviewed" commit lost the race to the scorecard commit started just before
// it, and the status stayed uncommitted (phoclub PHO-050, 2026-11-16).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');

const { commitDocsSync } = require('./workflow-docs-commit');

const quiet = { log() {}, warn() {} };

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-commit-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.mkdirSync(path.join(root, 'docs/backlog'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs/backlog/X-1.md'), 'status: Drafted\n');
  fs.writeFileSync(path.join(root, 'docs/draft.md'), 'owner draft\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { root, git, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('commits the status files and leaves other docs alone', () => {
  const r = repo();
  try {
    fs.writeFileSync(path.join(r.root, 'docs/backlog/X-1.md'), 'status: Reviewed\n');
    fs.writeFileSync(path.join(r.root, 'docs/draft.md'), 'owner draft, edited\n');
    const res = commitDocsSync(r.root, ['docs/project-state.md', 'docs/backlog'], 'docs(X-1): mark Reviewed', { log: quiet });
    assert.equal(res.committed, true);
    assert.equal(r.git('log', '-1', '--format=%s'), 'docs(X-1): mark Reviewed');
    assert.equal(r.git('status', '--porcelain'), 'M docs/draft.md');
  } finally {
    r.clean();
  }
});

test('waits for another process to release the index lock, then commits', async () => {
  const r = repo();
  try {
    fs.writeFileSync(path.join(r.root, 'docs/backlog/X-1.md'), 'status: Reviewed\n');
    const lock = path.join(r.root, '.git/index.lock');
    fs.writeFileSync(lock, '');
    // Another process, as the scorecard commit is: it lets go after ~0.4 s,
    // which a synchronous retry loop in this process cannot do for it.
    const releaser = spawn('sh', ['-c', `sleep 0.4; rm -f "${lock}"`], { stdio: 'ignore' });
    const res = commitDocsSync(r.root, ['docs/backlog'], 'docs(X-1): mark Reviewed', { log: quiet, attempts: 12, delayMs: 100 });
    await new Promise((resolve) => releaser.on('exit', resolve));
    assert.equal(res.committed, true, res.reason);
    assert.equal(r.git('status', '--porcelain'), '');
  } finally {
    r.clean();
  }
});

test('gives up with the git error when the lock is never released', () => {
  const r = repo();
  try {
    fs.writeFileSync(path.join(r.root, 'docs/backlog/X-1.md'), 'status: Reviewed\n');
    fs.writeFileSync(path.join(r.root, '.git/index.lock'), '');
    const res = commitDocsSync(r.root, ['docs/backlog'], 'docs(X-1): mark Reviewed', { log: quiet, attempts: 3, delayMs: 10 });
    assert.equal(res.committed, false);
    assert.match(res.reason, /index\.lock/);
  } finally {
    r.clean();
  }
});

test('nothing to commit is not an error and does not retry', () => {
  const r = repo();
  try {
    const t0 = Date.now();
    const res = commitDocsSync(r.root, ['docs/backlog'], 'noop', { log: quiet, attempts: 5, delayMs: 200 });
    assert.equal(res.committed, false);
    assert.equal(res.reason, 'nothing to commit');
    assert.ok(Date.now() - t0 < 200, 'waited although nothing was locked');
  } finally {
    r.clean();
  }
});
