const { test } = require('node:test');
const assert = require('node:assert');
const {
  satisfiesNpmRange, satisfiesPep440, classifyNpm, classifyPip,
  pyprojectConstraint, refreshCommand,
} = require('./fix-reachability');

// The three real cases this was built from, first — two "one command" and one
// genuinely upstream-blocked. If these ever regress the badge starts lying.

test('esbuild: ^0.27.0 excludes the 0.28.1 fix (0.x caret pivots on minor)', () => {
  assert.strictEqual(satisfiesNpmRange('0.28.1', '^0.27.0'), false);
  assert.strictEqual(satisfiesNpmRange('0.28.1', '~0.27.0'), false);
  assert.strictEqual(satisfiesNpmRange('0.27.9', '^0.27.0'), true);
});

test('@babel/core: ^7.24.4 admits the 7.29.6 fix', () => {
  assert.strictEqual(satisfiesNpmRange('7.29.6', '^7.24.4'), true);
  assert.strictEqual(satisfiesNpmRange('7.29.6', '^7.0.0'), true);
});

test('cryptography: >=42.0 admits the 50.0.0 fix', () => {
  assert.strictEqual(satisfiesPep440('50.0.0', '>=42.0'), true);
  assert.strictEqual(satisfiesPep440('41.0.0', '>=42.0'), false);
});

test('caret above 1.0 allows minor and patch, not major', () => {
  assert.strictEqual(satisfiesNpmRange('1.9.9', '^1.2.3'), true);
  assert.strictEqual(satisfiesNpmRange('2.0.0', '^1.2.3'), false);
  assert.strictEqual(satisfiesNpmRange('1.2.2', '^1.2.3'), false);
});

test('tilde allows patch only', () => {
  assert.strictEqual(satisfiesNpmRange('1.2.9', '~1.2.3'), true);
  assert.strictEqual(satisfiesNpmRange('1.3.0', '~1.2.3'), false);
});

test('caret on 0.0.x pins exactly', () => {
  assert.strictEqual(satisfiesNpmRange('0.0.4', '^0.0.3'), false);
  assert.strictEqual(satisfiesNpmRange('0.0.3', '^0.0.3'), true);
});

test('comparators, wildcards and OR', () => {
  assert.strictEqual(satisfiesNpmRange('5.0.0', '>=4.0.0'), true);
  assert.strictEqual(satisfiesNpmRange('5.0.0', '>=4.0.0 <5.0.0'), false);
  assert.strictEqual(satisfiesNpmRange('5.0.0', '*'), true);
  assert.strictEqual(satisfiesNpmRange('5.0.0', '^4.0.0 || ^5.0.0'), true);
  assert.strictEqual(satisfiesNpmRange('3.0.0', '^4.0.0 || ^5.0.0'), false);
});

// Fail-closed is the property that makes this safe to act on.

test('an unparseable range yields null, never a guess', () => {
  assert.strictEqual(satisfiesNpmRange('1.2.3', '1.0.0 - 2.0.0'), null);
  assert.strictEqual(satisfiesNpmRange('1.2.3', 'workspace:*'), null);
  assert.strictEqual(satisfiesNpmRange('1.2.3', 'github:foo/bar'), null);
  assert.strictEqual(satisfiesNpmRange('1.2.3-beta.1', '^1.0.0'), null, 'prereleases opt out');
});

test('unsupported PEP 440 operators yield null', () => {
  assert.strictEqual(satisfiesPep440('1.2.3', '~=1.2'), null);
  assert.strictEqual(satisfiesPep440('1.2.3', '!=1.2.3'), null);
  assert.strictEqual(satisfiesPep440('1.2.3', '==1.2.*'), null);
});

test('one unreadable range poisons the whole npm verdict', () => {
  // Better to say nothing than to declare "refresh" while an unread constraint
  // might be the one actually blocking it.
  const lock = { packages: {
    'node_modules/a': { dependencies: { esbuild: '^0.27.0' } },
    'node_modules/b': { dependencies: { esbuild: 'workspace:*' } },
  } };
  assert.strictEqual(classifyNpm({ lockJson: lock, pkgName: 'esbuild', patchedVersion: '0.28.1' }), null);
});

