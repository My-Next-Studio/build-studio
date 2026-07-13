'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectDevCommands } = require('./dev-commands');

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-dev-'));
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

// ─── Pilot shape (example-app) ───────────────────────────────────────────────

test('detectDevCommands: example-app-shape (Vite + React) → one entry, port 5173, type vite', () => {
  const root = makeTree({
    'package.json': JSON.stringify({
      scripts: { dev: 'vite', build: 'tsc -b && vite build' },
      devDependencies: { vite: '^5' },
    }),
    'vite.config.ts': '',
  });
  try {
    const r = detectDevCommands(root);
    assert.equal(r.devCommands.length, 1);
    const [c] = r.devCommands;
    assert.equal(c.name, 'app');
    assert.equal(c.cmd, 'npm run dev');
    assert.equal(c.port, 5173);
    assert.equal(c.type, 'vite');
    assert.equal(c.cwd, undefined, 'root-level cwd is implicit');
  } finally { clean(root); }
});

// ─── Example-site shape (Next.js, single root package) ───────────────────────────

test('detectDevCommands: Next.js → port 3000, type node', () => {
  const root = makeTree({
    'package.json': JSON.stringify({
      scripts: { dev: 'next dev' },
      dependencies: { next: '^16' },
    }),
  });
  try {
    const r = detectDevCommands(root);
    assert.equal(r.devCommands.length, 1);
    assert.equal(r.devCommands[0].port, 3000);
    assert.equal(r.devCommands[0].type, 'node');
  } finally { clean(root); }
});

// ─── Example-web shape (sibling packages: backend + frontend + admin) ─────────

test('detectDevCommands: sibling packages (example-web shape) → entry per package', () => {
  const root = makeTree({
    'package.json': JSON.stringify({ name: 'example-web' }), // root has no scripts
    'frontend/package.json': JSON.stringify({
      scripts: { dev: 'vite' }, devDependencies: { vite: '^5' },
    }),
    'backend/package.json': JSON.stringify({
      scripts: { dev: 'fastify-cli start app.js' }, dependencies: { fastify: '^4' },
    }),
    'admin/package.json': JSON.stringify({
      scripts: { dev: 'vite --port 5174' }, devDependencies: { vite: '^5' },
    }),
  });
  try {
    const r = detectDevCommands(root);
    assert.equal(r.devCommands.length, 3);
    const byName = Object.fromEntries(r.devCommands.map((c) => [c.name, c]));
    assert.equal(byName.frontend.port, 5173);
    assert.equal(byName.frontend.type, 'vite');
    assert.equal(byName.frontend.cwd, 'frontend');
    assert.equal(byName.backend.port, 4000);
    assert.equal(byName.backend.type, 'node');
    assert.equal(byName.backend.cwd, 'backend');
    assert.equal(byName.admin.port, 5174, 'explicit --port 5174 honored over default 5173');
    assert.equal(byName.admin.type, 'vite');
  } finally { clean(root); }
});

// ─── Explicit port via env var ──────────────────────────────────────────────

test('detectDevCommands: PORT=8080 in script → port 8080', () => {
  const root = makeTree({
    'package.json': JSON.stringify({
      scripts: { dev: 'PORT=8080 next dev' },
      dependencies: { next: '^16' },
    }),
  });
  try {
    const r = detectDevCommands(root);
    assert.equal(r.devCommands[0].port, 8080);
  } finally { clean(root); }
});

// ─── Vite config server.port override ───────────────────────────────────────

test('detectDevCommands: vite.config.ts server.port overrides default', () => {
  const root = makeTree({
    'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }),
    'vite.config.ts': 'export default { server: { port: 5191 } };',
  });
  try {
    const r = detectDevCommands(root);
    assert.equal(r.devCommands[0].port, 5191);
  } finally { clean(root); }
});

// ─── Empty / nothing-to-detect ──────────────────────────────────────────────

test('detectDevCommands: no scripts → empty array, no errors', () => {
  const root = makeTree({ 'package.json': JSON.stringify({ name: 'fixture' }) });
  try {
    const r = detectDevCommands(root);
    assert.equal(r.devCommands.length, 0);
  } finally { clean(root); }
});

test('detectDevCommands: no package.json anywhere → empty array', () => {
  const root = makeTree({ 'README.md': '' });
  try {
    const r = detectDevCommands(root);
    assert.equal(r.devCommands.length, 0);
  } finally { clean(root); }
});

// ─── Skip conventional non-package dirs ────────────────────────────────────

test('detectDevCommands: ignores docs/, node_modules/, .build-studio/, etc.', () => {
  const root = makeTree({
    'package.json': JSON.stringify({ scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } }),
    // Decoy package.jsons in non-package dirs — must not produce entries.
    'node_modules/junk/package.json': '{"scripts":{"dev":"node fake.js"}}',
    'docs/internal/package.json': '{"scripts":{"dev":"node other.js"}}',
    '.build-studio/package.json': '{}',
  });
  try {
    const r = detectDevCommands(root);
    assert.equal(r.devCommands.length, 1, 'only the root entry should appear');
    assert.equal(r.devCommands[0].name, 'app');
  } finally { clean(root); }
});

// ─── start script fallback ──────────────────────────────────────────────────

test('detectDevCommands: falls back to "start" when no "dev" script', () => {
  const root = makeTree({
    'package.json': JSON.stringify({
      scripts: { start: 'node server.js' },
      dependencies: { fastify: '^4' },
    }),
  });
  try {
    const r = detectDevCommands(root);
    assert.equal(r.devCommands.length, 1);
    assert.equal(r.devCommands[0].cmd, 'npm run start');
  } finally { clean(root); }
});
