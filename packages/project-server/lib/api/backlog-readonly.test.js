'use strict';

// GET /api/backlog?readonly=true writes nothing: no automatic transition, no
// index refresh. A monitor (the work queue's overview, a remote assistant)
// reads with it. A normal read still does both.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createBacklogRouter } = require('./backlog');

const INDEX = `# Backlog index

<!-- BACKLOG-START -->

### Phase 1

- EX-001 — One  [Feature · Reviewed]
- EX-002 — Two  [Feature · Backlog]

<!-- BACKLOG-END -->
`;

function makeProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-readonly-')));
  const dir = path.join(root, 'docs', 'backlog');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'prds'), { recursive: true });
  // EX-001's file has moved on from what the index says: a normal read refreshes the index line.
  fs.writeFileSync(path.join(dir, 'EX-001.md'), '---\nid: EX-001\ntitle: One\ntype: Feature\nstatus: Implemented\n---\n\nBody.\n');
  // EX-002 is in Backlog with its PRD on disk: a normal read moves it to Drafted.
  fs.writeFileSync(path.join(root, 'docs', 'prds', 'PRD-002-two.md'), '# PRD-002\n');
  fs.writeFileSync(path.join(dir, 'EX-002.md'), '---\nid: EX-002\ntitle: Two\ntype: Feature\nstatus: Backlog\nprd: docs/prds/PRD-002-two.md\n---\n\nBody.\n');
  fs.writeFileSync(path.join(root, 'docs', 'backlog-index.md'), INDEX);
  return root;
}

function snapshot(root) {
  const files = ['docs/backlog-index.md', 'docs/backlog/EX-001.md', 'docs/backlog/EX-002.md'];
  return Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')]));
}

async function withServer(root, run) {
  const app = express();
  app.use('/api', createBacklogRouter({ projectRoot: root, docs_path: 'docs', name: 'example' }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('a read-only read changes no file, and reports statuses as the item files have them', async () => {
  const root = makeProject();
  const before = snapshot(root);
  await withServer(root, async (base) => {
    for (const query of ['?readonly=true', '?readonly=true&fields=status']) {
      const res = await fetch(`${base}/api/backlog${query}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.items['EX-002'].status, 'Backlog', query);
      assert.equal(body.items['EX-001'].status, 'Implemented', query);
    }
    assert.deepEqual(snapshot(root), before);
  });
});

test('a normal read still applies the transition and refreshes the index', async () => {
  const root = makeProject();
  await withServer(root, async (base) => {
    const body = await (await fetch(`${base}/api/backlog`)).json();
    assert.equal(body.items['EX-002'].status, 'Drafted');
    assert.match(fs.readFileSync(path.join(root, 'docs/backlog/EX-002.md'), 'utf8'), /status: Drafted/);
    assert.match(fs.readFileSync(path.join(root, 'docs/backlog-index.md'), 'utf8'), /EX-001 — One {2}\[Feature · Implemented\]/);
  });
});
