'use strict';

// Tests for the `bugfix` workflow type in the execution engine (workflow.js).
// Two layers:
//   1. Pure helper unit tests — validation, role resolution, task synthesis,
//      step-sequence routing. No I/O, no router.
//   2. Router integration tests — mount createWorkflowRouter over a fixture git
//      repo and drive /workflow/start + /workflow/cancel to verify the status
//      flip, run branch, step dict, and synthetic plan land as designed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { execFileSync } = require('child_process');

const {
  DEFAULT_BUGFIX_STEPS,
  bugfixDisciplineBlock,
  bugfixSequence,
  stepSequence,
  nextStepInSequence,
  validateBugfixStart,
  resolveBuilderRole,
  buildBugfixTask,
  createWorkflowRouter,
} = require('./workflow');
const { DEFAULTS, loadConfig } = require('../config');
const { createStateManager } = require('../state');
const { readItem } = require('../backlog');

// ─── 1. Pure helpers ─────────────────────────────────────────────────────────

test('validateBugfixStart: accepts a Bug in Backlog or Blocked', () => {
  assert.equal(validateBugfixStart({ type: 'Bug', status: 'Backlog' }, 'LS-1'), null);
  assert.equal(validateBugfixStart({ type: 'Bug', status: 'Blocked' }, 'LS-1'), null);
});

test('validateBugfixStart: rejects Feature and Task, message points at PRD flow', () => {
  const feat = validateBugfixStart({ type: 'Feature', status: 'Backlog' }, 'LS-2');
  assert.equal(feat.status, 400);
  assert.match(feat.error, /Bugs only/);
  assert.match(feat.error, /PRD flow/);
  assert.match(feat.error, /LS-2 is a Feature/);

  const task = validateBugfixStart({ type: 'Task', status: 'Backlog' }, 'LS-3');
  assert.equal(task.status, 400);
  assert.match(task.error, /PRD flow/);
  assert.match(task.error, /LS-3 is a Task/);
});

test('validateBugfixStart: rejects wrong status (Fixing / Done / other)', () => {
  const fixing = validateBugfixStart({ type: 'Bug', status: 'Fixing' }, 'LS-4');
  assert.equal(fixing.status, 409);
  assert.match(fixing.error, /already happened or is in flight/);

  const done = validateBugfixStart({ type: 'Bug', status: 'Done' }, 'LS-5');
  assert.equal(done.status, 409);
  assert.match(done.error, /already fixed/);

  const drafted = validateBugfixStart({ type: 'Bug', status: 'Drafted' }, 'LS-6');
  assert.equal(drafted.status, 409);
  assert.match(drafted.error, /Backlog or Blocked/);
});

test('validateBugfixStart: rejects unknown id (null item) with 404', () => {
  const missing = validateBugfixStart(null, 'LS-999');
  assert.equal(missing.status, 404);
  assert.match(missing.error, /not found/);
});

test('resolveBuilderRole: honors frontmatter role override by name or skill', () => {
  const config = {
    roles: {
      execution: [
        { role: 'Backend Dev', skill: 'backend_dev' },
        { role: 'Frontend Dev', skill: 'frontend_dev' },
      ],
      review: [], standalone: [],
    },
  };
  // By role name (case-insensitive)
  assert.equal(resolveBuilderRole(config, { role: 'frontend dev' }).role, 'Frontend Dev');
  // By skill
  assert.equal(resolveBuilderRole(config, { role: 'frontend_dev' }).role, 'Frontend Dev');
});

test('resolveBuilderRole: falls back to the first execution role (solo builder)', () => {
  const config = {
    roles: {
      execution: [
        { role: 'Backend Dev', skill: 'backend_dev' },
        { role: 'Frontend Dev', skill: 'frontend_dev' },
      ],
      review: [], standalone: [],
    },
  };
  // No frontmatter role → first execution entry
  assert.equal(resolveBuilderRole(config, {}).role, 'Backend Dev');
  // Unresolvable frontmatter role → first execution entry
  assert.equal(resolveBuilderRole(config, { role: 'Nonexistent Role' }).role, 'Backend Dev');
});