test('classifyNpm: every parent permits the fix → refresh', () => {
  const lock = { packages: {
    '': { devDependencies: { 'eslint-plugin-react-hooks': '^7.0.1' } },
    'node_modules/eslint-plugin-react-hooks': { dependencies: { '@babel/core': '^7.24.4' } },
    'node_modules/@babel/helper-module-transforms': { peerDependencies: { '@babel/core': '^7.0.0' } },
  } };
  assert.strictEqual(
    classifyNpm({ lockJson: lock, pkgName: '@babel/core', patchedVersion: '7.29.6' }), 'refresh');
});

test('classifyNpm: one parent excludes the fix → upstream', () => {
  const lock = { packages: {
    'node_modules/tsx': { dependencies: { esbuild: '~0.27.0' } },
    'node_modules/vite': { dependencies: { esbuild: '^0.27.0' } },
  } };
  assert.strictEqual(
    classifyNpm({ lockJson: lock, pkgName: 'esbuild', patchedVersion: '0.28.1' }), 'upstream');
});

test('classifyNpm: a direct dependency is judged by its own constraint', () => {
  const permissive = { packages: { '': { dependencies: { lodash: '^4.17.0' } } } };
  const pinned = { packages: { '': { dependencies: { lodash: '4.17.20' } } } };
  assert.strictEqual(classifyNpm({ lockJson: permissive, pkgName: 'lodash', patchedVersion: '4.17.21' }), 'refresh');
  assert.strictEqual(classifyNpm({ lockJson: pinned, pkgName: 'lodash', patchedVersion: '4.17.21' }), 'upstream');
});

test('classifyNpm: nothing declares it, or the lock is unreadable → null', () => {
  assert.strictEqual(classifyNpm({ lockJson: { packages: {} }, pkgName: 'x', patchedVersion: '1.0.0' }), null);
  assert.strictEqual(classifyNpm({ lockJson: 'not json', pkgName: 'x', patchedVersion: '1.0.0' }), null);
  assert.strictEqual(classifyNpm({ lockJson: { packages: {} }, pkgName: 'x', patchedVersion: null }), null);
});

test('pyprojectConstraint reads the common spellings', () => {
  const py = `dependencies = [\n  "cryptography>=42.0",\n  "pytest >= 8.0",\n]`;
  assert.strictEqual(pyprojectConstraint(py, 'cryptography'), '>=42.0');
  assert.strictEqual(pyprojectConstraint(py, 'pytest'), '>= 8.0');
  assert.strictEqual(pyprojectConstraint(py, 'absent'), null);
});

test('pyprojectConstraint handles extras, and normalises - vs _', () => {
  assert.strictEqual(pyprojectConstraint('"uvicorn[standard]>=0.30"', 'uvicorn'), '>=0.30');
  assert.strictEqual(pyprojectConstraint('"typing-extensions>=4.0"', 'typing_extensions'), '>=4.0');
});

test('classifyPip: constraint admits the fix → refresh; excludes it → upstream', () => {
  assert.strictEqual(classifyPip({
    pyprojectText: '"cryptography>=42.0"', pkgName: 'cryptography', patchedVersion: '50.0.0',
  }), 'refresh');
  assert.strictEqual(classifyPip({
    pyprojectText: '"cryptography>=42.0,<50"', pkgName: 'cryptography', patchedVersion: '50.0.0',
  }), 'upstream');
  assert.strictEqual(classifyPip({
    pyprojectText: '"other>=1"', pkgName: 'cryptography', patchedVersion: '50.0.0',
  }), null);
});

test('an unconstrained python dependency is a refresh', () => {
  assert.strictEqual(classifyPip({
    pyprojectText: 'dependencies = ["cryptography"]', pkgName: 'cryptography', patchedVersion: '50.0.0',
  }), 'refresh');
});

test('refreshCommand names the directory the manifest lives in', () => {
  assert.strictEqual(
    refreshCommand('pip', 'cryptography', 'tools/remote-config/uv.lock'),
    'cd tools/remote-config && uv lock --upgrade-package cryptography');
  assert.strictEqual(refreshCommand('npm', '@babel/core', 'package-lock.json'), 'npm update @babel/core');
  assert.strictEqual(refreshCommand('cargo', 'x', 'Cargo.lock'), null, 'unknown ecosystems get no command');
});
