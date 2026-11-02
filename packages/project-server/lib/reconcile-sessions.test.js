'use strict';

// The reconcile track's interactive steps (intent_interview, owner_decision),
// items filed on the integration branch, and the keep-out block.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const backlog = require('./backlog');
const tracks = require('./reconcile-track');
const sessions = require('./reconcile-sessions');
const { resolveAgentTarget } = require('./api/terminal');

function fakeTmux() {
  const calls = [];
  return {
    calls,
    ensureWindow: (s, w) => { calls.push(['ensureWindow', s, w]); return `${s}:${w}`; },
    sendKeys: (t, cmd) => { calls.push(['sendKeys', t, cmd]); },
    pipePaneToLog: () => {},
    killWindowAndChildren: (t) => { calls.push(['kill', t]); },
    panePid: () => null,
    hasLiveDescendant: () => false,
  };
}

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-sessions-'));
  return {
    root,
    config: { projectRoot: root, name: 'Example App', port: 3999, logsPath: path.join(root, 'tmp', '.logs'), cli: { default: 'claude', groups: {} }, step_groups: null },
  };
}

function aTrack(root, extra = {}) {
  const t = {
    id: 'EX-004',
    status: 'open',
    createdAt: '2026-11-02T00:00:00.000Z',
    record: 'docs/backlog/EX-004.md',
    source: { path: '/src/clone', branch: 'design/x', pin: 'refs/build-studio/reconcile/design-x-abc/source', sha: 'abc123' },
    floor: { EX: 3 },
    currentStep: 'intent_interview',
    steps: Object.fromEntries(tracks.STEPS.map((s) => [s, { status: 'pending' }])),
    ...extra,
  };
  tracks.saveTrack(root, t);
  return t;
}

