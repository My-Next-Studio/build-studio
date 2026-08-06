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

// ─── npm's own verdict ───────────────────────────────────────────────────────
// The case that proved the range math asks the wrong question: miniflare pins
// undici exactly, so classifyNpm says 'upstream' — but wrangler (within its own
// allowed range) ships a miniflare with the patch, so npm says fixAvailable.

const AUDIT = (fixAvailable, ghsa = 'GHSA-vmh5-xxxx-yyyy', changed = 1) => ({
  added: 0, removed: 0, changed,
  audit: {
    vulnerabilities: {
      undici: {
        name: 'undici',
        via: [{ name: 'undici', url: `https://github.com/advisories/${ghsa}` }],
        fixAvailable,
      },
    },
  },
});

test('npm audit overrides the range math when a parent bump reaches the fix', () => {
  const { classifyNpmFromAuditFix } = require('./fix-reachability');
  assert.deepStrictEqual(
    classifyNpmFromAuditFix(AUDIT(true), 'undici', 'GHSA-vmh5-xxxx-yyyy'),
    { verdict: 'refresh' });

  // ...and the range math on the same shape still says upstream, which is
  // exactly the disagreement this exists to settle.
  const lock = { packages: { 'node_modules/miniflare': { dependencies: { undici: '7.24.8' } } } };
  assert.strictEqual(
    classifyNpm({ lockJson: lock, pkgName: 'undici', patchedVersion: '7.28.0' }), 'upstream');
});

test('fixAvailable: true but a no-op plan is NOT a fix', () => {
  // The bug this replaced: `npm audit fix` answered "up to date", left the
  // advisories in place, and told the user to run `npm audit fix` — a loop.
  // npm reported fixAvailable: true with added/removed/changed all zero, on
  // both affected projects. npm's PLAN is believed, not its summary.
  const { classifyNpmFromAuditFix } = require('./fix-reachability');
  assert.deepStrictEqual(
    classifyNpmFromAuditFix(AUDIT(true, 'GHSA-vmh5-xxxx-yyyy', 0), 'undici', 'GHSA-vmh5-xxxx-yyyy'),
    { verdict: 'upstream' });
  // ...and a semver-major object is equally powerless when nothing would change.
  assert.deepStrictEqual(
    classifyNpmFromAuditFix(
      AUDIT({ name: 'wrangler', version: '5.0.0', isSemVerMajor: true }, 'GHSA-vmh5-xxxx-yyyy', 0),
      'undici', 'GHSA-vmh5-xxxx-yyyy'),
    { verdict: 'upstream' });
});

test('fixAvailable false is a real upstream block', () => {
  const { classifyNpmFromAuditFix } = require('./fix-reachability');
  assert.deepStrictEqual(
    classifyNpmFromAuditFix(AUDIT(false), 'undici', 'GHSA-vmh5-xxxx-yyyy'), { verdict: 'upstream' });
});

test('a fix needing a semver-major parent bump is a decision, and names its subject', () => {
  const { classifyNpmFromAuditFix, breakingCommand } = require('./fix-reachability');
  const r = classifyNpmFromAuditFix(
    AUDIT({ name: 'wrangler', version: '5.0.0', isSemVerMajor: true }), 'undici', 'GHSA-vmh5-xxxx-yyyy');
  assert.strictEqual(r.verdict, 'breaking');
  assert.deepStrictEqual(r.fix, { name: 'wrangler', version: '5.0.0' });
  assert.strictEqual(breakingCommand(r.fix, 'package-lock.json'), 'npm install wrangler@5.0.0');
});

test('a non-major object fixAvailable is just a refresh', () => {
  const { classifyNpmFromAuditFix } = require('./fix-reachability');
  assert.deepStrictEqual(
    classifyNpmFromAuditFix(
      AUDIT({ name: 'wrangler', version: '4.119.0', isSemVerMajor: false }), 'undici', 'GHSA-vmh5-xxxx-yyyy'),
    { verdict: 'refresh' });
});

test('an audit entry that does not mention OUR advisory decides nothing', () => {
  // fixAvailable is per package, so an entry about a different GHSA for the same
  // package is not evidence about this one.
  const { classifyNpmFromAuditFix } = require('./fix-reachability');
  assert.strictEqual(
    classifyNpmFromAuditFix(AUDIT(true, 'GHSA-aaaa-bbbb-cccc'), 'undici', 'GHSA-zzzz-yyyy-xxxx'), null);
  // Without a GHSA to match on, the package-level verdict is the best available.
  assert.deepStrictEqual(classifyNpmFromAuditFix(AUDIT(true), 'undici', null), { verdict: 'refresh' });
});

