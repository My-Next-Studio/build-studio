'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { docBudgetWarnings, formatDocBudgetWarning } = require('./doc-budget');

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-budget-'));
  for (const [rel, bytes] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), 'x'.repeat(bytes));
  }
  return root;
}

test('only documents over their limit are reported, with repo-relative paths', () => {
  const root = project({ 'docs/project-state.md': 41 * 1024, 'ARCHITECTURE.md': 20 * 1024 });
  try {
    const w = docBudgetWarnings(root, 'docs');
    assert.deepEqual(w.map((x) => x.file), ['docs/project-state.md']);
    assert.match(formatDocBudgetWarning(w[0]), /docs\/project-state\.md is 41 KB, over its 40 KB limit/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ARCHITECTURE.md is read from the repo root, and a missing file is not a warning', () => {
  const root = project({ 'ARCHITECTURE.md': 30 * 1024 });
  try {
    assert.deepEqual(docBudgetWarnings(root, 'docs').map((x) => x.key), ['architecture']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const { architectureBudgetLine } = require('./doc-budget');

test('the builder is told the map size against the limit, and to trade lines when over', () => {
  const under = project({ 'ARCHITECTURE.md': 12 * 1024 });
  const over = project({ 'ARCHITECTURE.md': 30 * 1024 });
  try {
    assert.match(architectureBudgetLine(under), /12 KB of a 20 KB limit/);
    assert.match(architectureBudgetLine(over), /30 KB, already over its 20 KB limit: do not make it longer/);
  } finally {
    fs.rmSync(under, { recursive: true, force: true });
    fs.rmSync(over, { recursive: true, force: true });
  }
});

// The project-side copy of these limits: templates/default/scripts/check-docs-budget.mjs
// ships into every new or onboarded project and runs in its CI.
const { execFileSync, spawnSync } = require('child_process');
const { DOC_BUDGETS } = require('./doc-budget');
const TEMPLATE_CHECK = path.resolve(__dirname, '..', '..', '..', 'templates', 'default', 'scripts', 'check-docs-budget.mjs');

test('the template check script enforces the same limits as Build Studio', () => {
  const src = fs.readFileSync(TEMPLATE_CHECK, 'utf8');
  for (const b of DOC_BUDGETS) {
    const rel = b.inDocs ? `docs/${b.rel}` : b.rel;
    const m = src.match(new RegExp(`\\["${rel.replace(/[.]/g, '\\.')}",\\s*(\\d+)\\s*\\*\\s*1024`));
    assert.ok(m, `${rel} has no limit in the template script`);
    assert.equal(Number(m[1]) * 1024, b.limitBytes, `${rel}: template script and lib/doc-budget.js disagree`);
  }
});

test('the template check script passes its own self-test', () => {
  const run = spawnSync(process.execPath, [TEMPLATE_CHECK, '--self-test'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('a freshly scaffolded project passes the check on its first CI run', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-scaffold-budget-'));
  const target = path.join(tmp, 'demo');
  const env = {
    ...process.env,
    HOME: tmp, // scaffold seeds Claude folder trust in ~/.claude.json
    GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  try {
    execFileSync(process.execPath, ['-e', `require(${JSON.stringify(path.join(__dirname, 'scaffold.js'))}).scaffoldProject(${JSON.stringify(target)}, { name: 'demo' })`], { env, stdio: 'pipe' });
    const script = path.join(target, 'scripts', 'check-docs-budget.mjs');
    assert.ok(fs.existsSync(script), 'scaffold must copy scripts/check-docs-budget.mjs');
    // Only what git tracks reaches CI: check a clean checkout, not the working tree.
    const clone = path.join(tmp, 'clone');
    execFileSync('git', ['clone', '-q', target, clone], { env, stdio: 'pipe' });
    const run = spawnSync(process.execPath, [path.join(clone, 'scripts', 'check-docs-budget.mjs'), clone], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
