'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { findMergedCommit, parseActivePrd } = require('./status');

// ─── Fixture: a real git repo with controllable commit history ──────────────

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-test-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root, stdio: 'ignore' });
  // Initial commit so HEAD exists.
  fs.writeFileSync(path.join(root, 'README.md'), '# init');
  execFileSync('git', ['add', 'README.md'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
  return root;
}

function clean(root) { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }

function commitFile(root, relPath, content, message) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  execFileSync('git', ['add', relPath], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', message], { cwd: root, stdio: 'ignore' });
}

// ─── Bug regression: PRD-document commits must NOT count as merge commits ───

test('findMergedCommit: PRD-doc-only commits do NOT count as merged', () => {
  const root = makeRepo();
  try {
    // PRD authoring + revision — both touch ONLY docs/prds/PRD-005e-foo.md
    commitFile(root, 'docs/prds/PRD-005e-foo.md', '# PRD-005e v1', 'committed draft of PRD-005e');
    commitFile(root, 'docs/prds/PRD-005e-foo.md', '# PRD-005e v2', 'docs(PRD-005e): Rev 2 — apply Round 1 review feedback');

    const result = findMergedCommit(root, 'PRD-005e', null, 'docs/prds/PRD-005e-foo.md');
    assert.deepEqual(result, {}, 'doc-only commits must not flip phase to merged (regression for example-site PRD-005e bug)');
  } finally { clean(root); }
});

test('findMergedCommit: per-task feat commit does NOT count — only end-of-execution merge does', () => {
  // Per the lifecycle spec: implemented = "end of execution workflow when it's
  // merged". Intermediate per-task feat(PRD-X/US-N) commits are not the workflow
  // merge — they must not flip the phase to implemented.
  const root = makeRepo();
  try {
    commitFile(root, 'docs/prds/PRD-100-bar.md', '# PRD-100', 'docs(PRD-100): draft');
    commitFile(root, 'src/feature.ts', 'export const x = 1;', 'feat(PRD-100/US-1): implement feature');

    const result = findMergedCommit(root, 'PRD-100', null, 'docs/prds/PRD-100-bar.md');
    assert.deepEqual(result, {}, 'per-task feat commits do not count as the workflow merge');
  } finally { clean(root); }
});

test('findMergedCommit: workflow-style merge commit (Merge review/PRD-XXX:) wins over doc commits', () => {
  const root = makeRepo();
  try {
    commitFile(root, 'docs/prds/PRD-200-baz.md', '# PRD-200', 'docs(PRD-200): draft');
    // Simulate a real workflow-driven merge: code change committed via a merge commit
    // with the workflow's exact message convention.
    execFileSync('git', ['checkout', '-b', 'review/PRD-200'], { cwd: root, stdio: 'ignore' });
    commitFile(root, 'src/feature.ts', 'export const y = 2;', 'feat: real work for PRD-200');
    execFileSync('git', ['checkout', 'main'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['merge', 'review/PRD-200', '--no-ff', '-m', 'Merge review/PRD-200: PRD-200'], {
      cwd: root, stdio: 'ignore',
    });

    const result = findMergedCommit(root, 'PRD-200', null, 'docs/prds/PRD-200-baz.md');
    assert.ok(result.mergedSha);
    // Check the picked commit is the merge commit, not the doc commit.
    const subject = execFileSync('git', ['log', '-1', '--format=%s', result.mergedSha], {
      cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    assert.match(subject, /^Merge review\/PRD-200:/);
  } finally { clean(root); }
});

test('findMergedCommit: no PRD reference → empty', () => {
  const root = makeRepo();
  try {
    const result = findMergedCommit(root, 'PRD-999', null, 'docs/prds/PRD-999-x.md');
    assert.deepEqual(result, {});
  } finally { clean(root); }
});

test('findMergedCommit: docs/onboarding/ commits are also filtered out', () => {
  const root = makeRepo();
  try {
    commitFile(root, 'docs/onboarding/survey.md', '# survey', 'chore: onboarding survey for PRD-300');
    const result = findMergedCommit(root, 'PRD-300', null, 'docs/prds/PRD-300-x.md');
    assert.deepEqual(result, {}, 'onboarding commits are not implementation merges');
  } finally { clean(root); }
});

test('findMergedCommit: example-site PRD-005e shape (PRD doc + project-state.md, no impl) → empty', () => {
  // Direct regression for the second bug we hit on 2026-04-27 — when a PRD
  // authoring commit ALSO touches docs/project-state.md (typical when the
  // backlog row is updated alongside drafting), the commit must still be
  // filtered out. Implementation merges touch at least one file outside docs/.
  const root = makeRepo();
  try {
    // First commit: PRD draft + project-state Active PRD update.
    fs.mkdirSync(path.join(root, 'docs/prds'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/prds/PRD-005e-foo.md'), '# v1');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/project-state.md'), '## Active PRD\nPRD-005e\n');
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'committed draft of PRD-005e'], { cwd: root, stdio: 'ignore' });
    // Second commit: PRD revision only.
    commitFile(root, 'docs/prds/PRD-005e-foo.md', '# v2', 'docs(PRD-005e): Rev 2');

    const result = findMergedCommit(root, 'PRD-005e', null, 'docs/prds/PRD-005e-foo.md');
    assert.deepEqual(result, {}, 'project-state.md update alongside PRD draft must NOT count as implementation');
  } finally { clean(root); }
});

test('findMergedCommit: companion spec commits (ADR + UX + project-state) → empty', () => {
  const root = makeRepo();
  try {
    fs.mkdirSync(path.join(root, 'docs/adrs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs/ux'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/adrs/ADR-009-bucket.md'), '# ADR');
    fs.writeFileSync(path.join(root, 'docs/ux/UX-007-bar-chart.md'), '# UX');
    fs.writeFileSync(path.join(root, 'docs/project-state.md'), 'updated');
    execFileSync('git', ['add', '-A'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'docs(PRD-005e): companion specs ADR-009 + UX-007'], { cwd: root, stdio: 'ignore' });

    const result = findMergedCommit(root, 'PRD-005e', null, 'docs/prds/PRD-005e-foo.md');
    assert.deepEqual(result, {}, 'companion-spec authoring is not implementation');
  } finally { clean(root); }
});

// ─── parseActivePrd: bold-text-only Active PRD line should still recover path ─

test('parseActivePrd: markdown link → uses link path', () => {
  const md = '## Active PRD\n\n[PRD-100 — Foo](docs/prds/PRD-100-foo.md) — extra\n';
  const r = parseActivePrd(md);
  assert.equal(r.id, 'PRD-100');
  assert.equal(r.path, 'docs/prds/PRD-100-foo.md');
});

test('parseActivePrd: bold-text-only line + projectRoot → recovers path from docs/prds/', () => {
  // Example-site regression: Active PRD line is "**PRD-005e — title.** body…" with no markdown link.
  // The parser must scan docs/prds/ and find PRD-005e-closures-by-hour.md.
  const root = makeRepo();
  try {
    commitFile(root, 'docs/prds/PRD-005e-closures-by-hour.md', '# x', 'docs: draft');
    const md = '## Active PRD\n\n**PRD-005e — Closures-by-hour aggregator.** Adds GET /api/...\n';
    const r = parseActivePrd(md, root);
    assert.equal(r.id, 'PRD-005e');
    assert.equal(r.path, 'docs/prds/PRD-005e-closures-by-hour.md');
  } finally { clean(root); }
});

test('parseActivePrd: bold-text-only line WITHOUT projectRoot → path stays null', () => {
  const md = '## Active PRD\n\n**PRD-005e — title.**\n';
  const r = parseActivePrd(md);
  assert.equal(r.id, 'PRD-005e');
  assert.equal(r.path, null);
});

test('parseActivePrd: id-prefix specificity — PRD-5 must NOT match PRD-5e file', () => {
  const root = makeRepo();
  try {
    commitFile(root, 'docs/prds/PRD-5e-hex.md', 'x', 'x');
    commitFile(root, 'docs/prds/PRD-5-real.md', 'x', 'x');
    const md = '## Active PRD\n\n**PRD-5 — only**\n';
    const r = parseActivePrd(md, root);
    assert.equal(r.path, 'docs/prds/PRD-5-real.md', 'PRD-5 must not match PRD-5e-hex');
  } finally { clean(root); }
});

test('parseActivePrd: no Active PRD section → null', () => {
  assert.equal(parseActivePrd('# Project state\n\n## Backlog\nthings\n'), null);
});
