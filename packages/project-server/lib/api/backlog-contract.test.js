'use strict';

// The backlog API contract other Studio apps rely on (docs/backlog-api-contract.md).
// Launch Studio files backlog items through these endpoints from its launch plan
// (its LS-218 / PRD-128). Each test pins one promise in that document; a failure
// here means a consumer outside this repo breaks. Change the shape only together
// with the contract doc and the consumers, never to make this test pass.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createBacklogRouter } = require('./backlog');
const { createHealthHandler } = require('./health');
const { VALID_STATUSES } = require('../backlog');

// The exact id pattern Launch Studio validates a filed item's id with.
const CONSUMER_ID_RE = /^[A-Z]{2,5}-\d{1,5}$/;

const INDEX = `# Backlog index

<!-- BACKLOG-START -->

### Phase 1

- EX-001 — One  [Feature · Done]
- EX-002 — Two  [Feature · Reviewed]

### Phase 2

- EX-003 — Three  [Bug · Backlog]

<!-- BACKLOG-END -->
`;

function makeProject({ git = false } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-contract-')));
  const dir = path.join(root, 'docs', 'backlog');
  fs.mkdirSync(dir, { recursive: true });
  const items = { 'EX-001': ['Feature', 'Done'], 'EX-002': ['Feature', 'Reviewed'], 'EX-003': ['Bug', 'Backlog'] };
  for (const [id, [type, status]] of Object.entries(items)) {
    fs.writeFileSync(path.join(dir, `${id}.md`), `---\nid: ${id}\ntitle: ${id}\ntype: ${type}\nstatus: ${status}\n---\n\nBody.\n`);
  }
  fs.writeFileSync(path.join(root, 'docs', 'backlog-index.md'), INDEX);
  if (git) {
    const g = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    g('add', '-A');
    g('commit', '-q', '-m', 'init');
  }
  return root;
}

