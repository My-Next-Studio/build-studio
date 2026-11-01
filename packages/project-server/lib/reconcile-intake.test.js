'use strict';

// Intake for work built outside Build Studio: refuse an uncommitted source,
// pin the committed one, dry-run the merge, and report tier and id collisions
// (docs/plans/reconciliation-workflow.md).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { intake, renderMarkdown, classifyPath, suggestTier } = require('./reconcile-intake');

function write(root, rel, body) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), body);
}

/** A project on main, and a separate clone of it on a design branch. */
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-intake-'));
  const project = path.join(dir, 'project');
  const clone = path.join(dir, 'clone');
  fs.mkdirSync(project);
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' });
  g(project, 'init', '-q', '-b', 'main');
  g(project, 'config', 'user.email', 't@example.com');
  g(project, 'config', 'user.name', 't');
  write(project, 'docs/backlog/EX-001.md', '---\nid: EX-001\n---\n');
  write(project, 'docs/prds/PRD-001-start.md', '# PRD-001\n');
  write(project, 'app/Home.swift', 'struct Home {}\n');
  g(project, 'add', '-A');
  g(project, 'commit', '-q', '-m', 'init');
  g(dir, 'clone', '-q', project, clone);
  g(clone, 'config', 'user.email', 't@example.com');
  g(clone, 'config', 'user.name', 't');
  g(clone, 'checkout', '-q', '-b', 'design/new-home');
  return { dir, project, clone, g };
}

function commitAll(g, cwd, msg) {
  g(cwd, 'add', '-A');
  g(cwd, 'commit', '-q', '-m', msg);
}

