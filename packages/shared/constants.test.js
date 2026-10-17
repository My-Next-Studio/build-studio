'use strict';

// Tests never reach the owner's real ~/.build-studio or ~/.claude.json: a test
// process gets a home of its own (see constants.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const constants = require('./constants');

test('under the test runner, every home path is a temp folder of its own', () => {
  assert.equal(constants.UNDER_TEST, true);
  assert.notEqual(constants.BUILD_STUDIO_DIR, path.join(os.homedir(), '.build-studio'));
  assert.ok(constants.BUILD_STUDIO_DIR.startsWith(fs.realpathSync(os.tmpdir())) || constants.BUILD_STUDIO_DIR.startsWith(os.tmpdir()));
  assert.ok(fs.existsSync(constants.BUILD_STUDIO_DIR));
  for (const p of [constants.REGISTRY_PATH, constants.PIDS_DIR, constants.LEARNINGS_DIR, constants.CLAUDE_CONFIG_PATH]) {
    assert.ok(p.startsWith(constants.BUILD_STUDIO_DIR), p);
  }
});

test('outside the test runner, the real home is used; BUILD_STUDIO_HOME overrides it', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.BUILD_STUDIO_HOME;
  const read = (extra = {}) => JSON.parse(execFileSync(process.execPath, ['-e',
    `const c = require(${JSON.stringify(require.resolve('./constants'))}); console.log(JSON.stringify({ dir: c.BUILD_STUDIO_DIR, claude: c.CLAUDE_CONFIG_PATH, underTest: c.UNDER_TEST }))`,
  ], { env: { ...env, ...extra }, encoding: 'utf8' }));
  assert.deepEqual(read(), { dir: path.join(os.homedir(), '.build-studio'), claude: path.join(os.homedir(), '.claude.json'), underTest: false });
  assert.equal(read({ BUILD_STUDIO_HOME: '/somewhere/else' }).dir, '/somewhere/else');
});
