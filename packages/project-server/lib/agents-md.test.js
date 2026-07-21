'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CLAUDE_STUB, planAgentsMdMigration, applyAgentsMdMigration } = require('./agents-md');

function makeRoot(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-md-test-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, rel), content);
  }
  return root;
}

function clean(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

const REAL_CLAUDE = '# Project Configuration\n\nProject-specific stuff here.\n';

// ─── plan matrix ────────────────────────────────────────────────────────────

test('plan: neither file → scaffold', () => {
  const root = makeRoot();
  try {
    const plan = planAgentsMdMigration(root);
    assert.equal(plan.action, 'scaffold');
  } finally { clean(root); }
});

test('plan: populated CLAUDE.md only → migrate', () => {
  const root = makeRoot({ 'CLAUDE.md': REAL_CLAUDE });
  try {
    const plan = planAgentsMdMigration(root);
    assert.equal(plan.action, 'migrate');
    assert.equal(plan.claudeMdPresent, true);
    assert.equal(plan.agentsMdPresent, false);
  } finally { clean(root); }
});

test('plan: AGENTS.md only → stub-only', () => {
  const root = makeRoot({ 'AGENTS.md': '# Agents\n' });
  try {
    const plan = planAgentsMdMigration(root);
    assert.equal(plan.action, 'stub-only');
  } finally { clean(root); }
});

test('plan: stub CLAUDE.md + AGENTS.md → none (already migrated)', () => {
  const root = makeRoot({ 'CLAUDE.md': CLAUDE_STUB, 'AGENTS.md': REAL_CLAUDE });
  try {
    const plan = planAgentsMdMigration(root);
    assert.equal(plan.action, 'none');
  } finally { clean(root); }
});

test('plan: BOTH populated → none with manual-reconcile warning', () => {
  const root = makeRoot({ 'CLAUDE.md': REAL_CLAUDE, 'AGENTS.md': '# Agents\n' });
  try {
    const plan = planAgentsMdMigration(root);
    assert.equal(plan.action, 'none');
    assert.match(plan.summary, /BOTH/);
  } finally { clean(root); }
});

test('plan: stub CLAUDE.md but missing AGENTS.md → scaffold (broken partial state)', () => {
  const root = makeRoot({ 'CLAUDE.md': CLAUDE_STUB });
  try {
    const plan = planAgentsMdMigration(root);
    assert.equal(plan.action, 'scaffold');
  } finally { clean(root); }
});

// ─── apply ──────────────────────────────────────────────────────────────────

test('apply migrate: content preserved verbatim in AGENTS.md, CLAUDE.md becomes stub', () => {
  const root = makeRoot({ 'CLAUDE.md': REAL_CLAUDE });
  try {
    const plan = planAgentsMdMigration(root);
    const result = applyAgentsMdMigration(root, plan);
    assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), REAL_CLAUDE);
    assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), CLAUDE_STUB);
    assert.ok(CLAUDE_STUB.includes('@AGENTS.md'));
    assert.ok(result.written.some(w => w.startsWith('AGENTS.md')));
    assert.ok(result.written.some(w => w.startsWith('CLAUDE.md')));
    // Re-planning afterwards reports a clean migrated state.
    assert.equal(planAgentsMdMigration(root).action, 'none');
  } finally { clean(root); }
});

test('apply scaffold: writes template AGENTS.md + stub', () => {
  const root = makeRoot();
  try {
    const plan = planAgentsMdMigration(root);
    applyAgentsMdMigration(root, plan);
    const agents = fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8');
    assert.ok(agents.length > 50); // real template, not an empty file
    assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), CLAUDE_STUB);
  } finally { clean(root); }
});

test('apply stub-only: writes just the stub, AGENTS.md untouched', () => {
  const agents = '# My own agents file\n';
  const root = makeRoot({ 'AGENTS.md': agents });
  try {
    const plan = planAgentsMdMigration(root);
    applyAgentsMdMigration(root, plan);
    assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), agents);
    assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), CLAUDE_STUB);
  } finally { clean(root); }
});

test('apply never overwrites an existing AGENTS.md even if asked to scaffold', () => {
  const agents = '# Precious\n';
  const root = makeRoot({ 'AGENTS.md': agents });
  try {
    // Force a scaffold plan against a root that has AGENTS.md (defensive path).
    const result = applyAgentsMdMigration(root, { action: 'scaffold', claudeMdPresent: false });
    assert.equal(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), agents);
    assert.ok(result.skipped.some(s => s.includes('AGENTS.md')));
  } finally { clean(root); }
});
