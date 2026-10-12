'use strict';

/**
 * Which JS/TS tests QA runs when a project sets `qa_validation.js_scope: changed`.
 *
 * QA ran the project's whole JS suite (`npm test`) on every story. On fazon that
 * is ~180 test files run serially, 35-40 minutes, and it ran for a story that
 * only added a favicon (FAZ-424, 2026-10-12), while the project's CI runs the
 * same suite on every pull request and on main anyway. A project whose CI owns
 * the full run can narrow QA to what the branch can affect:
 *
 *   - the test files the branch adds or modifies, run directly;
 *   - the tests that import a source file the branch changed (`vitest related`,
 *     `jest --findRelatedTests`), so a change to shared code still reaches every
 *     test that uses it.
 *
 * A change to what every test depends on (the package manifest, the lockfile,
 * the runner or bundler config, a tsconfig) still runs that package's suite in
 * full: no import graph sees it. The same goes for a package whose runner is
 * neither vitest nor jest, since there is no related-tests command to give.
 *
 * Mirrors `qa_validation.scope: new-uitests`, which does the same for XCUITests.
 */

const fs = require('fs');
const path = require('path');

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.([cm]?[jt]sx?|astro|vue|svelte|json)$/;
// Inputs every test in the package depends on, which no import graph sees.
const SUITE_INPUT = /(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|(vitest|vite|astro|jest)\.config\.[cm]?[jt]s|tsconfig[^/]*\.json)$/;

/** The nearest directory at or above `fileRel` (within the project) with a package.json. */
function packageDirOf(projectRoot, fileRel, exists = fs.existsSync) {
  let dir = path.posix.dirname(fileRel);
  for (;;) {
    const rel = dir === '.' ? '' : dir;
    if (exists(path.join(projectRoot, rel, 'package.json'))) return rel;
    if (dir === '.' || dir === '') return null;
    dir = path.posix.dirname(dir);
  }
}

/** 'vitest', 'jest' or null, from the package's test script and dependencies. */
function runnerOf(pkg) {
  if (!pkg) return null;
  const script = String((pkg.scripts && pkg.scripts.test) || '');
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  if (/\bvitest\b/.test(script) || (!script && deps.vitest)) return 'vitest';
  if (/\bjest\b/.test(script) || (!script && deps.jest)) return 'jest';
  if (deps.vitest && !/\bjest\b/.test(script)) return 'vitest';
  if (deps.jest) return 'jest';
  return null;
}

/**
 * Group a branch's changed files by package.
 *
 * @param {object} p
 * @param {string} p.projectRoot
 * @param {string[]} p.changedFiles  repo-relative, added or modified (deleted files excluded)
 * @param {(dir: string) => object|null} [p.readPackage]  test seam
 * @param {(file: string) => boolean} [p.exists]          test seam
 * @returns {{dir: string, runner: string|null, tests: string[], sources: string[], fullBecause: string|null}[]}
 *   one entry per package with JS work; paths are relative to the package dir.
 */
function scopeByPackage({ projectRoot, changedFiles, readPackage, exists = fs.existsSync }) {
  const read = readPackage || ((dir) => {
    try { return JSON.parse(fs.readFileSync(path.join(projectRoot, dir, 'package.json'), 'utf8')); } catch (_) { return null; }
  });
  const byDir = new Map();
  for (const file of changedFiles || []) {
    const isTest = TEST_FILE.test(file);
    const isInput = SUITE_INPUT.test(file);
    if (!isTest && !isInput && !SOURCE_FILE.test(file)) continue;
    const dir = packageDirOf(projectRoot, file, exists);
    if (dir === null) continue;
    if (!byDir.has(dir)) byDir.set(dir, { dir, runner: runnerOf(read(dir)), tests: [], sources: [], fullBecause: null });
    const entry = byDir.get(dir);
    const rel = dir ? file.slice(dir.length + 1) : file;
    if (isInput) entry.fullBecause = entry.fullBecause || `it changes \`${rel}\`, which every test in the package depends on`;
    else if (isTest) entry.tests.push(rel);
    else entry.sources.push(rel);
  }
  // A package with no runner, or a json-only change in a package nothing tests, is
  // dropped unless it changed a test file: there is nothing to run there.
  return [...byDir.values()].filter((e) => e.runner || e.tests.length || e.fullBecause)
    .map((e) => (e.runner ? e : { ...e, fullBecause: e.fullBecause || 'its test runner is neither vitest nor jest, so there is no related-tests command' }));
}

