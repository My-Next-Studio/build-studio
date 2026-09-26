const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createDeploymentRouter, ciFixMessage } = require('./deployment');

// Real repositories: what a PR against origin carries is decided by which
// commits sit between origin/main and the branch tip, and only git knows that.
//
// launch-studio PR #19 (2026-09-21): a "CI fix" PR opened from a local main 23
// commits ahead of origin carried all 23, and the fix never reached local main.

let tmp, remote, local, server, baseUrl, prCalls;

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

function commit(cwd, file, content, message) {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true });
  fs.writeFileSync(path.join(cwd, file), content);
  git(cwd, ['add', file]);
  git(cwd, ['commit', '-q', '-m', message]);
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-cifix-'));
  remote = path.join(tmp, 'remote.git');
  local = path.join(tmp, 'local');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  git(seed, ['init', '-q', '-b', 'main']);
  git(seed, ['config', 'user.email', 't@example.com']);
  git(seed, ['config', 'user.name', 'T']);
  commit(seed, 'src/db.ts', 'import x from "node:sqlite";\n', 'base');
  commit(seed, 'src/feature.ts', 'v1\n', 'feature v1');
  git(tmp, ['clone', '-q', '--bare', seed, remote]);
  git(tmp, ['clone', '-q', remote, local]);
  git(local, ['config', 'user.email', 't@example.com']);
  git(local, ['config', 'user.name', 'T']);
  // Unpushed local work — the in-flight feature the old flow swept into the PR.
  commit(local, 'src/feature.ts', 'v2 in flight\n', 'feat: in-flight work');

  prCalls = [];
  const config = {
    projectRoot: local, name: 'cifix-test',
    deployment: { versioning: 'none', repo: 'o/r', ci_fix_strategy: 'pr' },
  };
  const gitOps = { getStatus: () => ({ stagedFiles: [], unstagedFiles: [], untrackedFiles: [] }) };
  const monitor = { getCi: () => ({ value: null, error: null }), prime: () => {} };
  const app = express();
  app.use(express.json());
  app.use('/api', createDeploymentRouter(config, gitOps, {
    monitor, createPrFn: (a) => { prCalls.push(a); return 'https://example.test/pr/1'; },
  }));
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const accept = (summary) => fetch(`${baseUrl}/api/deployment/ci-fix-accept`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ summary }),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test('the PR branch carries the fix and none of the unpushed local commits', async () => {
  fs.writeFileSync(path.join(local, 'src/db.ts'), 'const x = lazy("node:sqlite");\n');
  fs.writeFileSync(path.join(local, 'src/new-helper.ts'), 'export {};\n');
  const r = await accept('Made node:sqlite lazy. Vite no longer bundles it.');
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.mode, 'pr');

  const onRemote = git(remote, ['log', '--format=%s', `main..${r.body.branch}`]).split('\n');
  assert.deepStrictEqual(onRemote, ['fix(ci): Made node:sqlite lazy']);
  const files = git(remote, ['diff', '--name-only', `main...${r.body.branch}`]).split('\n').sort();
  assert.deepStrictEqual(files, ['src/db.ts', 'src/new-helper.ts']);

  assert.strictEqual(prCalls.length, 1);
  assert.strictEqual(prCalls[0].base, 'main');
  assert.strictEqual(prCalls[0].title, 'fix(ci): Made node:sqlite lazy');
  assert.match(prCalls[0].body, /Vite no longer bundles it/);
});

test('the fix is also committed on the local branch, and scaffolding is cleaned up', async () => {
  fs.writeFileSync(path.join(local, 'src/db.ts'), 'const x = lazy("node:sqlite");\n');
  const r = await accept('Made node:sqlite lazy.');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(git(local, ['branch', '--show-current']), 'main');
  assert.strictEqual(git(local, ['status', '--porcelain']), '');
  assert.strictEqual(git(local, ['log', '-1', '--format=%s']), 'fix(ci): Made node:sqlite lazy');
  assert.strictEqual(git(local, ['log', '-2', '--format=%s']).split('\n')[1], 'feat: in-flight work');
  assert.strictEqual(git(local, ['worktree', 'list']).split('\n').length, 1);
  assert.strictEqual(git(local, ['branch', '--list', 'ci-fix-*']), '');
});

test('a fix that only applies on top of unpushed commits is refused, working tree untouched', async () => {
  // Edits a line that exists only in the unpushed commit.
  fs.writeFileSync(path.join(local, 'src/feature.ts'), 'v2 in flight, fixed\n');
  const r = await accept('Fix the feature.');
  assert.strictEqual(r.status, 409);
  assert.match(r.body.error, /1 commit\(s\) on main that are not pushed/);
  assert.strictEqual(prCalls.length, 0);
  assert.strictEqual(git(remote, ['branch', '--list', 'ci-fix-*']), '');
  assert.strictEqual(git(local, ['status', '--porcelain']), 'M src/feature.ts');
  assert.strictEqual(git(local, ['log', '-1', '--format=%s']), 'feat: in-flight work');
  assert.strictEqual(git(local, ['worktree', 'list']).split('\n').length, 1);
});

test('ciFixMessage keeps a paragraph out of the title', () => {
  const long = 'Made the node:sqlite dependency in src/main/data/db.ts lazy: replaced the static top-level import with a runtime require. Vite no longer sees it.';
  const m = ciFixMessage(long);
  assert.ok(m.title.length <= 72, m.title);
  assert.match(m.title, /^fix\(ci\): Made the node:sqlite dependency/);
  assert.strictEqual(m.body, long);
  assert.deepStrictEqual(ciFixMessage(''), { title: 'fix(ci): repair failing pipeline', body: '' });
  assert.deepStrictEqual(ciFixMessage('Pin node'), { title: 'fix(ci): Pin node', body: '' });
});

test('after the PR is squash-merged, rebasing local main drops the local copy without conflict', async () => {
  fs.writeFileSync(path.join(local, 'src/db.ts'), 'const x = lazy("node:sqlite");\n');
  const r = await accept('Made node:sqlite lazy.');
  assert.strictEqual(r.status, 200);

  // GitHub's squash merge, done in a separate clone.
  const gh = path.join(tmp, 'gh');
  git(tmp, ['clone', '-q', remote, gh]);
  git(gh, ['config', 'user.email', 'gh@example.com']);
  git(gh, ['config', 'user.name', 'GitHub']);
  git(gh, ['merge', '-q', '--squash', `origin/${r.body.branch}`]);
  git(gh, ['commit', '-q', '-m', 'fix(ci): Made node:sqlite lazy (#1)']);
  git(gh, ['push', '-q', 'origin', 'main']);

  git(local, ['fetch', '-q', 'origin']);
  git(local, ['rebase', 'origin/main']); // throws on conflict
  const mine = git(local, ['log', '--format=%s', 'origin/main..main']).split('\n');
  assert.deepStrictEqual(mine, ['feat: in-flight work']);
});
