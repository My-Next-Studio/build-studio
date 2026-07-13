#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

// Drop any inherited PORT before we spawn anything. The Electron hub runs on
// PORT=18080 and that value propagates hub → project-server → tmux server →
// agent shells. This server takes its own port via --port (below), never
// process.env.PORT, so removing it here is safe — and it stops project dev
// servers an agent starts (whose port is typically `process.env.PORT ?? <default>`)
// from binding the hub's port and blanking the app. See the agent start script's
// `unset PORT` for the belt-and-suspenders half.
delete process.env.PORT;

// Parse CLI args: --project <path> --port <port>
const args = process.argv.slice(2);
let projectRoot = null;
let portOverride = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project' && args[i + 1]) {
    projectRoot = path.resolve(args[i + 1]);
    i++;
  } else if (args[i] === '--port' && args[i + 1]) {
    portOverride = parseInt(args[i + 1], 10);
    i++;
  } else if (!args[i].startsWith('--')) {
    projectRoot = path.resolve(args[i]);
  }
}

// Fall back to cwd only after args are parsed (avoids crash in Electron where cwd may not exist)
if (!projectRoot) {
  try { projectRoot = process.cwd(); } catch { }
}
if (!projectRoot) {
  console.error('Error: --project <path> is required');
  process.exit(1);
}

const configPath = path.join(projectRoot, '.build-studio', 'config.yaml');
if (!fs.existsSync(configPath)) {
  console.error(`Error: no .build-studio/config.yaml found in ${projectRoot}`);
  process.exit(1);
}

const { startServer } = require('./lib/server');
startServer(projectRoot, { portOverride });
