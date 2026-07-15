'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { seedClaudeFolderTrust } = require('./claude-trust');

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-trust-test-'));
}

function cleanDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

test('missing config file: creates it with the trust entry', () => {
  const dir = makeTmpDir();
  const cfg = path.join(dir, '.claude.json');
  assert.equal(seedClaudeFolderTrust('/proj/a', { configPath: cfg }), true);
  const parsed = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.equal(parsed.projects['/proj/a'].hasTrustDialogAccepted, true);
  cleanDir(dir);
});

test('existing config: merges without clobbering unrelated keys or the project entry', () => {
  const dir = makeTmpDir();
  const cfg = path.join(dir, '.claude.json');
  fs.writeFileSync(cfg, JSON.stringify({
    theme: 'dark',
    projects: {
      '/proj/other': { hasTrustDialogAccepted: true },
      '/proj/b': { history: [1, 2], hasTrustDialogAccepted: false },
    },
  }));
  assert.equal(seedClaudeFolderTrust('/proj/b', { configPath: cfg }), true);
  const parsed = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  assert.equal(parsed.theme, 'dark');
  assert.equal(parsed.projects['/proj/other'].hasTrustDialogAccepted, true);
  assert.deepEqual(parsed.projects['/proj/b'].history, [1, 2]);
  assert.equal(parsed.projects['/proj/b'].hasTrustDialogAccepted, true);
  cleanDir(dir);
});

test('already trusted: returns true and does not rewrite the file', () => {
  const dir = makeTmpDir();
  const cfg = path.join(dir, '.claude.json');
  const raw = JSON.stringify({ projects: { '/proj/c': { hasTrustDialogAccepted: true } } });
  fs.writeFileSync(cfg, raw);
  assert.equal(seedClaudeFolderTrust('/proj/c', { configPath: cfg }), true);
  assert.equal(fs.readFileSync(cfg, 'utf8'), raw); // byte-identical — untouched
  cleanDir(dir);
});

test('corrupt config: returns false and leaves the file untouched', () => {
  const dir = makeTmpDir();
  const cfg = path.join(dir, '.claude.json');
  fs.writeFileSync(cfg, '{ not json');
  assert.equal(seedClaudeFolderTrust('/proj/d', { configPath: cfg }), false);
  assert.equal(fs.readFileSync(cfg, 'utf8'), '{ not json');
  cleanDir(dir);
});

test('non-object JSON (array): returns false and leaves the file untouched', () => {
  const dir = makeTmpDir();
  const cfg = path.join(dir, '.claude.json');
  fs.writeFileSync(cfg, '[1,2,3]');
  assert.equal(seedClaudeFolderTrust('/proj/e', { configPath: cfg }), false);
  assert.equal(fs.readFileSync(cfg, 'utf8'), '[1,2,3]');
  cleanDir(dir);
});

test('no leftover tmp files after a successful write', () => {
  const dir = makeTmpDir();
  const cfg = path.join(dir, '.claude.json');
  seedClaudeFolderTrust('/proj/f', { configPath: cfg });
  const leftovers = fs.readdirSync(dir).filter(f => f.includes('.tmp'));
  assert.deepEqual(leftovers, []);
  cleanDir(dir);
});
