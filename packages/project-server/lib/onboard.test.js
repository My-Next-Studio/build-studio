'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const yaml = require('js-yaml');
const { execFileSync } = require('child_process');
const { onboardProject, previewOnboard } = require('./onboard');

// ─── Fixture builders ───────────────────────────────────────────────────────

function makeRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  return root;
}

function clean(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

const EXAMPLE_APP_SHAPE = {
  'package.json': JSON.stringify({
    name: 'fixture',
    scripts: { dev: 'vite', build: 'tsc -b && vite build' },
    dependencies: { react: '^18' },
    devDependencies: { vite: '^5' },
  }),
  'vite.config.ts': '',
  'README.md': '# Fixture\nA tiny single-PRD MVP.',
  'PRD.md': '# PRD\nThe vision.',
  'DESIGN.md': '# Design',
};

// ─── Validation: refusals ───────────────────────────────────────────────────

test('onboardProject: refuses when path does not exist', async () => {
  await assert.rejects(
    onboardProject('/tmp/this-path-does-not-exist-xyz', { name: 'x', port: 9999 }),
    /does not exist/i
  );
});

test('onboardProject: refuses when path is not a git repo', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-non-git-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{}');
  try {
    await assert.rejects(
      onboardProject(root, { name: 'x', port: 9999 }),
      /not.*git repo/i
    );
  } finally { clean(root); }
});

test('onboardProject: refuses when no recognizable project file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onboard-empty-'));
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'README.md'), '');
  try {
    await assert.rejects(
      onboardProject(root, { name: 'x', port: 9999 }),
      /No recognizable project file/i
    );
  } finally { clean(root); }
});

test('onboardProject: refuses when .build-studio/config.yaml already exists (409 shape)', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  fs.mkdirSync(path.join(root, '.build-studio'));
  fs.writeFileSync(path.join(root, '.build-studio', 'config.yaml'), 'name: existing\n');
  try {
    await assert.rejects(
      onboardProject(root, { name: 'x', port: 9999 }),
      (e) => e.code === 'CONFIG_EXISTS' && /already initialized/i.test(e.message)
    );
  } finally { clean(root); }
});

test('onboardProject: refuses monorepo shape (PRD-001 v1 doesn\'t support)', async () => {
  const root = makeRepo({
    'package.json': JSON.stringify({ name: 'monorepo', workspaces: ['apps/*'] }),
    'apps/web/package.json': '{}',
    'apps/api/package.json': '{}',
  });
  try {
    await assert.rejects(
      onboardProject(root, { name: 'x', port: 9999 }),
      (e) => e.code === 'MONOREPO_NOT_SUPPORTED'
    );
  } finally { clean(root); }
});

// ─── Successful onboarding (example-app shape) ───────────────────────────────

test('onboardProject: writes config.yaml with detected values', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  try {
    const result = await onboardProject(root, { name: 'desk-fixture', port: 3099 });
    const cfg = yaml.load(fs.readFileSync(path.join(root, '.build-studio', 'config.yaml'), 'utf8'));
    assert.equal(cfg.name, 'desk-fixture');
    assert.equal(cfg.port, 3099);
    assert.equal(cfg.preset, 'static-site');
    assert.equal(cfg.dev_commands.length, 1);
    assert.equal(cfg.dev_commands[0].cmd, 'npm run dev');
    assert.equal(cfg.dev_commands[0].type, 'vite');
    assert.equal(result.preset, 'static-site');
  } finally { clean(root); }
});

test('onboardProject: writes .claude/commands templates', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  try {
    await onboardProject(root, { name: 'desk', port: 3099 });
    const cmds = fs.readdirSync(path.join(root, '.claude', 'commands'));
    assert.ok(cmds.length >= 10, 'should write all role command templates');
    assert.ok(cmds.includes('pm.md'));
    assert.ok(cmds.includes('qa.md'));
  } finally { clean(root); }
});

test('onboardProject: writes inventory.json with required schema fields', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  try {
    await onboardProject(root, { name: 'desk', port: 3099 });
    const inv = JSON.parse(fs.readFileSync(path.join(root, 'docs', 'onboarding', 'inventory.json'), 'utf8'));
    assert.ok(inv.detectedAt);
    assert.equal(inv.preset, 'static-site');
    assert.ok(inv.deployment);
    assert.ok(Array.isArray(inv.devCommands));
    assert.ok(Array.isArray(inv.existingDocs));
    assert.ok(typeof inv.claudeMdPresent === 'boolean');
    assert.ok(typeof inv.agentsMdPresent === 'boolean');
    assert.ok(typeof inv.specsDirPresent === 'boolean');
    assert.equal(inv.shape, 'single-prd-mvp');
  } finally { clean(root); }
});

test('onboardProject: creates empty workflow scaffolding (prds, learnings, tmp) with .gitkeep', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  try {
    await onboardProject(root, { name: 'desk', port: 3099 });
    assert.ok(fs.existsSync(path.join(root, 'docs', 'prds', '.gitkeep')));
    assert.ok(fs.existsSync(path.join(root, 'docs', 'learnings', 'workflow', '.gitkeep')));
    assert.ok(fs.existsSync(path.join(root, 'tmp')));
  } finally { clean(root); }
});

// ─── Files explicitly NOT created ──────────────────────────────────────────