test('refuses a source with modified or untracked files and fetches nothing', () => {
  const { dir, project, clone, g } = setup();
  try {
    write(clone, 'app/Home.swift', 'struct Home { let mascot = true }\n');
    write(clone, 'app/Mascot.swift', 'struct Mascot {}\n');
    const r = intake({ projectRoot: project, sourcePath: clone });
    assert.equal(r.refused, true);
    assert.deepEqual(r.status.modified.map((f) => f.path), ['app/Home.swift']);
    assert.deepEqual(r.status.untracked.map((f) => f.path), ['app/Mascot.swift']);
    assert.equal(g(project, 'for-each-ref', 'refs/build-studio').trim(), '');
    assert.match(renderMarkdown(r), /Intake refused[\s\S]*app\/Mascot\.swift/);

    commitAll(g, clone, 'mascot');
    assert.equal(intake({ projectRoot: project, sourcePath: clone }).refused, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pins the source in the project, and the pin survives the clone being deleted', () => {
  const { dir, project, clone, g } = setup();
  try {
    write(clone, 'app/Mascot.swift', 'struct Mascot {}\n');
    commitAll(g, clone, 'mascot');
    const sha = g(clone, 'rev-parse', 'HEAD').trim();
    const r = intake({ projectRoot: project, sourcePath: clone });
    assert.equal(r.id, 'design-new-home');
    assert.equal(r.source.sha, sha);
    assert.equal(r.source.branch, 'design/new-home');
    assert.equal(r.source.pin, 'refs/build-studio/reconcile/design-new-home/source');
    fs.rmSync(clone, { recursive: true, force: true });
    assert.equal(g(project, 'rev-parse', r.source.pin).trim(), sha);
    assert.equal(g(project, 'cat-file', '-t', sha).trim(), 'commit');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a pin for the same id must stay on the same commit', () => {
  const { dir, project, clone, g } = setup();
  try {
    write(clone, 'app/Mascot.swift', 'struct Mascot {}\n');
    commitAll(g, clone, 'mascot');
    intake({ projectRoot: project, sourcePath: clone });
    write(clone, 'app/Mascot.swift', 'struct Mascot { let v = 2 }\n');
    commitAll(g, clone, 'mascot v2');
    assert.throws(() => intake({ projectRoot: project, sourcePath: clone }), /new revision is a new intake/);
    assert.equal(intake({ projectRoot: project, sourcePath: clone, id: 'new-home-2' }).refused, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the dry-run merge lists conflicts and changes neither branch nor working tree', () => {
  const { dir, project, clone, g } = setup();
  try {
    write(clone, 'app/Home.swift', 'struct Home { let mascot = true }\n');
    commitAll(g, clone, 'mascot home');
    write(project, 'app/Home.swift', 'struct Home { let tabs = 3 }\n');
    commitAll(g, project, 'tabs home');
    const before = g(project, 'rev-parse', 'main').trim();
    const r = intake({ projectRoot: project, sourcePath: clone });
    assert.equal(r.merge.clean, false);
    assert.deepEqual(r.merge.conflicts, ['app/Home.swift']);
    assert.equal(r.target.commitsSinceBase, 1);
    assert.equal(g(project, 'rev-parse', 'main').trim(), before);
    assert.equal(g(project, 'status', '--porcelain'), '');
    assert.equal(fs.readFileSync(path.join(project, 'app/Home.swift'), 'utf8'), 'struct Home { let tabs = 3 }\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reports ids the source allocated, and the ones the target also allocated since', () => {
  const { dir, project, clone, g } = setup();
  try {
    write(clone, 'docs/backlog/EX-002.md', '---\nid: EX-002\ntitle: Mascot\n---\n');
    write(clone, 'docs/backlog/EX-003.md', '---\nid: EX-003\n---\n');
    write(clone, 'docs/prds/PRD-002-mascot.md', '# PRD-002\n');
    write(clone, 'docs/specs/PRD-001-validation.md', 'old PRD, new record\n');
    commitAll(g, clone, 'mascot docs');
    write(project, 'docs/backlog/EX-002.md', '---\nid: EX-002\ntitle: Something else\n---\n');
    commitAll(g, project, 'file EX-002 on main');
    const r = intake({ projectRoot: project, sourcePath: clone });
    assert.deepEqual(r.ids.added, ['EX-002', 'EX-003', 'PRD-002']);
    assert.deepEqual(r.ids.collisions, [{ id: 'EX-002', source: ['docs/backlog/EX-002.md'], target: ['docs/backlog/EX-002.md'] }]);
    assert.match(renderMarkdown(r), /Collisions[\s\S]*EX-002/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a ref already in the project needs no source path', () => {
  const { dir, project, g } = setup();
  try {
    g(project, 'checkout', '-q', '-b', 'design/copy');
    write(project, 'app/Localizable.xcstrings', '{}\n');
    commitAll(g, project, 'copy');
    g(project, 'checkout', '-q', 'main');
    const r = intake({ projectRoot: project, ref: 'design/copy' });
    assert.equal(r.source.path, null);
    assert.equal(r.risk.tier, 'light');
    assert.equal(r.merge.clean, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('binaries and large text files are listed with their size, large ones flagged', () => {
  const { dir, project, clone, g } = setup();
  try {
    fs.mkdirSync(path.join(clone, 'design'), { recursive: true });
    fs.writeFileSync(path.join(clone, 'design/scene.blend'), Buffer.alloc(2 * 1024 * 1024, 0));
    fs.writeFileSync(path.join(clone, 'design/still.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    fs.writeFileSync(path.join(clone, 'design/frames.svg'), 'x'.repeat(1024 * 1024 + 10));
    write(clone, 'app/Mascot.swift', 'struct Mascot {}\n');
    commitAll(g, clone, 'design files');
    const r = intake({ projectRoot: project, sourcePath: clone });
    assert.deepEqual(r.bulky.map((b) => b.path).sort(), ['design/frames.svg', 'design/scene.blend', 'design/still.png']);
    const blend = r.bulky.find((b) => b.path === 'design/scene.blend');
    assert.equal(blend.size, 2 * 1024 * 1024);
    assert.equal(blend.large, true);
    assert.equal(r.bulky.find((b) => b.path === 'design/still.png').large, false);
    assert.equal(r.bulky.find((b) => b.path === 'design/frames.svg').binary, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('classifyPath', () => {
  assert.deepEqual(classifyPath('.github/workflows/ios-tests.yml'), ['ci']);
  assert.deepEqual(classifyPath('ios/App/Features/Analytics/AnalyticsService.swift'), ['privacy']);
  assert.deepEqual(classifyPath('ios/App/Features/Monetization/PaywallView.swift'), ['payments']);
  assert.deepEqual(classifyPath('ios/App/App.entitlements'), ['signing']);
  assert.deepEqual(classifyPath('ios/AppTests/AnalyticsServiceTests.swift'), ['privacy', 'test']);
  assert.deepEqual(classifyPath('ios/App/Localizable.xcstrings'), ['copy']);
  assert.deepEqual(classifyPath('ios/App/Assets.xcassets/Mascot.imageset/walk.png'), ['asset']);
  assert.deepEqual(classifyPath('ios/App/Features/Rhythm/Views/DashboardView.swift'), ['code']);
  assert.deepEqual(classifyPath('ios/App/Features/Help/AuthorCredits.swift'), ['code']);
  assert.deepEqual(classifyPath('ios/App/Auth/LoginView.swift'), ['auth']);
  assert.deepEqual(classifyPath('package.json'), ['dependencies']);
  assert.deepEqual(classifyPath('db/migrations/003_add_rooms.sql'), ['migrations']);
  // Documentation never triggers a sensitive class, whatever it is about.
  assert.deepEqual(classifyPath('docs/adrs/ADR-020-ios-analytics.md'), ['docs']);
  assert.deepEqual(classifyPath('docs/ux/mascot/walk.png'), ['docs', 'asset']);
  assert.deepEqual(classifyPath('README.md'), ['docs']);
});

test('suggestTier: sensitive names its triggers, light is docs, copy and assets only', () => {
  const f = (p) => ({ path: p, classes: classifyPath(p) });
  const sensitive = suggestTier([f('app/Home.swift'), f('.github/workflows/ci.yml'), f('app/Analytics.swift')]);
  assert.equal(sensitive.tier, 'sensitive');
  assert.deepEqual(sensitive.triggers.map((t) => t.class), ['ci', 'privacy']);
  assert.deepEqual(sensitive.triggers[0].examples, ['.github/workflows/ci.yml']);
  assert.equal(suggestTier([f('docs/ux/home.md'), f('app/Localizable.xcstrings'), f('web/site.css')]).tier, 'light');
  assert.equal(suggestTier([f('docs/ux/home.md'), f('app/Home.swift')]).tier, 'standard');
});
