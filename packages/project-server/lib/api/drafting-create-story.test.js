'use strict';

// Create story (owner request 2026-10-06): the create_story skill, run in the
// SAME drafting session as Draft so the conversation keeps its context, under
// the same one-at-a-time rule. It writes nothing to the backlog itself; the
// agent files the story through POST /backlog/items.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDraftingRouter } = require('./drafting');
const { CREATE_STORY_MARKER } = require('../drafting');

const TEMPLATE_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'templates', 'default');
const SKILL_REL = path.join('.claude', 'skills', 'create_story', 'SKILL.md');

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'create-story-test-'));
  fs.mkdirSync(path.join(root, 'docs', 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'backlog', 'EX-001.md'), '---\nid: EX-001\ntitle: Earlier\ntype: Feature\nstatus: Drafted\n---\n\nBody.\n');
  return root;
}

function fakeTmux({ livePid = null, agentRunning = false } = {}) {
  const calls = [];
  return {
    calls,
    ensureWindow: (s, w) => { calls.push(['ensureWindow', s, w]); return `${s}:${w}`; },
    sendKeys: (t, cmd) => { calls.push(['sendKeys', t, cmd]); },
    pipePaneToLog: () => {},
    killWindowAndChildren: () => {},
    panePid: () => livePid,
    hasLiveDescendant: () => agentRunning,
  };
}

function priorSession(root, session) {
  fs.mkdirSync(path.join(root, '.build-studio'), { recursive: true });
  fs.writeFileSync(path.join(root, '.build-studio', 'draft-state.json'),
    JSON.stringify({ sessionName: 'draft-proj', session: { window: 'draft', ...session } }));
}

async function post(root, tmux, { cli = 'claude', route = '/draft/create-story', body = {}, findSessionId, templateDir = TEMPLATE_DIR } = {}) {
  const config = {
    projectRoot: root, docsPath: path.join(root, 'docs'), docs_path: 'docs', name: 'proj', port: 3456,
    statePath: path.join(root, '.build-studio'),
    logsPath: path.join(root, 'tmp', '.logs'),
    cli: { default: cli, groups: {} }, step_groups: null,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createDraftingRouter(config, {}, tmux, { templateDir, ...(findSessionId ? { findSessionId } : {}) }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

const prompt = (root) => fs.readFileSync(path.join(root, 'prompt-draft.txt'), 'utf8');
const savedSession = (root) => JSON.parse(fs.readFileSync(path.join(root, '.build-studio', 'draft-state.json'), 'utf8')).session;

test('the template ships the create_story skill', () => {
  const skill = fs.readFileSync(path.join(TEMPLATE_DIR, SKILL_REL), 'utf8');
  assert.match(skill, /^name: create_story$/m);
  assert.match(skill, /POST http:\/\/localhost:<port>\/api\/backlog\/items/);
  assert.match(skill, /Always ask; the order is the owner's/);
});

test('fresh: opens the drafting window with the create_story prompt and the real port', async () => {
  const root = makeProject();
  const tmux = fakeTmux();
  const r = await post(root, tmux);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'fresh');
  assert.deepEqual(tmux.calls[0], ['ensureWindow', 'draft-proj', 'draft'], 'the same window Draft uses');
  const p = prompt(root);
  assert.match(p, /Use the `create_story` skill/);
  assert.match(p, new RegExp(CREATE_STORY_MARKER));
  assert.match(p, /POST http:\/\/localhost:3456\/api\/backlog\/items/);
  assert.match(p, /INTERACTIVE session/);
});

test('a project without the skill gets it installed; one with its own keeps it', async () => {
  const root = makeProject();
  await post(root, fakeTmux());
  assert.ok(fs.existsSync(path.join(root, SKILL_REL)), 'installed from the template');

  const own = 'my edited skill\n';
  fs.writeFileSync(path.join(root, SKILL_REL), own);
  await post(root, fakeTmux());
  assert.equal(fs.readFileSync(path.join(root, SKILL_REL), 'utf8'), own, 'never overwritten');
});

test('resumes the drafting conversation, so the story is written with its context', async () => {
  const root = makeProject();
  priorSession(root, {
    cli: 'claude', cliSessionId: 'sess-1', startedAt: '2026-10-06T08:00:00.000Z',
    lastUsedAt: '2026-10-06T08:30:00.000Z', items: ['EX-001'], openingItemId: 'EX-001', lastItemId: 'EX-001',
  });
  const tmux = fakeTmux();
  const r = await post(root, tmux);
  assert.equal(r.body.mode, 'resumed');
  assert.match(tmux.calls.find((c) => c[0] === 'sendKeys')[2], /--resume 'sess-1'/);
  assert.match(prompt(root), /^Next: create a new backlog story/);
  const s = savedSession(root);
  assert.equal(s.lastItemId, null, 'no longer on the drafted item');
  assert.equal(s.lastAction, 'create_story');
  assert.deepEqual(s.items, ['EX-001'], 'End draft still commits what was drafted, and nothing more');
  assert.equal(s.openingItemId, 'EX-001', 'how the session is found is unchanged');
});

test('refused while a draft is running, exactly as Draft is', async () => {
  const root = makeProject();
  priorSession(root, { cli: 'claude', cliSessionId: 'sess-1', items: ['EX-001'], lastItemId: 'EX-001' });
  const tmux = fakeTmux({ livePid: 123, agentRunning: true });
  const r = await post(root, tmux);
  assert.equal(r.status, 409);
  assert.equal(r.body.sessionRunning, true);
  assert.ok(!tmux.calls.some((c) => c[0] === 'sendKeys'), 'nothing is typed into a busy agent');
});

test('a codex session opened by Create story is found again by its marker', async () => {
  const root = makeProject();
  const first = await post(root, fakeTmux(), { cli: 'codex' });
  assert.equal(first.status, 200);
  assert.equal(savedSession(root).openingMarker, CREATE_STORY_MARKER);

  const lookups = [];
  const tmux = fakeTmux();
  const r = await post(root, tmux, {
    cli: 'codex', route: '/draft/start', body: { itemId: 'EX-001' },
    findSessionId: (q) => { lookups.push(q); return 'cx-1'; },
  });
  assert.equal(r.body.mode, 'resumed');
  assert.equal(lookups[0].marker, CREATE_STORY_MARKER);
  assert.ok(!lookups[0].itemId, 'no item to match on');
  assert.deepEqual(savedSession(root).items, ['EX-001']);
});

// The busy hint tells the owner to ask in the terminal, so a session opened by
// Draft must have the skill as well, even in a project onboarded before it.
test('Draft installs the skill too, so "create a story" in the terminal reaches it', async () => {
  const root = makeProject();
  fs.writeFileSync(path.join(root, 'docs', 'backlog', 'EX-002.md'), '---\nid: EX-002\ntitle: Next\ntype: Feature\nstatus: Backlog\n---\n\nBody.\n');
  const r = await post(root, fakeTmux(), { route: '/draft/start', body: { itemId: 'EX-002' } });
  assert.equal(r.status, 200);
  assert.ok(fs.existsSync(path.join(root, SKILL_REL)));
});
