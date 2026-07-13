const path = require('path');
const os = require('os');

const BUILD_STUDIO_DIR = path.join(os.homedir(), '.build-studio');
const REGISTRY_PATH = path.join(BUILD_STUDIO_DIR, 'registry.json');
const PIDS_DIR = path.join(BUILD_STUDIO_DIR, 'pids');
// Cross-project shared learnings — agents read from here across all projects
const LEARNINGS_DIR = path.join(BUILD_STUDIO_DIR, 'learnings');
const DEFAULT_HUB_PORT = 18080;
const DEFAULT_PROJECT_PORT_START = 3001;

module.exports = {
  BUILD_STUDIO_DIR,
  REGISTRY_PATH,
  PIDS_DIR,
  LEARNINGS_DIR,
  DEFAULT_HUB_PORT,
  DEFAULT_PROJECT_PORT_START,
};
