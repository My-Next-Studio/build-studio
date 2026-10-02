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
    killWindowAndChildren: (t) => { calls.push(['killWindowAndChildren', t]); },
    panePid: () => livePid,
    hasLiveDescendant: () => agentRunning,
  };
}

async function postTo(root, tmux, route, body) {
  return post(root, tmux, body, route);
}

async function post(root, tmux, body, route = '/draft/start') {
  // The shape config.js produces: docsPath ABSOLUTE, docs_path relative. A
  // relative docsPath here hid a router that could not find any backlog item.
  const config = {
    projectRoot: root, docsPath: path.join(root, 'docs'), docs_path: 'docs', name: 'proj',
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
    const res = await fetch(`http://127.0.0.1:${port}/api${route}`, {
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

// Hiding the panel closes the view and leaves the session alone — right for
// stepping away, ambiguous for finishing. A completed draft whose agent still
// sits at its prompt looks identical to one in progress, so it held the
// one-at-a-time lock and disabled every Draft button. Ending is its own act.
test('ending stops the agent but keeps the conversation resumable', async () => {
  const root = makeProject({ 'EX-020': { type: 'Feature', status: 'Backlog', title: 'A' } });
  const started = await post(root, fakeTmux(), { itemId: 'EX-020' });

  const live = fakeTmux({ livePid: 321, agentRunning: true });
  const r = await postTo(root, live, '/draft/end', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.ending, true);
  assert.equal(r.body.resumable, true, 'ending is not abandoning');

  const sent = live.calls.find(c => c[0] === 'sendKeys');
  assert.equal(sent[2], '/exit', 'the CLI exits itself rather than being cut off');

  const state = readState(root);
  assert.equal(state.session.cliSessionId, started.body.cliSessionId, 'the id survives');
  assert.ok(state.session.endedAt, 'and the end is recorded');
});

test('ending an already-dead session is a no-op, not an error', async () => {
  const root = makeProject({ 'EX-021': { type: 'Feature', status: 'Backlog', title: 'A' } });
  await post(root, fakeTmux(), { itemId: 'EX-021' });
  const r = await postTo(root, fakeTmux(), '/draft/end', {});   // panePid null
  assert.equal(r.status, 200);
  assert.equal(r.body.alreadyEnded, true);
});

// After ending, the next draft resumes rather than starting over — the whole
// reason ending keeps the id.
test('a draft after ending resumes the same conversation', async () => {
  const root = makeProject({
    'EX-022': { type: 'Feature', status: 'Backlog', title: 'A' },
    'EX-023': { type: 'Feature', status: 'Backlog', title: 'B' },
  });
  const first = await post(root, fakeTmux(), { itemId: 'EX-022' });
  await postTo(root, fakeTmux({ livePid: 5, agentRunning: true }), '/draft/end', {});
  const r = await post(root, fakeTmux(), { itemId: 'EX-023' });
  assert.equal(r.body.mode, 'resumed');
  assert.equal(r.body.cliSessionId, first.body.cliSessionId);
});

// Close sent /exit to both cases, and a pane whose agent has already exited is a
// bare SHELL — it printed "command not found" and the window stayed open, so
// Close looked like it did nothing.
test('closing a session with no agent kills the window instead of typing at a shell', async () => {
  const root = makeProject({ 'EX-030': { type: 'Feature', status: 'Backlog', title: 'A' } });
  await post(root, fakeTmux(), { itemId: 'EX-030' });
  const shell = fakeTmux({ livePid: 4242, agentRunning: false });
  const r = await postTo(root, shell, '/draft/end', {});

  assert.equal(r.status, 200);
  assert.ok(shell.calls.some(c => c[0] === 'killWindowAndChildren'), 'the window is closed');
  assert.ok(!shell.calls.some(c => c[0] === 'sendKeys'), 'nothing is typed at the shell');
});

test('closing a session with a live agent still asks the CLI to exit itself', async () => {
  const root = makeProject({ 'EX-031': { type: 'Feature', status: 'Backlog', title: 'A' } });
  await post(root, fakeTmux(), { itemId: 'EX-031' });
  const live = fakeTmux({ livePid: 4242, agentRunning: true });
  await postTo(root, live, '/draft/end', {});

  const sent = live.calls.find(c => c[0] === 'sendKeys');
  assert.equal(sent[2], '/exit', 'a running CLI is allowed to close itself');
  assert.ok(!live.calls.some(c => c[0] === 'killWindowAndChildren'), 'and is not cut off');
});

// ── committing the draft (owner request 2026-10-01) ─────────────────────────

const { execFileSync } = require('child_process');
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

/** A project repo where a finished draft has written its three files. */
function draftedRepo() {
  const root = makeProject({ 'EX-010': { type: 'Feature', status: 'Backlog', title: 'Plan' } });
  fs.writeFileSync(path.join(root, 'docs', 'project-state.md'), '# State\n');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'owner notes\n');
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 'T');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  // What the draft_prd handoff writes:
  fs.mkdirSync(path.join(root, 'docs', 'prds'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'prds', 'PRD-010-plan.md'), '# PRD-010\n');
  fs.writeFileSync(path.join(root, 'docs', 'backlog', 'EX-010.md'),
    '---\nid: EX-010\ntitle: Plan\ntype: Feature\nstatus: Drafted\nprd: docs/prds/PRD-010-plan.md\n---\n\nBody.\n');
  fs.writeFileSync(path.join(root, 'docs', 'project-state.md'), '# State\n| EX-010 | Drafted |\n');
  // Something unrelated the owner is editing, which must NOT be swept in:
  fs.writeFileSync(path.join(root, 'notes.txt'), 'owner notes, edited\n');
  fs.mkdirSync(path.join(root, '.build-studio'), { recursive: true });
  fs.writeFileSync(path.join(root, '.build-studio', 'draft-state.json'), JSON.stringify({
    sessionName: 'draft-proj', session: { window: 'draft', items: ['EX-010'], lastItemId: 'EX-010' },
  }));
  return root;
}

test('End draft commits the PRD, the item and project-state, and nothing else', async () => {
  const root = draftedRepo();
  const r = await postTo(root, fakeTmux({ livePid: null }), '/draft/end', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.commit.committed, true);
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'docs(EX-010): draft PRD');
  const files = git(root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort();
  assert.deepEqual(files, ['docs/backlog/EX-010.md', 'docs/prds/PRD-010-plan.md', 'docs/project-state.md']);
  assert.match(git(root, 'status', '--porcelain'), /notes\.txt/, 'unrelated edits stay uncommitted');
});

test('ending a draft with a live agent also commits', async () => {
  const root = draftedRepo();
  const tmux = fakeTmux({ livePid: 123, agentRunning: true });
  const r = await postTo(root, tmux, '/draft/end', {});
  assert.equal(r.body.ending, true);
  assert.equal(r.body.commit.committed, true);
  assert.ok(tmux.calls.some((c) => c[0] === 'sendKeys' && c[2] === '/exit'));
});

test('a Draft click commits what an exited agent left behind before launching', async () => {
  const root = draftedRepo();
  fs.writeFileSync(path.join(root, 'docs', 'backlog', 'EX-011.md'),
    '---\nid: EX-011\ntitle: Next\ntype: Feature\nstatus: Backlog\n---\n\nBody.\n');
  git(root, 'add', 'docs/backlog/EX-011.md');
  git(root, 'commit', '-qm', 'add EX-011', '--', 'docs/backlog/EX-011.md');
  const r = await post(root, fakeTmux({ livePid: 123, agentRunning: false }), { itemId: 'EX-011' });
  assert.equal(r.status, 200);
  assert.equal(git(root, 'log', '-1', '--format=%s'), 'docs(EX-010): draft PRD');
});

test('an item that already has a PRD is refused (readItem finds it with an absolute docsPath)', async () => {
  const root = makeProject({ 'EX-012': { type: 'Feature', status: 'Drafted', title: 'Done', prd: 'docs/prds/PRD-012.md' } });
  const r = await post(root, fakeTmux(), { itemId: 'EX-012' });
  assert.equal(r.status, 409);
  assert.equal(r.body.hasPrd, true);
});

// ── continuity on Codex and OpenCode (owner request 2026-10-02) ─────────────

/** Like post(), but on a chosen CLI and with the session lookup injected. */
async function postOn(cli, root, tmux, body, route, findSessionId) {
  const config = {
    projectRoot: root, docsPath: path.join(root, 'docs'), docs_path: 'docs', name: 'proj',
    statePath: path.join(root, '.build-studio'),
    logsPath: path.join(root, 'tmp', '.logs'),
    cli: { default: cli, groups: {} }, step_groups: null,
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createDraftingRouter(config, {}, tmux, { findSessionId }));
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

function priorSession(root, session) {
  fs.mkdirSync(path.join(root, '.build-studio'), { recursive: true });
  fs.writeFileSync(path.join(root, '.build-studio', 'draft-state.json'),
    JSON.stringify({ sessionName: 'draft-proj', session: { window: 'draft', ...session } }));
}

const launchLine = (tmux) => (tmux.calls.find((c) => c[0] === 'sendKeys') || [])[2] || '';

test('codex: the next Draft resumes the conversation, its id read back from codex', async () => {
  const root = makeProject({ 'EX-020': { type: 'Feature', status: 'Backlog', title: 'Next' } });
  priorSession(root, { cli: 'codex', startedAt: '2026-10-02T08:00:00.000Z', items: ['EX-019'], openingItemId: 'EX-019', lastItemId: 'EX-019' });
  const lookups = [];
  const find = (q) => { lookups.push(q); return 'cx-session-1'; };
  const tmux = fakeTmux();
  const r = await postOn('codex', root, tmux, { itemId: 'EX-020' }, '/draft/start', find);
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'resumed');
  assert.match(launchLine(tmux), /codex 'resume' 'cx-session-1' /);
  assert.deepEqual(lookups[0], { cli: 'codex', projectRoot: root, since: '2026-10-02T08:00:00.000Z', itemId: 'EX-019' });
  assert.equal(r.body.cliSessionId, 'cx-session-1', 'the id is kept so the next Draft needs no lookup');
});

test('opencode: resumes with --session, launched as the interactive TUI', async () => {
  const root = makeProject({ 'EX-021': { type: 'Feature', status: 'Backlog', title: 'Next' } });
  priorSession(root, { cli: 'opencode', startedAt: '2026-10-02T08:00:00.000Z', items: ['EX-018'], lastItemId: 'EX-018' });
  const tmux = fakeTmux();
  const r = await postOn('opencode', root, tmux, { itemId: 'EX-021' }, '/draft/start', () => 'ses_abc');
  assert.equal(r.body.mode, 'resumed');
  assert.match(launchLine(tmux), /opencode --session 'ses_abc' .*--prompt /);
  assert.doesNotMatch(launchLine(tmux), /opencode run/);
});

test('a lookup that finds nothing starts a fresh conversation, as before', async () => {
  const root = makeProject({ 'EX-022': { type: 'Feature', status: 'Backlog', title: 'Next' } });
  priorSession(root, { cli: 'codex', startedAt: '2026-10-02T08:00:00.000Z', items: ['EX-017'] });
  const tmux = fakeTmux();
  const r = await postOn('codex', root, tmux, { itemId: 'EX-022' }, '/draft/start', () => null);
  assert.equal(r.body.mode, 'fresh');
  assert.doesNotMatch(launchLine(tmux), /resume/);
});

test('a CLI switch never hands one CLI another CLI\'s conversation id', async () => {
  const root = makeProject({ 'EX-023': { type: 'Feature', status: 'Backlog', title: 'Next' } });
  priorSession(root, { cli: 'claude', cliSessionId: 'claude-uuid', startedAt: '2026-10-02T08:00:00.000Z', items: ['EX-016'] });
  const tmux = fakeTmux();
  const r = await postOn('codex', root, tmux, { itemId: 'EX-023' }, '/draft/start', () => { throw new Error('must not look up'); });
  assert.equal(r.body.mode, 'fresh');
  assert.doesNotMatch(launchLine(tmux), /claude-uuid/);
});

test('End draft reads the codex id back and stores it', async () => {
  const root = makeProject({ 'EX-024': { type: 'Feature', status: 'Drafted', title: 'Done' } });
  priorSession(root, { cli: 'codex', startedAt: '2026-10-02T08:00:00.000Z', items: ['EX-024'], openingItemId: 'EX-024' });
  const r = await postOn('codex', root, fakeTmux({ livePid: null }), {}, '/draft/end', () => 'cx-9');
  assert.equal(r.body.resumable, true);
  const saved = JSON.parse(fs.readFileSync(path.join(root, '.build-studio', 'draft-state.json'), 'utf8'));
  assert.equal(saved.session.cliSessionId, 'cx-9');
});