test('the interview runs in the project checkout, names its skill, the record and the keep-out block', () => {
  const { root, config } = project();
  try {
    const t = aTrack(root);
    const spec = sessions.specFor(config, t, 'intent_interview');
    assert.equal(spec.cwd, root);
    assert.equal(spec.window, 'rc-EX-004-interview');
    assert.equal(spec.sessionName, 'reconcile-Example-App');
    assert.match(spec.prompt, /`reconcile_interview` skill/);
    assert.match(spec.prompt, /INTERACTIVE/);
    assert.ok(spec.prompt.includes('docs/backlog/EX-004.md'));
    assert.match(spec.prompt, /reconcile-keep-out/);
    assert.match(spec.prompt, /Never write there/);
    assert.ok(spec.prompt.includes(spec.marker));
    assert.ok(spec.promptFile.startsWith(tracks.trackDir(root, 'EX-004')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the decisions session needs the worktree, and gives the items endpoint', () => {
  const { root, config } = project();
  try {
    const t = aTrack(root);
    assert.throws(() => sessions.specFor(config, t, 'owner_decision'), /needs the track's worktree/);
    const withWt = { ...t, worktree: '/wt', branch: 'reconcile/EX-004' };
    const spec = sessions.specFor(config, withWt, 'owner_decision');
    assert.equal(spec.cwd, '/wt');
    assert.match(spec.prompt, /`reconcile_decisions` skill/);
    assert.ok(spec.prompt.includes('http://localhost:3999/api/reconcile/EX-004/items'));
    assert.throws(() => sessions.specFor(config, t, 'team_review'), /not an interactive reconcile step/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('launch stores the session on the step; finish commits and hands over to integration', async () => {
  const { root, config } = project();
  try {
    fs.mkdirSync(path.join(root, 'docs/backlog'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/backlog/EX-004.md'), 'record\n');
    fs.writeFileSync(path.join(root, 'docs/decisions.md'), 'log\n');
    const tmux = fakeTmux();
    let t = sessions.launch({ config, tmuxOps: tmux, track: aTrack(root), stepKey: 'intent_interview' });
    assert.equal(t.steps.intent_interview.status, 'running');
    assert.equal(t.steps.intent_interview.session.window, 'rc-EX-004-interview');
    assert.deepEqual(tmux.calls[0], ['ensureWindow', 'reconcile-Example-App', 'rc-EX-004-interview']);
    assert.equal(tracks.loadTrack(root, 'EX-004').steps.intent_interview.status, 'running');

    const commits = [];
    t = await sessions.finish({ config, tmuxOps: tmux, track: t, stepKey: 'intent_interview' }, {
      commit: async (cwd, paths, msg) => { commits.push({ cwd, paths, msg }); return { committed: true }; },
    });
    assert.equal(t.steps.intent_interview.status, 'done');
    assert.equal(t.currentStep, 'integration');
    assert.equal(commits[0].cwd, root);
    assert.deepEqual(commits[0].paths, ['docs/backlog/EX-004.md', 'docs/decisions.md']);
    assert.match(commits[0].msg, /record the reconcile interview/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('parseKeepOut reads the block and ignores comments and blanks', () => {
  const rec = 'x\n\n```reconcile-keep-out\nPULS-HANDOVER.md\n# the old state\ndocs/project-state.md\n\n```\nmore';
  assert.deepEqual(sessions.parseKeepOut(rec), ['PULS-HANDOVER.md', 'docs/project-state.md']);
  assert.deepEqual(sessions.parseKeepOut('no block here'), []);
  assert.deepEqual(sessions.parseKeepOut('```reconcile-keep-out\n```'), []);
});

test('an item filed on the branch clears both sides, and raises the floor for the project', async () => {
  const { root } = project();
  try {
    const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' });
    const item = (id) => `---\nid: ${id}\ntitle: ${id}\ntype: Task\nstatus: Backlog\nrelease: Now\ncreated: '2026-11-01'\nprd: null\ndepends_on: []\n---\n\nB.\n`;
    const index = (ids) => `# Backlog\n\n${backlog.BACKLOG_START}\n\n### Now\n${ids.map((i) => `- ${i} — ${i}  [Task · Backlog]`).join('\n')}\n\n${backlog.BACKLOG_END}\n`;
    g(root, 'init', '-q', '-b', 'main');
    g(root, 'config', 'user.email', 't@example.com');
    g(root, 'config', 'user.name', 't');
    fs.writeFileSync(path.join(root, '.gitignore'), 'tmp/\n');
    fs.mkdirSync(path.join(root, 'docs/backlog'), { recursive: true });
    for (const id of ['EX-001', 'EX-002']) fs.writeFileSync(path.join(root, `docs/backlog/${id}.md`), item(id));
    fs.writeFileSync(path.join(root, 'docs/backlog-index.md'), index(['EX-001', 'EX-002']));
    g(root, 'add', '-A');
    g(root, 'commit', '-q', '-m', 'init');
    // The integration branch carries the source's EX-003..EX-005.
    const wt = path.join(root, 'tmp', '.worktrees', 'reconcile-EX-006');
    g(root, 'worktree', 'add', '-q', '-b', 'reconcile/EX-006', wt);
    for (const id of ['EX-003', 'EX-004', 'EX-005']) fs.writeFileSync(path.join(wt, `docs/backlog/${id}.md`), item(id));
    fs.writeFileSync(path.join(wt, 'docs/backlog-index.md'), index(['EX-001', 'EX-002', 'EX-003', 'EX-004', 'EX-005']));
    g(wt, 'add', '-A');
    g(wt, 'commit', '-q', '-m', 'import');
    // Meanwhile main filed EX-006 (the record) and EX-007, both above the floor.
    for (const id of ['EX-006', 'EX-007']) fs.writeFileSync(path.join(root, `docs/backlog/${id}.md`), item(id));
    aTrack(root, { id: 'EX-006', record: 'docs/backlog/EX-006.md', floor: { EX: 5 }, worktree: wt, branch: 'reconcile/EX-006' });

    const created = await tracks.fileItemOnBranch({ projectRoot: root, id: 'EX-006', item: { title: 'Follow-up', type: 'Task', body: 'x', release: 'Now' } });
    assert.equal(created.id, 'EX-008');
    assert.equal(created.commit.committed, true);
    assert.ok(fs.existsSync(path.join(wt, 'docs/backlog/EX-008.md')));
    assert.equal(fs.existsSync(path.join(root, 'docs/backlog/EX-008.md')), false);
    assert.equal(tracks.loadTrack(root, 'EX-006').floor.EX, 8);
    assert.equal(backlog.nextItemId(root, 'docs', 'EX'), 'EX-009');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the terminal resolves a track\'s session window', () => {
  const { root } = project();
  try {
    aTrack(root, { steps: { intent_interview: { status: 'running', session: { sessionName: 'reconcile-Example-App', window: 'rc-EX-004-interview' } } } });
    const state = { loadWorkflow: () => null, loadRun: () => null };
    assert.deepEqual(resolveAgentTarget(state, 'rc-EX-004-interview', null, root), { sessionName: 'reconcile-Example-App', window: 'rc-EX-004-interview' });
    assert.equal(resolveAgentTarget(state, 'rc-EX-004-decisions', null, root), null);
    assert.equal(resolveAgentTarget(state, 'rc-EX-004-interview', null, null), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