test('buildBugfixTask: name, resolved role, body + discipline block', () => {
  const item = { title: 'Crash on empty save', body: 'The Save button throws on an empty note.' };
  const role = { role: 'Fullstack Dev', skill: 'fullstack_dev' };
  const task = buildBugfixTask('LS-029', item, role);

  assert.equal(task.role, 'Fullstack Dev');
  assert.equal(task.name, 'Fix LS-029 — Crash on empty save');
  // Bug body precedes the discipline block.
  assert.match(task.description, /The Save button throws on an empty note\./);
  assert.match(task.description, /## BUG-FIX DISCIPLINE — REPRO TEST FIRST/);
  assert.match(task.description, /failing regression test/);
  // The <ID> placeholder is substituted with the real id.
  assert.match(task.description, /its connection to LS-029 is obvious/);
  assert.match(task.description, /FIX-REPORT format/);
});

test('bugfixDisciplineBlock: substitutes the id and stays verbatim otherwise', () => {
  const block = bugfixDisciplineBlock('AB-7');
  assert.match(block, /connection to AB-7 is obvious/);
  assert.match(block, /^## BUG-FIX DISCIPLINE — REPRO TEST FIRST/);
});

test('bugfixSequence: default sequence, config override', () => {
  assert.deepEqual(bugfixSequence({}), DEFAULT_BUGFIX_STEPS);
  assert.deepEqual(bugfixSequence({ workflow: {} }), DEFAULT_BUGFIX_STEPS);
  assert.deepEqual(
    bugfixSequence({ workflow: { bugfix: ['task_execution', 'merge_to_main'] } }),
    ['task_execution', 'merge_to_main']
  );
  // Default sequence is the one the design specifies.
  assert.deepEqual(DEFAULT_BUGFIX_STEPS,
    ['task_execution', 'qa_validation', 'code_review', 'merge_to_main', 'capture_learnings']);
});

test('stepSequence / nextStepInSequence: bugfix advances by its own dict order', () => {
  const wf = { type: 'bugfix' };
  const config = { workflow: { execution: ['qa_tests', 'planning', 'task_execution'] } };
  // bugfix ignores config.workflow.execution
  assert.deepEqual(stepSequence(wf, config), DEFAULT_BUGFIX_STEPS);
  assert.equal(nextStepInSequence(wf, config, 'task_execution'), 'qa_validation');
  assert.equal(nextStepInSequence(wf, config, 'qa_validation'), 'code_review');
  assert.equal(nextStepInSequence(wf, config, 'code_review'), 'merge_to_main');
  assert.equal(nextStepInSequence(wf, config, 'merge_to_main'), 'capture_learnings');
  assert.equal(nextStepInSequence(wf, config, 'capture_learnings'), null);
  // Execution still uses the execution list — behavior unchanged.
  assert.deepEqual(stepSequence({ type: 'execution' }, config), ['qa_tests', 'planning', 'task_execution']);
  assert.equal(nextStepInSequence({ type: 'execution' }, config, 'qa_tests'), 'planning');
});

// ─── 2. Config defaults ──────────────────────────────────────────────────────

test('config DEFAULTS include bugfix.auto_merge === false', () => {
  assert.equal(DEFAULTS.bugfix.auto_merge, false);
});

test('loadConfig deep-merges bugfix.auto_merge (default false, override true)', () => {
  const noOverride = makeFixtureRepo();
  try {
    const cfg = loadConfig(noOverride.root);
    assert.equal(cfg.bugfix.auto_merge, false);
  } finally { noOverride.clean(); }

  const withOverride = makeFixtureRepo({ autoMerge: true });
  try {
    const cfg = loadConfig(withOverride.root);
    assert.equal(cfg.bugfix.auto_merge, true);
  } finally { withOverride.clean(); }
});

// ─── 3. Router integration (start + cancel) ──────────────────────────────────

test('start bugfix: flips Fixing, creates fix/<id>, builds steps + single-task plan', async () => {
  const fx = makeFixtureRepo();
  const srv = await mountRouter(fx.root);
  try {
    const res = await srv.post('/api/workflow/start', { type: 'bugfix', input: 'LS-001' });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    // Status flipped to Fixing (working tree)
    const bug = readItem(fx.root, './docs', 'LS-001');
    assert.equal(bug.status, 'Fixing');

    // Run branch fix/ls-001 created
    const branches = execFileSync('git', ['branch', '--list', 'fix/ls-001'], { cwd: fx.root, encoding: 'utf8' });
    assert.match(branches, /fix\/ls-001/);

    // Steps dict = default bugfix sequence; entry step is task_execution
    const wf = srv.state.loadWorkflow();
    assert.deepEqual(Object.keys(wf.steps), DEFAULT_BUGFIX_STEPS);
    assert.equal(wf.currentStep, 'task_execution');
    assert.equal(wf.type, 'bugfix');
    assert.equal(wf.itemId, 'LS-001');
    assert.equal(wf.branch, 'fix/ls-001');
    assert.equal(wf.reviewBranch, 'fix/ls-001');
    // wf.prdPath points at the bug file (spec)
    assert.equal(wf.prdPath, 'docs/backlog/LS-001.md');

    // Synthetic single-task plan with resolved role + discipline block
    assert.equal(wf.taskPlan.tasks.length, 1);
    const task = wf.taskPlan.tasks[0];
    assert.equal(task.role, 'Fullstack Dev'); // solo default (only execution role)
    assert.match(task.name, /^Fix LS-001 — /);
    assert.match(task.description, /## BUG-FIX DISCIPLINE — REPRO TEST FIRST/);
    assert.match(task.description, /its connection to LS-001 is obvious/);

    // taskExecution initialized like the execution path
    assert.equal(wf.taskExecution.currentTaskIndex, 0);
    assert.equal(wf.taskExecution.taskStates['0'].status, 'pending');
  } finally {
    await srv.close();
    fx.clean();
  }
});

test('start bugfix: honors frontmatter role override', async () => {
  const fx = makeFixtureRepo({ twoRoles: true, bugRole: 'frontend_dev' });
  const srv = await mountRouter(fx.root);
  try {
    const res = await srv.post('/api/workflow/start', { type: 'bugfix', input: 'LS-001' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const wf = srv.state.loadWorkflow();
    assert.equal(wf.taskPlan.tasks[0].role, 'Frontend Dev');
  } finally {
    await srv.close();
    fx.clean();
  }
});

test('start bugfix: rejects a Feature (400, PRD flow) and unknown id (404)', async () => {
  const fx = makeFixtureRepo({ extraFeature: true });
  const srv = await mountRouter(fx.root);
  try {
    const feat = await srv.post('/api/workflow/start', { type: 'bugfix', input: 'LS-002' });
    assert.equal(feat.status, 400);
    assert.match(feat.body.error, /PRD flow/);
    // No workflow started, no branch created
    assert.equal(srv.state.loadWorkflow(), null);

    const unknown = await srv.post('/api/workflow/start', { type: 'bugfix', input: 'LS-777' });
    assert.equal(unknown.status, 404);
    assert.match(unknown.body.error, /not found/);
  } finally {
    await srv.close();
    fx.clean();
  }
});

test('cancel bugfix: reverts Fixing → Backlog and clears the workflow', async () => {
  const fx = makeFixtureRepo();
  const srv = await mountRouter(fx.root);
  try {
    await srv.post('/api/workflow/start', { type: 'bugfix', input: 'LS-001' });
    assert.equal(readItem(fx.root, './docs', 'LS-001').status, 'Fixing');

    const res = await srv.post('/api/workflow/cancel', {});
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal(readItem(fx.root, './docs', 'LS-001').status, 'Backlog');
    assert.equal(srv.state.loadWorkflow(), null);
  } finally {
    await srv.close();
    fx.clean();
  }
});

test('GET /workflow exposes the resolved bugfix sequence for the hub timeline', async () => {
  const fx = makeFixtureRepo();
  const srv = await mountRouter(fx.root);
  try {
    const res = await srv.get('/api/workflow');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.projectWorkflowSteps.bugfix, DEFAULT_BUGFIX_STEPS);
    // The other flows are still exposed unchanged.
    assert.ok(Array.isArray(res.body.projectWorkflowSteps.execution));
  } finally {
    await srv.close();
    fx.clean();
  }
});

// ─── 4. Pre-merge scan wiring (bugfix-only LLM + hygiene gates) ───────────────

test('bugfix merge: LLM scan blocks a regression test with a real LLM API URL', async () => {
  const fx = makeFixtureRepo();
  const srv = await mountRouter(fx.root);
  try {
    stageBugfixAtMerge(fx, srv, 'src/regression/ls-001.test.js',
      `test('rejects empty', () => {\n  const url = 'https://api.anthropic.com/v1/messages';\n  expect(url).toBeTruthy();\n});\n`);
    const mainBefore = gitRev(fx.root, 'main');

    const res = await srv.post('/api/workflow/advance', {});
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.ok((res.body.violations || []).some(v => /ls-001\.test\.js/.test(v)), JSON.stringify(res.body));

    // Merge blocked — step errored, still on merge_to_main, main untouched.
    const wf = srv.state.loadWorkflow();
    assert.equal(wf.currentStep, 'merge_to_main');
    assert.equal(wf.steps.merge_to_main.status, 'error');
    assert.equal(gitRev(fx.root, 'main'), mainBefore);
  } finally {
    await srv.close();
    fx.clean();
  }
});

test('bugfix merge: @llm-url-fixture waiver passes the scan and the merge proceeds', async () => {
  const fx = makeFixtureRepo();
  const srv = await mountRouter(fx.root);
  try {
    stageBugfixAtMerge(fx, srv, 'src/regression/ls-001.test.js',
      `// @llm-url-fixture — asserts the endpoint is REJECTED by the guard, never called\n` +
      `test('rejects prod endpoint', () => {\n  const url = 'https://api.anthropic.com/v1/messages';\n  expect(() => guard(url)).toThrow();\n});\n`);

    const res = await srv.post('/api/workflow/advance', {});
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const wf = srv.state.loadWorkflow();
    assert.equal(wf.steps.merge_to_main.status, 'completed');
    assert.equal(wf.currentStep, 'capture_learnings');
    // Bug finalized: Done + fixed_in stamped with the merge sha.
    const bug = readItem(fx.root, './docs', 'LS-001');
    assert.equal(bug.status, 'Done');
    assert.match(String(bug.fixed_in || ''), /^[0-9a-f]{7,40}$/);
  } finally {
    await srv.close();
    fx.clean();
  }
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

function gitRev(root, ref) {
  return execFileSync('git', ['rev-parse', ref], { cwd: root, encoding: 'utf8' }).trim();
}

// Put the fixture repo into the state a bugfix run is in when it reaches
// merge_to_main: a committed fix/ls-001 branch (carrying `testRelPath`) and a
// persisted workflow at currentStep=merge_to_main.
function stageBugfixAtMerge(fx, srv, testRelPath, testContent) {
  execFileSync('git', ['checkout', '-q', '-b', 'fix/ls-001'], { cwd: fx.root });
  const abs = path.join(fx.root, testRelPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, testContent);
  execFileSync('git', ['add', '-A'], { cwd: fx.root });
  execFileSync('git', ['commit', '-q', '-m', 'fix: add LS-001 regression test'], { cwd: fx.root });

  srv.state.saveWorkflow({
    id: 'bugfix-merge-test', type: 'bugfix', input: 'LS-001', itemId: 'LS-001',
    prdPath: 'docs/backlog/LS-001.md', currentStep: 'merge_to_main',
    branch: 'fix/ls-001', defaultBranch: 'main', reviewBranch: 'fix/ls-001',
    round: 1, feedback: [], sessionName: 'wf-merge-test',
    steps: {
      task_execution: { status: 'completed', agents: [] },
      qa_validation: { status: 'completed', agents: [] },
      code_review: { status: 'completed', agents: [] },
      merge_to_main: { status: 'pending' },
      capture_learnings: { status: 'pending', agents: [] },
    },
    taskExecution: { currentTaskIndex: 0, taskStates: { '0': { status: 'done', agents: [] } } },
  });
}

function makeFixtureRepo(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bugfix-test-'));

  const executionRoles = opts.twoRoles
    ? [
        { role: 'Backend Dev', skill: 'backend_dev', branch_prefix: 'be' },
        { role: 'Frontend Dev', skill: 'frontend_dev', branch_prefix: 'fe' },
      ]
    : [{ role: 'Fullstack Dev', skill: 'fullstack_dev', branch_prefix: 'fs' }];

  const config = {
    name: 'bugfix-fixture',
    port: 5199,
    docs_path: './docs',
    roles: { execution: executionRoles, review: [], standalone: [] },
    ...(opts.autoMerge ? { bugfix: { auto_merge: true } } : {}),
  };

  const bugRoleLine = opts.bugRole ? `role: ${opts.bugRole}\n` : '';
  const files = {
    '.build-studio/config.yaml': toYaml(config),
    '.gitignore': [
      '.build-studio/workflow-state.json',
      '.build-studio/run-state.json',
      '.build-studio/snapshots/',
      'docs/agent-status.json',
      '',
    ].join('\n'),
    'docs/backlog/LS-001.md':
      `---\nid: LS-001\ntitle: Crash on empty save\ntype: Bug\nstatus: Backlog\n${bugRoleLine}---\n\n` +
      `The Save button throws a null-pointer when the note body is empty.\n\n` +
      `## Steps to reproduce\n1. Open a new note\n2. Click Save without typing\n`,
    'docs/project-state.md':
      `# Project State\n\n<!-- BACKLOG-START -->\n\n### Release 0.1\n\n` +
      `- LS-001 — Crash on empty save  [Bug · Backlog]\n\n<!-- BACKLOG-END -->\n`,
  };

  if (opts.extraFeature) {
    files['docs/backlog/LS-002.md'] =
      `---\nid: LS-002\ntitle: Add dark mode\ntype: Feature\nstatus: Backlog\n---\n\nAdd a dark theme.\n`;
    files['docs/project-state.md'] =
      `# Project State\n\n<!-- BACKLOG-START -->\n\n### Release 0.1\n\n` +
      `- LS-001 — Crash on empty save  [Bug · Backlog]\n- LS-002 — Add dark mode  [Feature · Backlog]\n\n<!-- BACKLOG-END -->\n`;
  }

  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: root });
  execFileSync('git', ['branch', '-M', 'main'], { cwd: root });

  return { root, clean: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} } };
}

// Minimal YAML emitter for the flat fixture config (avoids a js-yaml dep here).
function toYaml(config) {
  const lines = [
    `name: ${config.name}`,
    `port: ${config.port}`,
    `docs_path: ${config.docs_path}`,
    'roles:',
    '  execution:',
  ];
  for (const r of config.roles.execution) {
    lines.push(`    - role: ${r.role}`);
    lines.push(`      skill: ${r.skill}`);
    lines.push(`      branch_prefix: ${r.branch_prefix}`);
  }
  lines.push('  review: []');
  lines.push('  standalone: []');
  if (config.bugfix) {
    lines.push('bugfix:');
    lines.push(`  auto_merge: ${config.bugfix.auto_merge}`);
  }
  return lines.join('\n') + '\n';
}

async function mountRouter(root) {
  const config = loadConfig(root);
  const state = createStateManager(config, () => {});
  const gitOps = {
    branchExists: () => false, removeWorktree: () => {}, deleteBranch: () => {},
    commitsAhead: () => 0, mergeBranch: () => {}, abortMerge: () => {},
    createBranchFromMain: () => {},
  };
  const tmuxOps = { killSessionAndDevPorts: () => {}, killWindowAndChildren: () => {} };
  const app = express();
  app.use(express.json());
  app.use('/api', createWorkflowRouter(config, state, gitOps, tmuxOps, () => {}));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const send = (method, urlPath, body) => new Promise((resolve, reject) => {
    const hasBody = body !== undefined;
    const data = hasBody ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      { hostname: '127.0.0.1', port, path: urlPath, method,
        headers: hasBody ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let parsed = {};
          try { parsed = raw ? JSON.parse(raw) : {}; } catch { parsed = { raw }; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (hasBody) req.write(data);
    req.end();
  });

  return {
    post: (urlPath, body) => send('POST', urlPath, body || {}),
    get: (urlPath) => send('GET', urlPath),
    state, config, close: () => new Promise((r) => server.close(r)),
  };
}
