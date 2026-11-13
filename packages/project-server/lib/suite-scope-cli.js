#!/usr/bin/env node
'use strict';

// Which device test suites this branch must run, for a builder (suite-scope.js):
//
//   node "$BUILD_STUDIO_SUITE_SCOPE" [base-branch]
//
// Prints one line per suite: RUN or SKIP, its name and command, and why.
// Reads the suites from $BUILD_STUDIO_SUITE_SPEC, which the start script sets.
// Run it from the repository (or worktree) the branch is checked out in. It
// looks at committed, uncommitted and untracked changes, so run it again
// after your last change.

const { classifySuites, changedFilesSince, formatLine } = require('./suite-scope');

const base = process.argv[2] || 'main';
let suites;
try {
  suites = JSON.parse(process.env.BUILD_STUDIO_SUITE_SPEC || '[]');
} catch (e) {
  process.stderr.write(`suite-scope: BUILD_STUDIO_SUITE_SPEC is not valid JSON (${e.message}); run every suite\n`);
  process.exit(1);
}
let changed = null;
try {
  changed = changedFilesSince({ cwd: process.cwd(), base });
} catch (e) {
  process.stderr.write(`suite-scope: could not read the branch against ${base} (${e.message.split('\n')[0]}); every suite runs\n`);
}
for (const r of classifySuites(suites, changed)) process.stdout.write(`${formatLine(r)}\n`);
