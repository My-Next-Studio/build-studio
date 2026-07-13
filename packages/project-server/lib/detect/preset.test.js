'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { detectPreset } = require('./preset');

// ─── Scaffold helper: build a minimal project tree on disk ──────────────────

function makeTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'detect-preset-'));
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

const PKG_VITE_REACT = JSON.stringify({
  name: 'fixture',
  scripts: { dev: 'vite', build: 'tsc -b && vite build' },
  dependencies: { react: '^18', 'react-dom': '^18' },
  devDependencies: { vite: '^5', typescript: '^5' },
});

const PKG_NEXT = JSON.stringify({
  name: 'fixture',
  scripts: { dev: 'next dev', build: 'next build' },
  dependencies: { next: '^16', react: '^19', 'react-dom': '^19' },
});

const PKG_NEXT_CFP = JSON.stringify({
  name: 'fixture',
  scripts: { dev: 'next dev', build: 'next build' },
  dependencies: { next: '^16', react: '^19' },
});

const PKG_FASTIFY = JSON.stringify({
  name: 'fixture',
  scripts: { dev: 'node server.js' },
  dependencies: { fastify: '^4' },
});

const PKG_WORKSPACES = JSON.stringify({
  name: 'monorepo',
  workspaces: ['apps/*', 'packages/*'],
});

// ─── Pilot shape (example-app) ───────────────────────────────────────────────

test('detectPreset: example-app-shape (Vite + React + TS, no server) → static-site', () => {
  const root = makeTree({
    'package.json': PKG_VITE_REACT,
    'vite.config.ts': '',
    'index.html': '',
    'src/main.tsx': '',
  });
  try {
    const r = detectPreset(root);
    assert.equal(r.preset, 'static-site');
    assert.match(r.reason, /vite/i);
  } finally { clean(root); }
});

// ─── example-web-shape ────────────────────────────────────────────────────────

test('detectPreset: SvelteKit (example-web frontend) → web-app', () => {
  const root = makeTree({
    'package.json': JSON.stringify({
      name: 'fixture',
      dependencies: { '@sveltejs/kit': '^2', svelte: '^5' },
    }),
    'svelte.config.js': '',
  });
  try {
    const r = detectPreset(root);
    assert.equal(r.preset, 'web-app');
    assert.match(r.reason, /SvelteKit/i);
  } finally { clean(root); }
});

// ─── example-site-shape ──────────────────────────────────────────────────────────

test('detectPreset: Next.js → web-app', () => {
  const root = makeTree({
    'package.json': PKG_NEXT,
    'next.config.ts': '',
  });
  try {
    const r = detectPreset(root);
    assert.equal(r.preset, 'web-app');
    assert.match(r.reason, /Next\.js/i);
  } finally { clean(root); }
});

test('detectPreset: Next.js + wrangler → web-app (CFP signal recorded in reason)', () => {
  const root = makeTree({
    'package.json': PKG_NEXT_CFP,
    'next.config.ts': '',
    'wrangler.jsonc': '{}',
  });
  try {
    const r = detectPreset(root);
    assert.equal(r.preset, 'web-app');
    assert.match(r.reason, /Cloudflare/i);
  } finally { clean(root); }
});

// ─── api-only ──────────────────────────────────────────────────────────────

test('detectPreset: Fastify, no public/, no vite → api-only', () => {
  const root = makeTree({
    'package.json': PKG_FASTIFY,
    'server.js': '',
  });
  try {
    const r = detectPreset(root);
    assert.equal(r.preset, 'api-only');
    assert.match(r.reason, /no public/i);
  } finally { clean(root); }
});

test('detectPreset: Express WITH public/ → web-app, not api-only', () => {
  const root = makeTree({
    'package.json': JSON.stringify({ dependencies: { express: '^4' } }),
    'public/index.html': '',
  });
  try {
    const r = detectPreset(root);
    assert.notEqual(r.preset, 'api-only');
  } finally { clean(root); }
});

// ─── monorepo ──────────────────────────────────────────────────────────────

test('detectPreset: workspace package.json → monorepo', () => {
  const root = makeTree({
    'package.json': PKG_WORKSPACES,
    'apps/foo/package.json': '{}',
    'apps/bar/package.json': '{}',
  });
  try {
    const r = detectPreset(root);
    assert.equal(r.preset, 'monorepo');
    assert.match(r.reason, /workspaces/i);
  } finally { clean(root); }
});

test('detectPreset: apps/ with multiple sub-projects → monorepo (no workspaces field)', () => {
  const root = makeTree({
    'package.json': JSON.stringify({ name: 'root' }),
    'apps/api/package.json': '{}',
    'apps/web/package.json': '{}',
  });
  try {
    const r = detectPreset(root);
    assert.equal(r.preset, 'monorepo');
    assert.match(r.reason, /apps/i);
  } finally { clean(root); }
});

test('detectPreset: packages/ with multiple sub-packages → monorepo', () => {
  const root = makeTree({
    'package.json': JSON.stringify({ name: 'root' }),
    'packages/a/package.json': '{}',
    'packages/b/package.json': '{}',
  });
  try {
    const r = detectPreset(root);
    assert.equal(r.preset, 'monorepo');
  } finally { clean(root); }
});

// ─── mobile-app ────────────────────────────────────────────────────────────

test('detectPreset: root Podfile → mobile-app', () => {
  const root = makeTree({ 'Podfile': '' });
  try {
    const r = detectPreset(root);
    assert.equal(r.preset, 'mobile-app');
    assert.match(r.reason, /Podfile/i);
  } finally { clean(root); }
});

test('detectPreset: example-studio shape (apps/<name>/Podfile) → mobile-app', () => {
  const root = makeTree({
    'package.json': JSON.stringify({ name: 'monorepo' }),
    'apps/my-next-todo/Podfile': '',
    'apps/my-next-runner/Podfile': '',
  });
  try {
    const r = detectPreset(root);
    assert.equal(r.preset, 'mobile-app');
  } finally { clean(root); }
});

test('detectPreset: example-studio real layout (apps/<name>/ios/*.xcodeproj) → mobile-app', () => {
  const root = makeTree({
    'package.json': JSON.stringify({ name: 'monorepo' }),
    'apps/my-next-todo/ios/MyNextTodo.xcodeproj/project.pbxproj': '',
    'apps/my-next-note/ios/MyNextNote.xcodeproj/project.pbxproj': '',
  });
  try {
    const r = detectPreset(root);
    assert.equal(r.preset, 'mobile-app', 'Xcode project nested under apps/<name>/ios/ must be detected');
    assert.match(r.reason, /ios/i);
  } finally { clean(root); }
});

test('detectPreset: Android-only Gradle project → mobile-app', () => {
  const root = makeTree({
    'android/build.gradle.kts': '',
  });
  try {
    const r = detectPreset(root);
    assert.equal(r.preset, 'mobile-app');
    assert.match(r.reason, /Android/i);
  } finally { clean(root); }
});

// ─── Default fallback ───────────────────────────────────────────────────────

test('detectPreset: empty repo with only package.json → web-app default', () => {
  const root = makeTree({ 'package.json': '{}' });
  try {
    const r = detectPreset(root);
    assert.equal(r.preset, 'web-app');
    assert.match(r.reason, /Default/i);
  } finally { clean(root); }
});

test('detectPreset: package.json absent — still returns web-app default safely', () => {
  const root = makeTree({ 'README.md': '' });
  try {
    const r = detectPreset(root);
    assert.equal(r.preset, 'web-app');
  } finally { clean(root); }
});
