#!/usr/bin/env node

const path = require('path');
const fs = require('fs');

const [,, command, ...args] = process.argv;

function usage() {
  console.log(`
build-studio — Mission control for multi-agent Claude Code workflows

Usage:
  build-studio init <path> [--port <port>] [--name <name>] [--workspace <ws>]
  build-studio start [path]
  build-studio hub [--port <port>]
  build-studio register <path> [--workspace <ws>]
  build-studio list [--workspace <ws>]
  build-studio list-presets [path]

Commands:
  init <path>       Scaffold a new project and register it
  start [path]      Start project server directly (default: current dir)
  hub               Start the hub app (project switcher + UI)
  register <path>   Register an existing project in the hub
  list              List all registered projects (grouped by workspace)
  list-presets      List available presets (built-in + custom)

Options:
  --port <port>         Port for the server (default: auto-assigned)
  --name <name>         Project name (default: directory name)
  --workspace <ws>      Workspace/namespace to group projects (optional)
`);
  process.exit(1);
}

if (!command || command === '--help' || command === '-h') usage();

if (command === 'init') {
  const targetArg = args.find(a => !a.startsWith('--'));
  if (!targetArg) {
    console.error('Error: path required. Usage: build-studio init <path>');
    process.exit(1);
  }

  const targetPath = path.resolve(targetArg);
  const { registry } = require('@build-studio/shared');

  let port = null;
  let name = path.basename(targetPath);
  let workspace = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = parseInt(args[i + 1]);
    if (args[i] === '--name' && args[i + 1]) name = args[i + 1];
    if (args[i] === '--workspace' && args[i + 1]) workspace = args[i + 1];
  }

  // Auto-assign port if not specified
  if (!port) port = registry.nextAvailablePort();

  if (fs.existsSync(path.join(targetPath, '.build-studio', 'config.yaml'))) {
    console.error(`Error: project already initialized at ${targetPath}`);
    process.exit(1);
  }

  // Collision check
  const existing = registry.findByName(name);
  if (existing) {
    console.error(`Error: a project named "${name}" is already registered (path: ${existing.path}).`);
    console.error('Use --name <other-name> or --workspace <workspace> to disambiguate.');
    process.exit(1);
  }

  console.log(`\nScaffolding project at ${targetPath}...\n`);

  const { scaffoldProject } = require('@build-studio/project-server/lib/scaffold');
  try {
    scaffoldProject(targetPath, { name, port });

    // Register in hub registry
    registry.add(name, targetPath, port, workspace);
    const wsTag = workspace ? ` [${workspace}]` : '';
    console.log(`  Registered in hub as "${name}"${wsTag} (port ${port})`);

    console.log(`
Done! Next steps:
  1. Add input documents to docs/inputs/
  2. Optionally adjust roles in .build-studio/config.yaml
  3. Start dashboard: build-studio start ${targetPath}
     Or use the hub: build-studio hub
  4. Run kickoff workflow
`);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

} else if (command === 'start') {
  const projectPath = args.find(a => !a.startsWith('--'));
  const projectRoot = path.resolve(projectPath || '.');

  if (!fs.existsSync(path.join(projectRoot, '.build-studio', 'config.yaml'))) {
    console.error(`Error: no .build-studio/config.yaml found in ${projectRoot}`);
    console.error('Run "build-studio init <path>" to create a project first.');
    process.exit(1);
  }

  const { startServer } = require('@build-studio/project-server/lib/server');
  try {
    startServer(projectRoot);
  } catch (e) {
    console.error(`Error: ${e.message}`);
    process.exit(1);
  }

} else if (command === 'hub') {
  let port = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = parseInt(args[i + 1]);
  }

  const { constants, processManager } = require('@build-studio/shared');
  const hubPort = port || constants.DEFAULT_HUB_PORT;

  // Reconcile stale PIDs
  const stale = processManager.reconcile();
  if (stale.length > 0) console.log(`Cleaned up ${stale.length} stale process(es)`);

  // Start the Next.js hub
  const hubDir = path.join(__dirname, '..', 'packages', 'hub');
  const { execSync, spawn: spawnProcess } = require('child_process');

  // Check if hub has been built or if we should use dev mode
  const useDevMode = args.includes('--dev') || !fs.existsSync(path.join(hubDir, '.next'));

  if (useDevMode) {
    console.log(`\nStarting Build Studio Hub (dev) on http://localhost:${hubPort}\n`);
    const child = spawnProcess('npx', ['next', 'dev', '--port', String(hubPort)], {
      cwd: hubDir,
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.on('exit', (code) => process.exit(code || 0));
  } else {
    console.log(`\nStarting Build Studio Hub on http://localhost:${hubPort}\n`);
    const child = spawnProcess('npx', ['next', 'start', '--port', String(hubPort)], {
      cwd: hubDir,
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.on('exit', (code) => process.exit(code || 0));
  }

} else if (command === 'register') {
  const targetArg = args.find(a => !a.startsWith('--'));
  if (!targetArg) {
    console.error('Error: path required. Usage: build-studio register <path>');
    process.exit(1);
  }

  const targetPath = path.resolve(targetArg);
  const configPath = path.join(targetPath, '.build-studio', 'config.yaml');

  if (!fs.existsSync(configPath)) {
    console.error(`Error: no .build-studio/config.yaml found in ${targetPath}`);
    process.exit(1);
  }

  const { registry } = require('@build-studio/shared');
  const yaml = require('js-yaml');
  const config = yaml.load(fs.readFileSync(configPath, 'utf8'));
  const name = config.name || path.basename(targetPath);

  // Check if already registered by path
  const existing = registry.findByPath(targetPath);
  if (existing) {
    console.log(`Already registered as "${existing.name}" (port ${existing.port})`);
    process.exit(0);
  }

  // Always auto-assign to avoid port conflicts; --port flag overrides
  let port = registry.nextAvailablePort();
  let workspace = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = parseInt(args[i + 1]);
    if (args[i] === '--workspace' && args[i + 1]) workspace = args[i + 1];
  }

  // Collision check by name
  const nameCollision = registry.findByName(name);
  if (nameCollision) {
    console.error(`Error: a project named "${name}" is already registered (path: ${nameCollision.path}).`);
    console.error('Use --workspace <workspace> to register under a different namespace.');
    process.exit(1);
  }

  registry.add(name, targetPath, port, workspace);
  const wsTag = workspace ? ` [${workspace}]` : '';
  console.log(`Registered "${name}"${wsTag} at ${targetPath} (port ${port})`);

} else if (command === 'list') {
  const { registry } = require('@build-studio/shared');

  let filterWorkspace = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--workspace' && args[i + 1]) filterWorkspace = args[i + 1];
  }

  const projects = registry.list().filter(p => !filterWorkspace || p.workspace === filterWorkspace);

  if (projects.length === 0) {
    const hint = filterWorkspace ? ` in workspace "${filterWorkspace}"` : '';
    console.log(`\nNo projects registered${hint}. Use "build-studio init <path>" to create one.\n`);
    process.exit(0);
  }

  // Group by workspace for display
  const groups = new Map();
  for (const p of projects) {
    const ws = p.workspace || null;
    if (!groups.has(ws)) groups.set(ws, []);
    groups.get(ws).push(p);
  }

  console.log(`\n  Registered projects (${projects.length}):\n`);
  for (const [ws, group] of groups) {
    if (ws) console.log(`  [${ws}]`);
    for (const p of group) {
      const indent = ws ? '    ' : '  ';
      console.log(`${indent}${p.name}`);
      console.log(`${indent}  Path: ${p.path}`);
      console.log(`${indent}  Port: ${p.port}`);
      console.log('');
    }
  }

} else if (command === 'list-presets') {
  const projectPath = args.find(a => !a.startsWith('--'));
  const projectRoot = projectPath ? path.resolve(projectPath) : process.cwd();
  const hasProject = fs.existsSync(path.join(projectRoot, '.build-studio', 'config.yaml'));

  const { listPresets } = require('@build-studio/project-server/lib/presets');
  const presets = listPresets(hasProject ? projectRoot : null);

  console.log(`\n  Available presets (${presets.length}):\n`);
  for (const p of presets) {
    const tag = p.source !== 'builtin' ? ` [${p.source}]` : '';
    console.log(`  ${p.name}${tag}`);
    if (p.description) console.log(`    ${p.description}`);
    console.log(`    Roles:    ${[...p.roles.review, ...p.roles.execution, ...p.roles.standalone].join(', ')}`);
    console.log('');
  }

} else {
  console.error(`Unknown command: ${command}`);
  usage();
}
