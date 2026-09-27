'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { resolveScreenshotCommand, qaScreenshotInstructions, builderScreenshotInstructions } = require('./screenshot-tool');

test('resolveScreenshotCommand reads features.screenshot_command and ignores blanks', () => {
  assert.equal(resolveScreenshotCommand({ features: { screenshot_command: '  npm run -s screenshot --  ' } }), 'npm run -s screenshot --');
  assert.equal(resolveScreenshotCommand({ features: { screenshot_command: '' } }), null);
  assert.equal(resolveScreenshotCommand({ features: {} }), null);
  assert.equal(resolveScreenshotCommand({}), null);
});

test('QA instructions name the command, the evidence path, and require looking at the PNG', () => {
  const t = qaScreenshotInstructions('npm run -s screenshot --', 'PRD-070-title');
  assert.match(t, /`npm run -s screenshot -- list`/);
  assert.match(t, /docs\/pr-evidence\/PRD-070-title\/visual\/<view-id>\.png/);
  assert.match(t, /open each PNG and look at it/);
  assert.match(t, /stretched to the container width/);
  assert.match(t, /\*\*Gate could not run:\*\*/);
});

test('builder instructions tell a UI builder to render and inspect before reporting done', () => {
  const t = builderScreenshotInstructions('npm run -s screenshot --');
  assert.match(t, /LOOK AT WHAT YOU BUILT/);
  assert.match(t, /npm run -s screenshot -- <view-id> \/tmp\/<view-id>\.png/);
  assert.match(t, /add one to the harness in the same task/);
});

// The QA step used to declare visual smoke NOT APPLICABLE whenever there was
// no browser and no simulator — which is every desktop app.
test('QA treats a screenshot command as a visual-smoke target, and builders get the section', () => {
  const src = fs.readFileSync(path.join(__dirname, 'api', 'workflow.js'), 'utf8');
  assert.match(src, /const hasVisualSmokeTarget2 = !!\(hasBrowserTesting2 \|\| \(config\.simulator && config\.simulator\.destination\) \|\| shotCmd2\);/);
  assert.match(src, /\? qaScreenshotInstructions\(shotCmd2,/);
  assert.match(src, /\$\{designContext\}\$\{screenshotContext\}/);
  assert.match(src, /if \(shotCmdR && \/frontend\|fullstack\/i\.test\(r\.role\)\) designContext \+= builderScreenshotInstructions\(shotCmdR\);/);
});
