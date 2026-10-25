#!/usr/bin/env node
'use strict';

// The XCUITests this branch must run, for a builder (uitest-scope.js):
//
//   node "$BUILD_STUDIO_UITEST_SCOPE" [base-branch]
//
// Prints one `-only-testing:` flag per line on stdout, ready to pass to
// xcodebuild, and on stderr why each file runs what it runs. Nothing on
// stdout means no XCUITest is required. Run from the repository (or worktree)
// the branch is checked out in.

const { computeUiTestScope } = require('./uitest-scope');

const base = process.argv[2] || 'main';
let scope;
try {
  scope = computeUiTestScope({ cwd: process.cwd(), base });
} catch (e) {
  process.stderr.write(`uitest-scope: could not read the branch against ${base}: ${e.message}\n`);
  process.exit(1);
}
for (const f of scope.files) {
  process.stderr.write(`${f.file}: ${f.mode === 'methods' ? `${f.ids.length} test(s)` : f.mode === 'classes' ? 'whole class' : 'nothing'} (${f.reason})\n`);
}
for (const id of scope.ids) process.stdout.write(`-only-testing:${id}\n`);
