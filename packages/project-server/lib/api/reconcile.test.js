'use strict';

// The reconcile tracks API: start (intake + record), list, get, cancel.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { execFileSync } = require('child_process');
const backlog = require('../backlog');
const { createReconcileRouter } = require('./reconcile');

function write(root, rel, body) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

async function withServer(projectRoot, fn) {
  const app = express();
  app.use(express.json());
  app.use('/api', createReconcileRouter({ projectRoot, docs_path: './docs' }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json() };
  };
  try { await fn(call); } finally { server.close(); }
}

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-api-'));
  const project = path.join(dir, 'project');
  fs.mkdirSync(project);
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' });
  g(project, 'init', '-q', '-b', 'main');
  g(project, 'config', 'user.email', 't@example.com');
  g(project, 'config', 'user.name', 't');
  write(project, '.gitignore', 'tmp/\n');
  write(project, 'docs/backlog-index.md', `# Backlog\n\n${backlog.BACKLOG_START}\n\n### Now\n\n${backlog.BACKLOG_END}\n`);
  write(project, 'app/a.txt', 'a\n');
  g(project, 'add', '-A');
  g(project, 'commit', '-q', '-m', 'init');
  g(project, 'checkout', '-q', '-b', 'design/x');
  write(project, 'app/a.txt', 'b\n');
  g(project, 'commit', '-q', '-am', 'x');
  g(project, 'checkout', '-q', 'main');
  return { dir, project };
}

test('start from a ref, then list, get and cancel', async () => {
  const { dir, project } = setup();
  try {
    await withServer(project, async (call) => {
      const bad = await call('POST', '/reconcile/start', {});
      assert.equal(bad.status, 400);
      const both = await call('POST', '/reconcile/start', { sourcePath: dir, ref: 'design/x' });
      assert.equal(both.status, 400);

      const started = await call('POST', '/reconcile/start', { ref: 'design/x' });
      assert.equal(started.status, 201);
      const id = started.body.recordId;
      assert.match(id, /^[A-Z]{2,5}-\d{3}$/);

      const list = await call('GET', '/reconcile');
      assert.deepEqual(list.body.tracks.map((t) => t.id), [id]);

      const one = await call('GET', `/reconcile/${id}`);
      assert.equal(one.status, 200);
      assert.match(one.body.intake, /Reconcile intake/);

      const missing = await call('GET', '/reconcile/NOPE-1');
      assert.equal(missing.status, 404);

      const cancelled = await call('POST', `/reconcile/${id}/cancel`, { reason: 'test' });
      assert.equal(cancelled.body.track.status, 'cancelled');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a dirty source gets 409 with the list of files', async () => {
  const { dir, project } = setup();
  try {
    const clone = path.join(dir, 'clone');
    execFileSync('git', ['clone', '-q', project, clone]);
    write(clone, 'scratch.txt', 'x\n');
    await withServer(project, async (call) => {
      const r = await call('POST', '/reconcile/start', { sourcePath: clone });
      assert.equal(r.status, 409);
      assert.equal(r.body.refused, true);
      assert.deepEqual(r.body.status.untracked.map((f) => f.path), ['scratch.txt']);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
