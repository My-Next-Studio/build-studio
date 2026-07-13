'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectExistingDocs } = require('./existing-docs');

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-docs-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return root;
}

function clean(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

// ─── example-app shape ───────────────────────────────────────────────────────

test('detectExistingDocs: example-app-shape (README + PRD.md + DESIGN.md)', () => {
  const root = makeTree({
    'README.md':  'short readme',
    'PRD.md':     'one-shot PRD with vision + roadmap',
    'DESIGN.md':  'visual brief',
    'package.json': '{}',
  });
  try {
    const r = detectExistingDocs(root);
    const kinds = r.docs.map((d) => d.kind);
    assert.ok(kinds.includes('readme'));
    assert.ok(kinds.includes('prd-monolith'));
    assert.ok(kinds.includes('design-doc'));
    assert.equal(r.claudeMdPresent, false);
    assert.equal(r.agentsMdPresent, false);
    assert.equal(r.specsDirPresent, false);
    assert.equal(r.counts.existingPrds, 0);
  } finally { clean(root); }
});

// ─── skrivhjälp shape ──────────────────────────────────────────────────────

test('detectExistingDocs: skrivhjälp-shape (README + AGENTS.md + /specs/* + ACTION-PLAN)', () => {
  const root = makeTree({
    'README.md':       '',
    'AGENTS.md':       'agent contract',
    'ACTION-PLAN.md':  '',
    'specs/PRD.md':         '',
    'specs/OPERATIONS.md':  '',
    'specs/ANALYTICS.md':   '',
    'specs/PAYMENT_AND_POLICY.md': '',
    'package.json': '{}',
  });
  try {
    const r = detectExistingDocs(root);
    const kinds = r.docs.map((d) => d.kind);
    assert.equal(r.agentsMdPresent, true);
    assert.equal(r.specsDirPresent, true);
    assert.ok(kinds.includes('action-plan'));
    const specs = r.docs.filter((d) => d.kind === 'spec');
    assert.equal(specs.length, 4, 'all 4 spec files should be inventoried');
  } finally { clean(root); }
});

// ─── example-studio shape (mature monorepo) ─────────────────────────────────

test('detectExistingDocs: example-studio-shape (CLAUDE.md + docs/strategy + docs/architecture)', () => {
  const root = makeTree({
    'README.md':      '',
    'CLAUDE.md':      'monorepo agent contract',
    'docs/strategy/vision.md':       '',
    'docs/strategy/roadmap.md':      '',
    'docs/architecture/data-model.md':  '',
    'docs/branding/identity.md':     '',
    'docs/marketing/positioning.md': '',
    'docs/operations/runbook.md':    '',
    'docs/localization/glossary.md': '',
    'package.json': '{}',
  });
  try {
    const r = detectExistingDocs(root);
    assert.equal(r.claudeMdPresent, true);
    const kinds = r.docs.map((d) => d.kind);
    assert.ok(kinds.includes('strategy'));
    assert.ok(kinds.includes('architecture'));
    assert.ok(kinds.includes('branding'));
    assert.ok(kinds.includes('marketing'));
    assert.ok(kinds.includes('operations'));
    assert.ok(kinds.includes('localization'));
  } finally { clean(root); }
});

// ─── Existing PRD/ADR counts (don't enumerate, just count) ─────────────────

test('detectExistingDocs: counts existing PRDs/ADRs/contracts without listing each', () => {
  const root = makeTree({
    'docs/prds/PRD-001-x.md': '',
    'docs/prds/PRD-002-y.md': '',
    'docs/prds/PRD-003-z.md': '',
    'docs/adrs/ADR-001-stack.md': '',
    'docs/contracts/api.md': '',
  });
  try {
    const r = detectExistingDocs(root);
    assert.equal(r.counts.existingPrds, 3);
    assert.equal(r.counts.existingAdrs, 1);
    assert.equal(r.counts.existingContracts, 1);
    // Detailed list should NOT contain the individual PRD/ADR files (that'd be noise).
    const docPaths = r.docs.map((d) => d.path);
    for (const p of docPaths) {
      assert.ok(!p.startsWith('docs/prds/'), 'PRDs should be counted, not enumerated');
      assert.ok(!p.startsWith('docs/adrs/'), 'ADRs should be counted, not enumerated');
    }
  } finally { clean(root); }
});

// ─── bytes recorded ────────────────────────────────────────────────────────

test('detectExistingDocs: each doc entry includes byte size', () => {
  const root = makeTree({
    'README.md': 'A'.repeat(123),
    'package.json': '{}',
  });
  try {
    const r = detectExistingDocs(root);
    const readme = r.docs.find((d) => d.kind === 'readme');
    assert.equal(readme.bytes, 123);
  } finally { clean(root); }
});

// ─── empty repo ────────────────────────────────────────────────────────────

test('detectExistingDocs: empty repo → empty docs list, all flags false', () => {
  const root = makeTree({});
  try {
    const r = detectExistingDocs(root);
    assert.deepEqual(r.docs, []);
    assert.equal(r.claudeMdPresent, false);
    assert.equal(r.agentsMdPresent, false);
    assert.equal(r.specsDirPresent, false);
  } finally { clean(root); }
});
