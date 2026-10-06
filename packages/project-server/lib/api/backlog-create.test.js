'use strict';

// POST /backlog/items — what the create_story skill files a story through. The
// engine allocates the id and writes both halves of the backlog contract (the
// item file and its line in project-state.md) at the position the owner chose.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createBacklogRouter } = require('./backlog');
const { insertIntoGroups, readItem, parseBacklogSection } = require('../backlog');

const STATE = `# State

<!-- BACKLOG-START -->

### Phase 1

- EX-001 — One  [Feature · Done]
- EX-002 — Two  [Feature · Reviewed]

### Phase 2

- EX-003 — Three  [Feature · Backlog]

<!-- BACKLOG-END -->

Trailing text kept.
`;

function makeProject({ git = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backlog-create-test-'));
  const dir = path.join(root, 'docs', 'backlog');
  fs.mkdirSync(dir, { recursive: true });
  const statuses = { 'EX-001': 'Done', 'EX-002': 'Reviewed', 'EX-003': 'Backlog' };
  for (const [id, status] of Object.entries(statuses)) {
    fs.writeFileSync(path.join(dir, `${id}.md`), `---\nid: ${id}\ntitle: ${id}\ntype: Feature\nstatus: ${status}\n---\n\nBody.\n`);
  }
  fs.writeFileSync(path.join(root, 'docs', 'project-state.md'), STATE);
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

async function postItem(root, body) {
  const app = express();
  app.use(express.json());
  app.use('/api', createBacklogRouter({ projectRoot: root, docs_path: 'docs', name: 'example' }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/backlog/items`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

const order = (root) => parseBacklogSection(fs.readFileSync(path.join(root, 'docs', 'project-state.md'), 'utf8'));

test('insertIntoGroups: after, before, end of a release, a new release', () => {
  const g = [{ release: 'A', items: ['X-1', 'X-2'] }, { release: 'B', items: ['X-3'] }];
  assert.deepEqual(insertIntoGroups(g, 'X-9', { after: 'X-1' }).groups[0].items, ['X-1', 'X-9', 'X-2']);
  assert.deepEqual(insertIntoGroups(g, 'X-9', { before: 'X-1' }).groups[0].items, ['X-9', 'X-1', 'X-2']);
  assert.deepEqual(insertIntoGroups(g, 'X-9', { release: 'B' }).groups[1].items, ['X-3', 'X-9']);
  const fresh = insertIntoGroups(g, 'X-9', { release: 'C' });
  assert.deepEqual(fresh.groups.map((x) => x.release), ['A', 'B', 'C']);
  assert.deepEqual(g[0].items, ['X-1', 'X-2'], 'the input is not mutated');
});

test('insertIntoGroups refuses a position the owner did not pick', () => {
  const g = [{ release: 'A', items: ['X-1'] }, { release: 'B', items: ['X-3'] }];
  assert.throws(() => insertIntoGroups(g, 'X-9', { after: 'X-7' }), /not in the backlog/);
  assert.throws(() => insertIntoGroups(g, 'X-9', { after: 'X-1', release: 'B' }), /is in "A", not "B"/);
  assert.throws(() => insertIntoGroups(g, 'X-9', {}), /release, or an item/);
  assert.throws(() => insertIntoGroups(g, 'X-9', { after: 'X-1', before: 'X-1' }), /not both/);
});

test('files a story after its dependency, with the next id and the prefix in use', async () => {
  const root = makeProject();
  const r = await postItem(root, {
    title: 'Four', depends_on: ['EX-002'], after: 'EX-002',
    body: '## Why (owner, 2026-10-06)\nBecause.\n## Scope\n- a\n',
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.id, 'EX-004');
  assert.equal(r.body.release, 'Phase 1');
  assert.deepEqual(order(root)[0].items, ['EX-001', 'EX-002', 'EX-004']);
  const item = readItem(root, 'docs', 'EX-004');
  assert.equal(item.status, 'Backlog');
  assert.equal(item.type, 'Feature');
  assert.deepEqual(item.depends_on, ['EX-002']);
  assert.equal(item.release, 'Phase 1');
  assert.match(item.body, /## Why \(owner, 2026-10-06\)\n\nBecause\./, 'the body is tidied for markdown lint');
  assert.match(fs.readFileSync(path.join(root, 'docs', 'project-state.md'), 'utf8'), /Trailing text kept\./);
});

test('a refused request writes nothing', async () => {
  const root = makeProject();
  const before = fs.readFileSync(path.join(root, 'docs', 'project-state.md'), 'utf8');
  for (const body of [
    { title: '' },
    { title: 'x', release: 'Phase 1', type: 'Epic' },
    { title: 'x', depends_on: ['EX-099'], release: 'Phase 1' },
    { title: 'x', after: 'EX-099' },
    { title: 'x', after: 'not-an-id' },
  ]) {
    const r = await postItem(root, body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(fs.existsSync(path.join(root, 'docs', 'backlog', 'EX-004.md')), false);
  assert.equal(fs.readFileSync(path.join(root, 'docs', 'project-state.md'), 'utf8'), before);
});

test('commits exactly the item and project-state.md', async () => {
  const root = makeProject({ git: true });
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'an agent is working here\n');
  const r = await postItem(root, { title: 'Four', release: 'Phase 2' });
  assert.equal(r.status, 201);
  assert.equal(r.body.commit.committed, true);
  const files = execFileSync('git', ['show', '--name-only', '--format=%s', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().split('\n');
  assert.equal(files[0], 'docs(EX-004): add story to the backlog');
  assert.deepEqual(files.slice(1).filter(Boolean).sort(), ['docs/backlog/EX-004.md', 'docs/project-state.md']);
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  assert.match(status, /\?\? unrelated\.txt/, 'nothing else is swept in');
});
