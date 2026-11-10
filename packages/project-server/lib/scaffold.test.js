'use strict';

// New-project init on an empty folder and on an existing repository
// (lib/scaffold.js). Runs init in a child process with HOME pointed at a temp
// dir, because it seeds Claude folder trust in ~/.claude.json.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const SCAFFOLD = path.join(__dirname, 'scaffold.js');

function sandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-scaffold-'));
  const env = {
    ...process.env,
    HOME: tmp,
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  /** Call scaffold.js's `fn` in a child process; returns its result, or { error, code }. */
  const call = (fn, target, opts = {}) => {
    const script = `const s = require(${JSON.stringify(SCAFFOLD)});
      let out; try { out = s.${fn}(${JSON.stringify(target)}${fn === 'scaffoldProject' ? `, ${JSON.stringify(opts)}` : ''}); }
      catch (e) { out = { error: e.message, code: e.code }; }
      process.stdout.write('\\n@@' + JSON.stringify(out));`;
    const stdout = execFileSync(process.execPath, ['-e', script], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(stdout.slice(stdout.lastIndexOf('@@') + 2));
  };
  return { tmp, env, git, call, done: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

/** A repository like a project set up by hand before init: the brief committed, its own ignore rules. */
function existingProject(sb, { branch = 'main' } = {}) {
  const dir = path.join(sb.tmp, 'proj');
  fs.mkdirSync(path.join(dir, 'docs', 'inputs'), { recursive: true });
  sb.git(dir, 'init', '-q');
  sb.git(dir, 'symbolic-ref', 'HEAD', `refs/heads/${branch}`);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.DS_Store\n.env\n');
  fs.writeFileSync(path.join(dir, 'docs', 'inputs', 'Brief.md'), '# Brief\n');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Our own agent rules\n');
  fs.writeFileSync(path.join(dir, 'docs', 'vision.md'), '# Our vision\n');
  sb.git(dir, 'add', '-A');
  sb.git(dir, 'commit', '-q', '-m', 'docs: add inputs');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1\n'); // ignored by the project's own rules
  return dir;
}

test('an empty folder becomes a repository on main with one scaffolding commit', () => {
  const sb = sandbox();
  try {
    const target = path.join(sb.tmp, 'fresh');
    const r = sb.call('scaffoldProject', target, { name: 'fresh' });
    assert.ok(!r.error, r.error);
    assert.equal(sb.git(target, 'branch', '--show-current'), 'main');
    assert.equal(sb.git(target, 'log', '--format=%s'), 'chore: initial project scaffolding from build-studio');
    assert.equal(sb.git(target, 'status', '--porcelain'), '');
    for (const f of ['AGENTS.md', 'CLAUDE.md', '.gitignore', 'docs/vision.md', '.build-studio/config.yaml', '.claude/skills/draft_prd/SKILL.md']) {
      assert.ok(fs.existsSync(path.join(target, f)), f);
    }
    assert.match(fs.readFileSync(path.join(target, 'CLAUDE.md'), 'utf8'), /@AGENTS\.md/);
    assert.deepEqual(r.warnings, []);
  } finally { sb.done(); }
});

test('planScaffold lists what init would change in an existing repository, and writes nothing', () => {
  const sb = sandbox();
  try {
    const dir = existingProject(sb);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Rules we wrote\n');
    sb.git(dir, 'add', 'CLAUDE.md');
    sb.git(dir, 'commit', '-q', '-m', 'docs: claude rules');
    const plan = sb.call('planScaffold', dir);
    assert.equal(plan.existingRepo, true);
    assert.deepEqual(plan.dirty, []);
    const byPath = Object.fromEntries(plan.changes.map((c) => [c.path, c.action]));
    assert.equal(byPath['.gitignore'], 'merge');
    assert.equal(byPath['docs/vision.md'], undefined, 'the vision is kept, so it is not a change');
    assert.equal(byPath['AGENTS.md'], undefined, 'AGENTS.md is never overwritten');
    assert.ok(!fs.existsSync(path.join(dir, '.build-studio')), 'nothing written');
  } finally { sb.done(); }
});

test('a populated CLAUDE.md without AGENTS.md is reported as moved, not overwritten', () => {
  const sb = sandbox();
  try {
    const dir = existingProject(sb);
    fs.rmSync(path.join(dir, 'AGENTS.md'));
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# Rules we wrote\n');
    sb.git(dir, 'add', '-A');
    sb.git(dir, 'commit', '-q', '-m', 'docs: claude rules');
    const plan = sb.call('planScaffold', dir);
    assert.deepEqual(plan.changes.find((c) => c.path === 'CLAUDE.md').action, 'migrate');
    sb.call('scaffoldProject', dir, { name: 'proj' });
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# Rules we wrote\n');
    assert.match(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), /@AGENTS\.md/);
  } finally { sb.done(); }
});

test('init in an existing repository keeps the project\'s files and commits only its own', () => {
  const sb = sandbox();
  try {
    const dir = existingProject(sb, { branch: 'trunk' });
    const r = sb.call('scaffoldProject', dir, { name: 'proj' });
    assert.ok(!r.error, r.error);
    // The project's own documents are untouched.
    assert.equal(fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8'), '# Our own agent rules\n');
    assert.equal(fs.readFileSync(path.join(dir, 'docs', 'vision.md'), 'utf8'), '# Our vision\n');
    assert.ok(r.kept.includes(path.join('docs', 'vision.md')));
    // .gitignore keeps its lines and gains the template's.
    const ignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    assert.ok(ignore.startsWith('.DS_Store\n.env\n'), ignore);
    assert.match(ignore, /# Added by Build Studio init\n/);
    assert.match(ignore, /^node_modules\/$/m);
    assert.equal((ignore.match(/^\.DS_Store$/gm) || []).length, 1, 'no duplicate lines');
    // One new commit, holding only what init wrote; the ignored .env stays out.
    assert.equal(sb.git(dir, 'log', '--format=%s').split('\n')[0], 'chore: add Build Studio project scaffolding');
    assert.equal(sb.git(dir, 'ls-files', '.env'), '');
    const committed = sb.git(dir, 'show', '--name-only', '--format=', 'HEAD').split('\n');
    assert.ok(committed.includes('.build-studio/config.yaml'));
    assert.ok(committed.includes('CLAUDE.md'), 'the stub that imports the existing AGENTS.md');
    assert.ok(!committed.includes('docs/inputs/Brief.md'));
    assert.ok(!committed.includes('AGENTS.md'));
    assert.equal(sb.git(dir, 'status', '--porcelain'), '');
    // The branch is not renamed; the owner is told.
    assert.equal(sb.git(dir, 'branch', '--show-current'), 'trunk');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /on "trunk", not main/);
  } finally { sb.done(); }
});

test('a repository with uncommitted changes is refused before anything is written', () => {
  const sb = sandbox();
  try {
    const dir = existingProject(sb);
    fs.writeFileSync(path.join(dir, 'docs', 'inputs', 'Brief.md'), '# Brief, edited\n');
    const plan = sb.call('planScaffold', dir);
    assert.deepEqual(plan.dirty, [' M docs/inputs/Brief.md']);
    const r = sb.call('scaffoldProject', dir, { name: 'proj' });
    assert.equal(r.code, 'DIRTY_TREE');
    assert.ok(!fs.existsSync(path.join(dir, '.build-studio')));
  } finally { sb.done(); }
});

test('a Build Studio file that differs from the template is reported as overwritten', () => {
  const sb = sandbox();
  try {
    const dir = existingProject(sb);
    fs.mkdirSync(path.join(dir, '.claude', 'commands'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'commands', 'pm.md'), '# An old PM role\n');
    sb.git(dir, 'add', '-A');
    sb.git(dir, 'commit', '-q', '-m', 'chore: old role');
    const plan = sb.call('planScaffold', dir);
    const pm = plan.changes.find((c) => c.path === path.join('.claude', 'commands', 'pm.md'));
    assert.equal(pm && pm.action, 'overwrite');
  } finally { sb.done(); }
});