test('onboardProject: does NOT create vision.md or project-state.md (workflow outputs)', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  try {
    await onboardProject(root, { name: 'desk', port: 3099 });
    assert.ok(!fs.existsSync(path.join(root, 'docs', 'vision.md')), 'vision.md must not be scaffolded');
    assert.ok(!fs.existsSync(path.join(root, 'docs', 'project-state.md')), 'project-state.md must not be scaffolded');
    assert.ok(!fs.existsSync(path.join(root, 'docs', 'inputs')), 'docs/inputs/ must not be created');
    assert.ok(!fs.existsSync(path.join(root, 'docs', 'adrs')), 'docs/adrs/ must not be pre-created');
  } finally { clean(root); }
});

test('onboardProject: does NOT overwrite an existing CLAUDE.md', async () => {
  const root = makeRepo({ ...EXAMPLE_APP_SHAPE, 'CLAUDE.md': 'EXISTING CONTENT — do not touch' });
  try {
    await onboardProject(root, { name: 'desk', port: 3099 });
    const after = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
    assert.equal(after, 'EXISTING CONTENT — do not touch');
  } finally { clean(root); }
});

test('onboardProject: does NOT create CLAUDE.md when absent (workflow synthesizes it)', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  try {
    await onboardProject(root, { name: 'desk', port: 3099 });
    assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')), 'no CLAUDE.md written by button — workflow handles it');
  } finally { clean(root); }
});

// ─── Per-file no-overwrite for .claude/commands/ ───────────────────────────

test('onboardProject: skips an existing .claude/commands/<role>.md file', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  fs.mkdirSync(path.join(root, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'commands', 'pm.md'), 'CUSTOM PM ROLE');
  try {
    const result = await onboardProject(root, { name: 'desk', port: 3099 });
    const after = fs.readFileSync(path.join(root, '.claude', 'commands', 'pm.md'), 'utf8');
    assert.equal(after, 'CUSTOM PM ROLE', 'existing pm.md must be preserved');
    // Other roles should still be written.
    assert.ok(fs.existsSync(path.join(root, '.claude', 'commands', 'qa.md')));
    // Result should report the skip for transparency.
    assert.ok(Array.isArray(result.skipped), 'result must report skipped files');
    assert.ok(result.skipped.includes('.claude/commands/pm.md'));
  } finally { clean(root); }
});

// ─── Git state untouched ────────────────────────────────────────────────────

test('onboardProject: makes no git commits and no git stages', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  // Capture pre-state
  const headBefore = (() => {
    try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
    catch { return 'EMPTY'; }
  })();
  try {
    await onboardProject(root, { name: 'desk', port: 3099 });
    const headAfter = (() => {
      try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
      catch { return 'EMPTY'; }
    })();
    assert.equal(headAfter, headBefore, 'no commits should have been made');
    // status --porcelain must show ONLY untracked entries (no staged ones).
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).toString();
    for (const line of status.split('\n').filter(Boolean)) {
      assert.match(line, /^\?\?/, `every changed file must be untracked, got: ${line}`);
    }
  } finally { clean(root); }
});

// ─── .gitignore patterns appended (regression test for example-app pilot) ──

test('onboardProject: appends build-studio runtime patterns to existing .gitignore', async () => {
  const root = makeRepo({ ...EXAMPLE_APP_SHAPE, '.gitignore': 'node_modules\ndist\n' });
  try {
    await onboardProject(root, { name: 'desk', port: 3099 });
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    assert.match(gi, /node_modules/, 'existing entries preserved');
    assert.match(gi, /dist/, 'existing entries preserved');
    assert.match(gi, /\.build-studio\/workflow-state\.json/);
    assert.match(gi, /\.build-studio\/snapshots\//);
    assert.match(gi, /docs\/agent-status\.json/);
    assert.match(gi, /^prompt-\*\.txt$/m);
    assert.match(gi, /^start-\*\.sh$/m);
    assert.match(gi, /\.claude\/scheduled_tasks\.lock/);
  } finally { clean(root); }
});

test('onboardProject: idempotent — re-adding patterns already present does not duplicate', async () => {
  const root = makeRepo({
    ...EXAMPLE_APP_SHAPE,
    '.gitignore': 'node_modules\n.build-studio/workflow-state.json\n.build-studio/snapshots/\ndocs/agent-status.json\nprompt-*.txt\nstart-*.sh\nstart.sh\nTASK.md\ntmp/\n.build-studio/run-state.json\n.build-studio/*.bak*\n.claude/scheduled_tasks.lock\n.claude/settings.local.json\n',
  });
  try {
    const result = await onboardProject(root, { name: 'desk', port: 3099 });
    assert.ok(result.skipped.some((s) => s.startsWith('.gitignore')), 'should report .gitignore as skipped when nothing to add');
    const gi = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    const occurrences = (gi.match(/\.build-studio\/workflow-state\.json/g) || []).length;
    assert.equal(occurrences, 1, 'pattern must appear exactly once even after re-onboarding');
  } finally { clean(root); }
});

// ─── previewOnboard (dry-run) ──────────────────────────────────────────────

test('previewOnboard: returns detected config without writing anything', async () => {
  const root = makeRepo(EXAMPLE_APP_SHAPE);
  try {
    const preview = await previewOnboard(root);
    assert.equal(preview.preset, 'static-site');
    assert.ok(preview.deployment);
    assert.ok(Array.isArray(preview.devCommands));
    // Nothing was written.
    assert.ok(!fs.existsSync(path.join(root, '.build-studio')), 'preview must not create config dir');
    assert.ok(!fs.existsSync(path.join(root, 'docs', 'onboarding')), 'preview must not create inventory');
  } finally { clean(root); }
});

test('previewOnboard: refuses with same shape errors as onboardProject', async () => {
  await assert.rejects(
    previewOnboard('/tmp/nope-this-does-not-exist'),
    /does not exist/i
  );
});