const shellQuote = (s) => (/^[A-Za-z0-9_./@:+=-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/** The commands for one package, as prompt lines. */
function packageCommands(e) {
  const cd = e.dir ? `cd ${shellQuote(e.dir)}\n` : '';
  if (e.fullBecause) return `${cd}npm test`;
  const lines = [];
  const tests = e.tests.map(shellQuote).join(' ');
  const sources = e.sources.map(shellQuote).join(' ');
  if (e.runner === 'vitest') {
    if (tests) lines.push(`npx vitest run ${tests}`);
    if (sources) lines.push(`npx vitest related --run ${sources}`);
  } else {
    if (tests) lines.push(`npx jest ${tests}`);
    if (sources) lines.push(`npx jest --findRelatedTests ${sources}`);
  }
  return cd + lines.join('\n');
}

/**
 * The QA prompt section for a scoped JS run, or '' when the project runs the
 * full suite. `changedFiles` null means the diff could not be read: say so and
 * fall back to the full suite rather than guess.
 */
function jsScopeSection(config, { projectRoot, changedFiles, baseBranch = 'main', readPackage, exists } = {}) {
  if (!config || !config.qa_validation || config.qa_validation.js_scope !== 'changed') return '';
  const head = `\n\n## QA SCOPE — CHANGED JS TESTS ONLY (qa_validation.js_scope=changed)\n\n`;
  if (!Array.isArray(changedFiles)) {
    return `${head}The branch's changes versus \`${baseBranch}\` could not be read, so run the JS suite in full this time (\`npm test\` in each package that has one).`;
  }
  const packages = scopeByPackage({ projectRoot, changedFiles, readPackage, exists });
  const intro = 'Do **NOT** run the full JS test suite (`npm test`) unless a package below says to. This project runs it in CI on every pull request and on '
    + `\`${baseBranch}\`, so a full local run per story only repeats CI, at the cost of the longest step in the run. Run only the tests this branch can affect. `
    + 'Typecheck, lint, the build and the project\'s gates still run as usual; they are quick.';
  if (packages.length === 0) {
    return `${head}${intro}\n\nThis branch changes no JS/TS source or test file versus \`${baseBranch}\`, so **no JS test run is required**. `
      + 'Report the counts of whatever else you ran; if nothing produced counts, write `**Tests passed:** 0/0 (no JS changes; js_scope=changed)`.';
  }
  const blocks = packages.map((e) => {
    const where = e.dir ? `In \`${e.dir}/\`` : 'At the project root';
    const runner = e.runner ? ` (${e.runner})` : '';
    const why = e.fullBecause ? `: run this package's suite **in full**, because ${e.fullBecause}` : '';
    return `${where}${runner}${why}:\n\n\`\`\`\n${packageCommands(e)}\n\`\`\``;
  });
  return `${head}${intro}\n\n`
    + 'The first command runs the test files this branch adds or modifies; the `related` one runs every test that imports a source file it changed, '
    + 'so a change to shared code still reaches the tests that use it. If a related run turns out to cover most of the suite, that is what this change can affect: let it run.\n\n'
    + `${blocks.join('\n\n')}\n\n`
    + 'Use these **instead of** `npm test` in step 1 below. A failure here in a test unrelated to this branch is pre-existing: report it as non-blocking.';
}

/** The builder's version: the same scope, as one guidance bullet. */
function builderJsScopeGuidance(config, baseBranch = 'main') {
  if (!config || !config.qa_validation || config.qa_validation.js_scope !== 'changed') return '';
  return `\n- JS/TS tests (this project sets qa_validation.js_scope=changed): do NOT run the full JS suite (\`npm test\`); CI runs it on every pull request. Run the test files you add or modify, plus the tests related to the source files you change (\`npx vitest related --run <files>\` or \`npx jest --findRelatedTests <files>\`, from the package directory). Run the full suite only if you change the package manifest, the lockfile, the test or bundler config, or a tsconfig. List what you changed with \`git diff --name-only --diff-filter=AM ${baseBranch}...HEAD\`.`;
}

module.exports = { jsScopeSection, builderJsScopeGuidance, scopeByPackage, packageDirOf, runnerOf, TEST_FILE, SUITE_INPUT };