test('a missing package or malformed audit decides nothing', () => {
  const { classifyNpmFromAuditFix } = require('./fix-reachability');
  assert.strictEqual(classifyNpmFromAuditFix(AUDIT(true), 'absent', null), null);
  assert.strictEqual(classifyNpmFromAuditFix({}, 'undici', null), null);
  assert.strictEqual(classifyNpmFromAuditFix(null, 'undici', null), null);
  assert.strictEqual(classifyNpmFromAuditFix({ vulnerabilities: { undici: { fixAvailable: 'maybe' } } }, 'undici', null), null);
});

test('refreshCommand for npm is audit fix, not update <pkg>', () => {
  // `npm update undici` does nothing when miniflare pins it; the fix is upstream
  // in the chain, which is what audit fix resolves.
  assert.strictEqual(refreshCommand('npm', 'undici', 'package-lock.json'), 'npm audit fix');
});

test('refreshCommand names the directory the manifest lives in', () => {
  assert.strictEqual(
    refreshCommand('pip', 'cryptography', 'tools/remote-config/uv.lock'),
    'cd tools/remote-config && uv lock --upgrade-package cryptography');
  assert.strictEqual(refreshCommand('npm', '@babel/core', 'package-lock.json'), 'npm audit fix');
  assert.strictEqual(refreshCommand('npm', 'x', 'apps/web/package-lock.json'), 'cd apps/web && npm audit fix');
  assert.strictEqual(refreshCommand('cargo', 'x', 'Cargo.lock'), null, 'unknown ecosystems get no command');
});

// ─── `npm update` as the second opinion ──────────────────────────────────────
// The gap that sent a real fix out as "blocked upstream": `npm audit fix` only
// bumps along the advisory's own chain, so it missed that tsx ^4.21.0 — already
// permitted by package.json — carries a patched esbuild at 4.23.8.

const PLAN = `
add @humanfs/types 0.15.0
change tsx 4.21.0 => 4.23.8
change esbuild 0.27.4 => 0.28.1
remove get-tsconfig 4.14.0
`;

test('parses npm update\'s text plan (it ignores --json)', () => {
  const { parseNpmUpdatePlan } = require('./fix-reachability');
  const p = parseNpmUpdatePlan(PLAN);
  assert.strictEqual(p.get('tsx'), '4.23.8');
  assert.strictEqual(p.get('esbuild'), '0.28.1');
  assert.strictEqual(p.get('@humanfs/types'), '0.15.0', 'add lines count too');
  assert.strictEqual(p.has('get-tsconfig'), false, 'a removal is not a resulting version');
});

test('a plan that reaches the patch is a refresh; one that falls short is not', () => {
  const { parseNpmUpdatePlan, classifyNpmFromUpdatePlan } = require('./fix-reachability');
  const p = parseNpmUpdatePlan(PLAN);
  assert.strictEqual(classifyNpmFromUpdatePlan(p, 'esbuild', '0.28.1'), 'refresh');
  assert.strictEqual(classifyNpmFromUpdatePlan(p, 'esbuild', '0.29.0'), null,
    'landing short of the patch is no fix at all');
  assert.strictEqual(classifyNpmFromUpdatePlan(p, 'undici', '7.29.0'), null,
    'a package the plan never touches gets no verdict');
});

test('the suggested command names the parents, not a blanket npm update', () => {
  // Bare `npm update` would also move every other dependency in the project.
  const { parseNpmUpdatePlan, npmUpdateTargets } = require('./fix-reachability');
  const lock = { packages: {
    'node_modules/tsx': { dependencies: { esbuild: '~0.27.0' } },
    'node_modules/vite': { dependencies: { esbuild: '^0.27.0 || ^0.28.0' } },
  } };
  // vite already permits the fix and so is not in the plan; only tsx moves.
  assert.deepStrictEqual(
    npmUpdateTargets(parseNpmUpdatePlan(PLAN), lock, 'esbuild'), ['tsx']);
});

test('nested lock keys resolve to the package name', () => {
  const { packageNameFromLockKey } = require('./fix-reachability');
  assert.strictEqual(packageNameFromLockKey('node_modules/tsx'), 'tsx');
  assert.strictEqual(packageNameFromLockKey('node_modules/a/node_modules/b'), 'b');
  assert.strictEqual(packageNameFromLockKey('node_modules/@scope/pkg'), '@scope/pkg');
  assert.strictEqual(packageNameFromLockKey(''), null);
});

test('a malformed plan yields no opinion', () => {
  const { parseNpmUpdatePlan, classifyNpmFromUpdatePlan } = require('./fix-reachability');
  assert.strictEqual(parseNpmUpdatePlan('garbage\nlines\n').size, 0);
  assert.strictEqual(classifyNpmFromUpdatePlan(null, 'x', '1.0.0'), null);
  assert.strictEqual(classifyNpmFromUpdatePlan(new Map([['x', 'not-a-version']]), 'x', '1.0.0'), null);
});
