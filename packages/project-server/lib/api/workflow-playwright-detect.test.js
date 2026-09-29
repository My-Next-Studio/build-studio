'use strict';

// QA prompts told every JS/TS project to run `npx playwright test`. fazon's web
// app runs its browser tests in Vitest and has no Playwright config, so QA
// reported "a check could not run" for a runner the project never used.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findPlaywrightConfigs } = require('./workflow');

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-pw-'));
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), ''); }
  return root;
}

test('finds a config at the root, one level down, and in packages/*', () => {
  const root = tree(['playwright.config.ts', 'e2e/playwright.config.mjs', 'packages/site/playwright.config.js', 'node_modules/x/playwright.config.ts']);
  assert.deepEqual(findPlaywrightConfigs(root).sort(), ['e2e/playwright.config.mjs', 'packages/site/playwright.config.js', 'playwright.config.ts']);
});

test('a Vitest-only web app has none', () => {
  const root = tree(['web/vitest.config.ts', 'web/package.json']);
  assert.deepEqual(findPlaywrightConfigs(root), []);
});

test('the QA prompt only prescribes Playwright when a config exists', () => {
  const src = fs.readFileSync(path.join(__dirname, 'workflow.js'), 'utf8');
  assert.doesNotMatch(src, /plus Playwright \(\\`npx playwright test\\`\) for E2E/);
  assert.match(src, /playwrightConfigs\.length \? `Playwright is configured/);
  assert.match(src, /This project has \*\*no Playwright config\*\*: do NOT run/);
});
