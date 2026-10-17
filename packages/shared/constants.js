const path = require('path');
const os = require('os');
const fs = require('fs');

// Under the test runner, nothing a test does may reach the owner's real files.
// Tests that drive a workflow to completion used to run learnings maintenance
// against ~/.build-studio/learnings, append fixture runs to the decision
// layer's shadow log (after a paid call with the owner's key, because the
// decisions config was read from ~/.build-studio/config.json), and seed folder
// trust for thousands of temp fixture repos into ~/.claude.json. A test
// process (`node --test` sets NODE_TEST_CONTEXT in every file it runs, and a
// spawned server inherits it; a test file run directly is matched by name)
// gets an empty home of its own instead, removed when it exits.
// BUILD_STUDIO_HOME overrides both.
const UNDER_TEST = Boolean(process.env.NODE_TEST_CONTEXT) || /\.test\.[cm]?js$/.test(process.argv[1] || '');

function testHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-studio-test-home-'));
  process.on('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ } });
  return dir;
}

const BUILD_STUDIO_DIR = process.env.BUILD_STUDIO_HOME
  || (UNDER_TEST ? testHome() : path.join(os.homedir(), '.build-studio'));
const REGISTRY_PATH = path.join(BUILD_STUDIO_DIR, 'registry.json');
const PIDS_DIR = path.join(BUILD_STUDIO_DIR, 'pids');
// Cross-project shared learnings — agents read from here across all projects
const LEARNINGS_DIR = path.join(BUILD_STUDIO_DIR, 'learnings');
// Claude Code's own config, where folder trust is seeded (claude-trust.js).
// Under test it lives in the test home, never in the owner's ~/.claude.json.
const CLAUDE_CONFIG_PATH = UNDER_TEST
  ? path.join(BUILD_STUDIO_DIR, '.claude.json')
  : path.join(os.homedir(), '.claude.json');
const DEFAULT_HUB_PORT = 18080;
const DEFAULT_PROJECT_PORT_START = 3001;

module.exports = {
  UNDER_TEST,
  BUILD_STUDIO_DIR,
  REGISTRY_PATH,
  PIDS_DIR,
  LEARNINGS_DIR,
  CLAUDE_CONFIG_PATH,
  DEFAULT_HUB_PORT,
  DEFAULT_PROJECT_PORT_START,
};
