'use strict';

// Tests for the cli-config API:
//  - PUT /api/config/cli: default_effort / developer_effort / reviewer_effort
//    validation (shell-safety — the value lands on the opencode command line)
// The models.dev parsing this file used to cover now lives in — and is tested
// with — @build-studio/shared/opencode-catalog, which owns the catalog cache.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { createCliConfigRouter } = require('./cli-config');

// ─── PUT validation ──

function makeApp() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-config-test-'));
  fs.mkdirSync(path.join(projectRoot, '.build-studio'), { recursive: true });
  // reloadConfig (part of the PUT path) requires a config.yaml — a minimal one suffices
  fs.writeFileSync(path.join(projectRoot, '.build-studio', 'config.yaml'), 'name: test\nport: 3999\ndocs_path: ./docs\n');
  const config = { projectRoot, cli: { default: 'opencode' } };
  const app = express();
  app.use(express.json());
  app.use('/api', createCliConfigRouter(config));
  return { app, projectRoot, config };
}

async function put(app, body) {
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config/cli`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  } finally {
    server.close();
  }
}

test('PUT accepts effort tokens and persists them to local.json', async () => {
  const { app, projectRoot } = makeApp();
  const r = await put(app, { default_effort: 'high', developer_effort: 'max', reviewer_effort: null });
  assert.equal(r.status, 200);
  const local = JSON.parse(fs.readFileSync(path.join(projectRoot, '.build-studio', 'local.json'), 'utf8'));
  assert.equal(local.cli.default_effort, 'high');
  assert.equal(local.cli.developer_effort, 'max');
  assert.equal(local.cli.reviewer_effort, null);
});

test('PUT rejects shell-unsafe effort values (would land on the command line)', async () => {
  const { app, projectRoot } = makeApp();
  for (const bad of ['high; rm -rf ~', '$(whoami)', 'high max', '`id`', 'a'.repeat(64)]) {
    const r = await put(app, { developer_effort: bad });
    assert.equal(r.status, 400, bad);
    assert.match(r.body.error, /developer_effort/);
  }
  assert.equal(fs.existsSync(path.join(projectRoot, '.build-studio', 'local.json')), false);
});

test('PUT accepts developer_cli / reviewer_cli slots, rejects invalid CLIs', async () => {
  const { app, projectRoot } = makeApp();
  const r = await put(app, { developer_cli: 'opencode', reviewer_cli: 'claude' });
  assert.equal(r.status, 200);
  const local = JSON.parse(fs.readFileSync(path.join(projectRoot, '.build-studio', 'local.json'), 'utf8'));
  assert.equal(local.cli.developer_cli, 'opencode');
  assert.equal(local.cli.reviewer_cli, 'claude');

  const bad = await put(app, { reviewer_cli: 'chatgpt' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /reviewer_cli/);
  // null clears the slot (falls back to default at resolution)
  const cleared = await put(app, { developer_cli: null });
  assert.equal(cleared.status, 200);
  const local2 = JSON.parse(fs.readFileSync(path.join(projectRoot, '.build-studio', 'local.json'), 'utf8'));
  assert.equal(local2.cli.developer_cli, null);
});

test('PUT still rejects a body with no recognized keys', async () => {
  const { app } = makeApp();
  const r = await put(app, { unrelated: true });
  assert.equal(r.status, 400);
});

test('PUT use_global persists the toggle; non-boolean rejected; GET exposes flag + global block shape', async () => {
  const { app, projectRoot } = makeApp();
  const bad = await put(app, { use_global: 'yes' });
  assert.equal(bad.status, 400);

  const r = await put(app, { use_global: true });
  assert.equal(r.status, 200);
  const local = JSON.parse(fs.readFileSync(path.join(projectRoot, '.build-studio', 'local.json'), 'utf8'));
  assert.equal(local.cli.use_global, true);
  // Response mirrors GET: the flag plus the (possibly absent) global block.
  assert.equal(typeof r.body.use_global, 'boolean');
  assert.ok('global_cli' in r.body);

  const server = http.createServer(app);
  await new Promise(rr => server.listen(0, rr));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/config/cli`);
    const get = await res.json();
    assert.equal(typeof get.use_global, 'boolean');
    assert.ok('global_cli' in get);
    assert.ok(get.sources);
  } finally {
    server.close();
  }
});