// The routes as server.js mounts them.
async function withServer(root, run) {
  const config = { projectRoot: root, docs_path: 'docs', name: 'example' };
  const app = express();
  app.use(express.json());
  app.get('/api/health', createHealthHandler(config, { startedAt: new Date().toISOString(), bundleVersion: null }));
  app.use('/api', createBacklogRouter(config));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(base);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function call(base, method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    redirect: 'manual',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

// The request exactly as Launch Studio sends it.
const consumerRequest = (overrides = {}) => ({
  title: 'Filed from the launch plan', type: 'Task', body: 'Why and what.', depends_on: [], release: 'Phase 2', ...overrides,
});

test('§2 GET /api/health: 200, ok true, and the absolute projectRoot a consumer checks before filing', async () => {
  const root = makeProject();
  await withServer(root, async (base) => {
    const r = await call(base, 'GET', '/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(typeof r.body.projectRoot, 'string');
    assert.ok(path.isAbsolute(r.body.projectRoot));
    assert.equal(r.body.projectRoot, root);
  });
});

test('§3 GET /api/backlog: groups in index order, and a status for every listed item', async () => {
  const root = makeProject();
  await withServer(root, async (base) => {
    const r = await call(base, 'GET', '/api/backlog');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.groups, [
      { release: 'Phase 1', items: ['EX-001', 'EX-002'] },
      { release: 'Phase 2', items: ['EX-003'] },
    ]);
    for (const g of r.body.groups) {
      assert.equal(typeof g.release, 'string');
      for (const id of g.items) {
        assert.equal(typeof id, 'string');
        assert.ok(VALID_STATUSES.includes(r.body.items[id].status), `${id} has a contract status`);
      }
    }
    assert.equal(r.body.items['EX-001'].status, 'Done');
    assert.equal(r.body.items['EX-003'].status, 'Backlog');
  });
});

test('§3 GET /api/backlog: a project without a backlog index answers 200 with nothing in it', async () => {
  const root = makeProject();
  fs.rmSync(path.join(root, 'docs', 'backlog'), { recursive: true });
  fs.rmSync(path.join(root, 'docs', 'backlog-index.md'));
  await withServer(root, async (base) => {
    const r = await call(base, 'GET', '/api/backlog');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.groups, []);
    assert.deepEqual(r.body.items, {});
  });
});

test('§3 GET /api/backlog?fields=status: the same groups, and each item reduced to its status', async () => {
  const root = makeProject();
  await withServer(root, async (base) => {
    const full = await call(base, 'GET', '/api/backlog');
    const lean = await call(base, 'GET', '/api/backlog?fields=status');
    assert.equal(lean.status, 200);
    assert.deepEqual(Object.keys(lean.body).sort(), ['groups', 'items']);
    assert.deepEqual(lean.body.groups, full.body.groups);
    assert.deepEqual(Object.keys(lean.body.items).sort(), Object.keys(full.body.items).sort());
    for (const [id, item] of Object.entries(lean.body.items)) {
      assert.deepEqual(item, { status: full.body.items[id].status }, `${id} carries only its status`);
    }
  });
});

test('§3 GET /api/backlog: any other fields value is 400, never a silently different shape', async () => {
  const root = makeProject();
  await withServer(root, async (base) => {
    for (const q of ['?fields=title', '?fields=status,title', '?fields=']) {
      const r = await call(base, 'GET', `/api/backlog${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(typeof r.body.error, 'string');
    }
  });
});

test('§3 the status vocabulary is the contract\'s: adding or renaming one is a contract change', () => {
  assert.deepEqual(VALID_STATUSES, [
    'Backlog', 'Drafted', 'Reviewed', 'Implemented', 'Done', 'Blocked', 'Fixing', 'Ready', 'In Progress', 'In Review',
  ]);
});

test('§4 POST /api/backlog/items: 201 with an id the consumer accepts, the release, and commit null without git', async () => {
  const root = makeProject();
  await withServer(root, async (base) => {
    const r = await call(base, 'POST', '/api/backlog/items', consumerRequest());
    assert.equal(r.status, 201);
    assert.match(r.body.id, CONSUMER_ID_RE);
    assert.equal(r.body.id, 'EX-004', 'the next number, zero-padded to three digits');
    assert.equal(r.body.release, 'Phase 2');
    assert.equal(r.body.commit, null);
  });
});

test('§4 POST /api/backlog/items in a git repo: commit is { committed, sha, reason }', async () => {
  const root = makeProject({ git: true });
  await withServer(root, async (base) => {
    const r = await call(base, 'POST', '/api/backlog/items', consumerRequest());
    assert.equal(r.status, 201);
    assert.equal(r.body.commit.committed, true);
    assert.equal(typeof r.body.commit.sha, 'string');
    assert.equal(typeof r.body.commit.reason, 'string');
  });
});

test('§4 POST /api/backlog/items: a new release is created, at the end', async () => {
  const root = makeProject();
  await withServer(root, async (base) => {
    const r = await call(base, 'POST', '/api/backlog/items', consumerRequest({ release: 'Launch plan' }));
    assert.equal(r.status, 201);
    assert.equal(r.body.release, 'Launch plan');
    const groups = (await call(base, 'GET', '/api/backlog')).body.groups;
    assert.deepEqual(groups.at(-1), { release: 'Launch plan', items: [r.body.id] });
  });
});

test('§4 POST /api/backlog/items: invalid input is 400 with an error string, and nothing is written', async () => {
  const root = makeProject();
  await withServer(root, async (base) => {
    for (const body of [consumerRequest({ title: '' }), consumerRequest({ type: 'Epic' }), consumerRequest({ depends_on: ['EX-099'] })]) {
      const r = await call(base, 'POST', '/api/backlog/items', body);
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.equal(typeof r.body.error, 'string');
    }
    assert.equal(fs.existsSync(path.join(root, 'docs', 'backlog', 'EX-004.md')), false);
  });
});

test('§5 the filed item\'s file carries its status in front matter, readable without the server', async () => {
  const root = makeProject();
  await withServer(root, async (base) => {
    const r = await call(base, 'POST', '/api/backlog/items', consumerRequest());
    const file = fs.readFileSync(path.join(root, 'docs', 'backlog', `${r.body.id}.md`), 'utf8');
    const front = file.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(front, 'the file starts with YAML front matter');
    assert.match(front[1], /^status: Backlog$/m);
    assert.match(front[1], new RegExp(`^id: ${r.body.id}$`, 'm'));
  });
});
