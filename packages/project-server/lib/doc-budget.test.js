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
