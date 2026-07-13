'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isBundleStale, readOnDiskBundleVersion, projectServerLibDir } = require('./process-manager');

// ─── isBundleStale — versions only marked stale when both sides report a
//     concrete version AND they differ. Missing metadata never triggers
//     a restart (avoids dev-mode thrashing). ────────────────────────────────

test('isBundleStale: matching versions → not stale', () => {
  assert.equal(isBundleStale('1761500000000', '1761500000000'), false);
});

test('isBundleStale: differing versions → stale', () => {
  assert.equal(isBundleStale('1761500000000', '1761500999999'), true);
});

test('isBundleStale: running=null → not stale (dev-mode running server)', () => {
  assert.equal(isBundleStale(null, '1761500000000'), false);
});

test('isBundleStale: ondisk=null → not stale (dev-mode hub)', () => {
  assert.equal(isBundleStale('1761500000000', null), false);
});

test('isBundleStale: both null → not stale', () => {
  assert.equal(isBundleStale(null, null), false);
});

test('isBundleStale: empty strings treated as missing metadata', () => {
  assert.equal(isBundleStale('', ''), false);
  assert.equal(isBundleStale('', '1761500000000'), false);
  assert.equal(isBundleStale('1761500000000', ''), false);
});

test('isBundleStale: undefined treated as missing metadata', () => {
  assert.equal(isBundleStale(undefined, '1761500000000'), false);
  assert.equal(isBundleStale('1761500000000', undefined), false);
  assert.equal(isBundleStale(undefined, undefined), false);
});

// ─── projectServerLibDir + readOnDiskBundleVersion — env override + file
//     missing fallback. ────────────────────────────────────────────────────

test('projectServerLibDir: respects BUILD_STUDIO_PROJECT_SERVER override', () => {
  const original = process.env.BUILD_STUDIO_PROJECT_SERVER;
  process.env.BUILD_STUDIO_PROJECT_SERVER = '/tmp/fake-project-server';
  try {
    const dir = projectServerLibDir();
    assert.equal(dir, '/tmp/fake-project-server/lib');
  } finally {
    if (original === undefined) delete process.env.BUILD_STUDIO_PROJECT_SERVER;
    else process.env.BUILD_STUDIO_PROJECT_SERVER = original;
  }
});

test('readOnDiskBundleVersion: missing file → null (dev-mode safe)', () => {
  const original = process.env.BUILD_STUDIO_PROJECT_SERVER;
  process.env.BUILD_STUDIO_PROJECT_SERVER = '/tmp/build-studio-no-such-dir-' + Date.now();
  try {
    assert.equal(readOnDiskBundleVersion(), null);
  } finally {
    if (original === undefined) delete process.env.BUILD_STUDIO_PROJECT_SERVER;
    else process.env.BUILD_STUDIO_PROJECT_SERVER = original;
  }
});

test('readOnDiskBundleVersion: present file → trimmed string', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-version-test-'));
  fs.mkdirSync(path.join(tmpRoot, 'lib'));
  fs.writeFileSync(path.join(tmpRoot, 'lib', '.bundle-version'), '1761500000000\n');
  const original = process.env.BUILD_STUDIO_PROJECT_SERVER;
  process.env.BUILD_STUDIO_PROJECT_SERVER = tmpRoot;
  try {
    assert.equal(readOnDiskBundleVersion(), '1761500000000');
  } finally {
    if (original === undefined) delete process.env.BUILD_STUDIO_PROJECT_SERVER;
    else process.env.BUILD_STUDIO_PROJECT_SERVER = original;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('readOnDiskBundleVersion: empty file → null', () => {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-version-test-'));
  fs.mkdirSync(path.join(tmpRoot, 'lib'));
  fs.writeFileSync(path.join(tmpRoot, 'lib', '.bundle-version'), '   \n');
  const original = process.env.BUILD_STUDIO_PROJECT_SERVER;
  process.env.BUILD_STUDIO_PROJECT_SERVER = tmpRoot;
  try {
    assert.equal(readOnDiskBundleVersion(), null);
  } finally {
    if (original === undefined) delete process.env.BUILD_STUDIO_PROJECT_SERVER;
    else process.env.BUILD_STUDIO_PROJECT_SERVER = original;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
