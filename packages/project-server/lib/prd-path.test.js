'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { reconcilePrdPath } = require('./prd-path');

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-prdpath-'));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), body);
  }
  return { root, docs: path.join(root, 'docs'), done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const item = (prd) => `---\nid: X-1\ntitle: t\nstatus: Drafted\nprd: ${prd}\n---\n`;

test('a PRD renumbered mid-run is followed through the backlog item', () => {
  const p = project({
    'docs/backlog/X-1.md': item('docs/prds/PRD-159-thing.md'),
    'docs/prds/PRD-159-thing.md': '# PRD-159\n',
  });
  try {
    const wf = { itemId: 'X-1', prdPath: 'docs/prds/PRD-158-thing.md' };
    const r = reconcilePrdPath(wf, { projectRoot: p.root, docsPath: p.docs });
    assert.deepStrictEqual(r, { changed: true, from: 'docs/prds/PRD-158-thing.md', to: 'docs/prds/PRD-159-thing.md' });
    assert.equal(wf.prdPath, 'docs/prds/PRD-159-thing.md');
  } finally { p.done(); }
});

test('an existing recorded path is left alone, even if the item names another', () => {
  const p = project({
    'docs/backlog/X-1.md': item('docs/prds/PRD-2.md'),
    'docs/prds/PRD-1.md': '#\n', 'docs/prds/PRD-2.md': '#\n',
  });
  try {
    const wf = { itemId: 'X-1', prdPath: 'docs/prds/PRD-1.md' };
    assert.deepStrictEqual(reconcilePrdPath(wf, { projectRoot: p.root, docsPath: p.docs }), { changed: false });
    assert.equal(wf.prdPath, 'docs/prds/PRD-1.md');
  } finally { p.done(); }
});

test('gone with nothing better to follow → reported missing, path unchanged', () => {
  const p = project({ 'docs/backlog/X-1.md': item('null') });
  try {
    const wf = { itemId: 'X-1', prdPath: 'docs/prds/PRD-1.md' };
    assert.deepStrictEqual(reconcilePrdPath(wf, { projectRoot: p.root, docsPath: p.docs }), { changed: false, missing: true });
    assert.equal(wf.prdPath, 'docs/prds/PRD-1.md');
  } finally { p.done(); }
});

test('a bare file name in prd: resolves under docs/prds', () => {
  const p = project({ 'docs/backlog/X-1.md': item('PRD-9-x.md'), 'docs/prds/PRD-9-x.md': '#\n' });
  try {
    const wf = { itemId: 'X-1', prdPath: 'docs/prds/PRD-8-x.md' };
    assert.equal(reconcilePrdPath(wf, { projectRoot: p.root, docsPath: p.docs }).to, 'docs/prds/PRD-9-x.md');
  } finally { p.done(); }
});
