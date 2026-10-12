'use strict';

// qa_validation.js_scope=changed: QA runs the JS tests a branch can affect, not
// the whole suite that the project's CI already runs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { jsScopeSection, builderJsScopeGuidance, scopeByPackage, runnerOf } = require('./js-test-scope');

const ROOT = '/repo';
const PACKAGES = { web: { scripts: { test: 'vitest run' } }, '': { name: 'root' } };
const exists = (p) => Object.keys(PACKAGES).some((d) => p === `${ROOT}/${d ? `${d}/` : ''}package.json`);
const readPackage = (dir) => PACKAGES[dir] || null;
const SCOPED = { qa_validation: { js_scope: 'changed' } };
const opts = (changedFiles) => ({ projectRoot: ROOT, changedFiles, readPackage, exists });

// The fazon FAZ-424 favicon branch.
const FAVICON = [
  'ARCHITECTURE.md',
  'docs/pr-evidence/PRD-213-website-favicon/README.md',
  'web/public/apple-touch-icon.png',
  'web/public/icon.svg',
  'web/scripts/favicon/render.mjs',
  'web/scripts/gates/seo',
  'web/src/layouts/SiteLayout.astro',
  'web/tests/favicon.test.ts',
];

test('off unless the project opts in', () => {
  assert.equal(jsScopeSection({}, opts(FAVICON)), '');
  assert.equal(jsScopeSection({ qa_validation: { scope: 'new-uitests' } }, opts(FAVICON)), '');
  assert.equal(builderJsScopeGuidance({}), '');
});

test('a favicon branch runs its own test and the tests related to what it changed, not npm test', () => {
  const s = jsScopeSection(SCOPED, opts(FAVICON));
  assert.match(s, /In `web\/` \(vitest\)/);
  assert.match(s, /cd web\nnpx vitest run tests\/favicon\.test\.ts\nnpx vitest related --run scripts\/favicon\/render\.mjs src\/layouts\/SiteLayout\.astro/);
  assert.match(s, /Do \*\*NOT\*\* run the full JS test suite/);
  assert.doesNotMatch(s, /in full/);
});

test('a change to the manifest, lockfile or runner config runs that package in full', () => {
  for (const file of ['web/package.json', 'web/package-lock.json', 'web/vitest.config.ts', 'web/tsconfig.json']) {
    const [pkg] = scopeByPackage(opts(['web/src/a.ts', file]));
    assert.match(pkg.fullBecause, /every test in the package depends on/, file);
    assert.match(jsScopeSection(SCOPED, opts([file])), /in full\*\*[\s\S]*cd web\nnpm test/, file);
  }
});

test('a docs-only branch needs no JS run', () => {
  assert.match(jsScopeSection(SCOPED, opts(['docs/prds/PRD-1.md', 'README.md'])), /no JS test run is required/);
});

test('an unreadable diff falls back to the full suite', () => {
  assert.match(jsScopeSection(SCOPED, opts(null)), /could not be read, so run the JS suite in full/);
});

test('a package with no vitest or jest runs its own npm test', () => {
  const [pkg] = scopeByPackage(opts(['x.test.js']));
  assert.equal(pkg.dir, '');
  assert.match(pkg.fullBecause, /neither vitest nor jest/);
});

test('runner detection', () => {
  assert.equal(runnerOf({ scripts: { test: 'vitest run' } }), 'vitest');
  assert.equal(runnerOf({ scripts: { test: 'jest --ci' } }), 'jest');
  assert.equal(runnerOf({ devDependencies: { vitest: '^5' } }), 'vitest');
  assert.equal(runnerOf({ scripts: { test: 'node --test' } }), null);
  assert.equal(runnerOf(null), null);
});

test('the builder gets the same rule', () => {
  assert.match(builderJsScopeGuidance(SCOPED, 'develop'), /do NOT run the full JS suite[\s\S]*vitest related --run[\s\S]*develop\.\.\.HEAD/);
});
