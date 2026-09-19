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

function fakeTmux({ livePid = null, agentRunning = false } = {}) {
  const calls = [];
  return {
    calls,
    ensureWindow: (s, w) => { calls.push(['ensureWindow', s, w]); return `${s}:${w}`; },
    sendKeys: (t, cmd) => { calls.push(['sendKeys', t, cmd]); },
    pipePaneToLog: (t, f) => { calls.push(['pipePaneToLog', t, f]); },
    panePid: () => livePid,
    hasLiveDescendant: () => agentRunning,
  };
}

async function post(root, tmux, body) {
  const config = {
    projectRoot: root, docsPath: 'docs', name: 'proj',
    statePath: path.join(root, '.build-studio'),
    logsPath: path.join(root, 'tmp', '.logs'),
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
  assert.equal(r.body.window, 'draft');
  assert.equal(tmux.calls[0][0], 'ensureWindow');
  assert.equal(tmux.calls[0][1], 'draft-proj', 'never the workflow session');
  // Without a log the pane is the only record, and it dies with the window.
  assert.ok(tmux.calls.some(c => c[0] === 'pipePaneToLog'), 'the pane is logged');
  assert.match(r.body.logFile, /draft\.log$/);
});

// Tasks share the PRD lifecycle with Features, so they keep the button.
test('a Task is draftable like a Feature', async () => {
  const root = makeProject({ 'EX-003': { type: 'Task', status: 'Backlog', title: 'Chore' } });
  const r = await post(root, fakeTmux(), { itemId: 'EX-003' });
  assert.equal(r.status, 200);
});

// ── increment 2: one session per project, continued rather than replaced ─────

const readState = (root) => JSON.parse(fs.readFileSync(path.join(root, '.build-studio', 'draft-state.json'), 'utf8'));

test('a first draft pins a session id it can later resume', async () => {
  const root = makeProject({ 'EX-010': { type: 'Feature', status: 'Backlog', title: 'A' } });
  const tmux = fakeTmux();
  const r = await post(root, tmux, { itemId: 'EX-010' });
  assert.equal(r.body.mode, 'fresh');
  assert.ok(r.body.cliSessionId, 'a session id is pinned');
  const cmd = tmux.calls.find(c => c[0] === 'sendKeys')[2];
  assert.match(cmd, /--session-id '/, 'pinned at launch, not after');
});

// The bug this increment removed: a second Draft click used to kill the running
// conversation, because window creation deduplicates by name. It is now refused
// outright — talking into a live session meant typing into whatever the agent
// was doing, which is wrong when it is sitting on a menu.
test('a second item is refused while a session is running, and nothing is touched', async () => {
  const root = makeProject({
    'EX-011': { type: 'Feature', status: 'Backlog', title: 'A' },
    'EX-012': { type: 'Feature', status: 'Backlog', title: 'B' },
  });
  await post(root, fakeTmux(), { itemId: 'EX-011' });
  const live = fakeTmux({ livePid: 4242, agentRunning: true });
  const r = await post(root, live, { itemId: 'EX-012' });

  assert.equal(r.status, 409);
  assert.equal(r.body.sessionRunning, true);
  assert.equal(r.body.lastItemId, 'EX-011', 'it says which draft is in the way');
  assert.deepEqual(live.calls, [], 'the running session is neither recreated nor typed into');
});

// A window with no agent in it is a shell at a prompt, not a conversation in
// progress — that is the case the refusal must NOT catch.
test('an idle window does not count as a running session', async () => {
  const root = makeProject({
    'EX-016': { type: 'Feature', status: 'Backlog', title: 'A' },
    'EX-017': { type: 'Feature', status: 'Backlog', title: 'B' },
  });
  const first = await post(root, fakeTmux(), { itemId: 'EX-016' });
  const idle = fakeTmux({ livePid: 777, agentRunning: false });
  const r = await post(root, idle, { itemId: 'EX-017' });

  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'resumed');
  assert.equal(r.body.cliSessionId, first.body.cliSessionId, 'same conversation continues');
});

test('a dead window resumes the conversation rather than starting over', async () => {
  const root = makeProject({
    'EX-013': { type: 'Feature', status: 'Backlog', title: 'A' },
    'EX-014': { type: 'Feature', status: 'Backlog', title: 'B' },
  });
  const first = await post(root, fakeTmux(), { itemId: 'EX-013' });
  const tmux = fakeTmux();                       // panePid null → window gone
  const r = await post(root, tmux, { itemId: 'EX-014' });

  assert.equal(r.body.mode, 'resumed');
  assert.equal(r.body.cliSessionId, first.body.cliSessionId, 'same conversation');
  const cmd = tmux.calls.find(c => c[0] === 'sendKeys')[2];
  assert.match(cmd, /--resume '/, 'resumed, not pinned anew');
});

test('fresh: true abandons the old conversation deliberately', async () => {
  const root = makeProject({ 'EX-015': { type: 'Feature', status: 'Backlog', title: 'A' } });
  const first = await post(root, fakeTmux(), { itemId: 'EX-015' });
  const live = fakeTmux({ livePid: 99, agentRunning: true });
  const r = await post(root, live, { itemId: 'EX-015', fresh: true });

  assert.equal(r.body.mode, 'fresh');
  assert.notEqual(r.body.cliSessionId, first.body.cliSessionId, 'a new conversation');
  assert.ok(live.calls.some(c => c[0] === 'ensureWindow'), 'and a new window');
});
