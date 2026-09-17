'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDraftingRouter } = require('./drafting');

function makeProject(items) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drafting-api-test-'));
  const dir = path.join(root, 'docs', 'backlog');
  fs.mkdirSync(dir, { recursive: true });
  for (const [id, fm] of Object.entries(items)) {
    const lines = Object.entries({ id, ...fm }).map(([k, v]) => `${k}: ${v}`);
    fs.writeFileSync(path.join(dir, `${id}.md`), `---\n${lines.join('\n')}\n---\n\nBody.\n`);
  }
  return root;
}

function fakeTmux() {
  const calls = [];
  return {
    calls,
    ensureWindow: (s, w) => { calls.push(['ensureWindow', s, w]); return `${s}:${w}`; },
    sendKeys: (t, cmd) => { calls.push(['sendKeys', t, cmd]); },
  };
}

async function post(root, tmux, body) {
  const config = {
    projectRoot: root, docsPath: 'docs', name: 'proj',
    statePath: path.join(root, '.build-studio'),
    cli: { default: 'claude', groups: {} }, step_groups: null,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createDraftingRouter(config, {}, tmux));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/draft/start`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

// Bugs have no drafting stage — Backlog goes straight to a bugfix run — so a
// drafting session for one would write a PRD nothing ever reads. The UI hides
// the button; this pins that a direct call is refused too, BEFORE any tmux work.
test('a Bug is refused and never reaches tmux', async () => {
  const root = makeProject({ 'EX-001': { type: 'Bug', status: 'Backlog', title: 'Crash' } });
  const tmux = fakeTmux();
  const r = await post(root, tmux, { itemId: 'EX-001' });
  assert.equal(r.status, 409);
  assert.equal(r.body.isBug, true);
  assert.deepEqual(tmux.calls, [], 'no window may be opened for a bug');
});

test('a Feature with no PRD opens a drafting window', async () => {
  const root = makeProject({ 'EX-002': { type: 'Feature', status: 'Backlog', title: 'Thing' } });
  const tmux = fakeTmux();
  const r = await post(root, tmux, { itemId: 'EX-002' });
  assert.equal(r.status, 200);
  assert.equal(r.body.window, 'draft-EX-002');
  assert.equal(tmux.calls[0][0], 'ensureWindow');
  assert.equal(tmux.calls[0][1], 'draft-proj', 'never the workflow session');
});

// Tasks share the PRD lifecycle with Features, so they keep the button.
test('a Task is draftable like a Feature', async () => {
  const root = makeProject({ 'EX-003': { type: 'Task', status: 'Backlog', title: 'Chore' } });
  const r = await post(root, fakeTmux(), { itemId: 'EX-003' });
  assert.equal(r.status, 200);
});
