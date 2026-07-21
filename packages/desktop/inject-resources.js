#!/usr/bin/env node
/**
 * Post-build script: copies the Next.js standalone output (with node_modules)
 * into the packaged .app, bypassing electron-builder's node_modules filtering.
 * Also injects @build-studio/* packages into standalone node_modules.
 */
const { execFileSync } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const syncOnly = process.argv.includes('--sync-only');
const restartProjects = process.argv.includes('--restart-projects');
// --app-resources=<path>: inject into exactly one .app Resources dir (used by
// the electron-builder afterPack hook). Skips /Applications, cache clearing,
// and stale-server handling — packaging must not touch the running install.
const appResourcesArg = process.argv.find(a => a.startsWith('--app-resources='));
const appResourcesOverride = appResourcesArg ? appResourcesArg.split('=').slice(1).join('=') : null;

// Bundle-version stamp written into each .app's project-server lib/ at sync time.
// process-manager.js compares this against the running server's reported version
// on Start; mismatch → auto-restart so freshly-injected code is loaded.
const BUNDLE_VERSION = String(Date.now());

// Find the .app in dist — electron-builder may name it "Build Studio.app" or "build-studio.app"
function findDistApp() {
  const distDir = path.join(__dirname, 'dist', 'mac-arm64');
  if (!fs.existsSync(distDir)) return null;
  const apps = fs.readdirSync(distDir).filter(f => f.endsWith('.app'));
  if (apps.length === 0) return null;
  // Prefer the productName form; fall back to whatever's there
  const preferred = apps.find(a => a === 'Build Studio.app') || apps[0];
  return path.join(distDir, preferred, 'Contents', 'Resources');
}

const installedApp = '/Applications/Build Studio.app/Contents/Resources';

// Target both dist and /Applications if both exist — unless afterPack passed
// an explicit Resources path, in which case inject only there.
const appPaths = appResourcesOverride
  ? [appResourcesOverride]
  : [
      findDistApp(),
      fs.existsSync(installedApp) ? installedApp : null,
    ].filter(Boolean);

if (appPaths.length === 0) {
  console.error('Error: no .app found. Run "npm run build" first.');
  process.exit(1);
}
if (appResourcesOverride && !fs.existsSync(appResourcesOverride)) {
  console.error(`Error: --app-resources path does not exist: ${appResourcesOverride}`);
  process.exit(1);
}

const standaloneSrc = path.join(__dirname, '..', 'hub', '.next', 'standalone');
const staticSrc = path.join(__dirname, '..', 'hub', '.next', 'static');
const sharedSrc = path.join(__dirname, '..', 'shared');
const projectServerSrc = path.join(__dirname, '..', 'project-server');
const publicSrc = path.join(__dirname, '..', 'hub', 'public');

// Collect runtime deps once (shared across targets)
const rootNm = path.join(__dirname, '..', '..', 'node_modules');
const runtimeDeps = ['js-yaml', 'express', 'ws', 'chokidar', 'dotenv', 'node-pty', '@anthropic-ai/sdk'];

function collectDeps(pkgName, visited = new Set()) {
  if (visited.has(pkgName)) return;
  visited.add(pkgName);
  const pkgDir = path.join(rootNm, pkgName);
  const pkgJson = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(pkgJson)) return;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
    for (const dep of Object.keys(pkg.dependencies || {})) {
      collectDeps(dep, visited);
    }
  } catch {}
  return visited;
}

const allDeps = new Set();
for (const dep of runtimeDeps) collectDeps(dep, allDeps);

for (const appPath of appPaths) {
  const standaloneDest = path.join(appPath, 'standalone');

  console.log(`Target: ${appPath}`);

  if (!syncOnly) {
    if (!fs.existsSync(standaloneSrc)) {
      console.error('Error: standalone build not found. Run "npm run build:next" first.');
      process.exit(1);
    }

    console.log('Injecting standalone output into .app...');

    // Remove stale standalone dir first so cp doesn't nest inside it
    if (fs.existsSync(standaloneDest)) fs.rmSync(standaloneDest, { recursive: true, force: true });
    // Copy standalone with dereferenced symlinks (-L) to resolve workspace links
    execFileSync('cp', ['-RLf', standaloneSrc, standaloneDest], { stdio: 'inherit' });

    // Copy static assets into the right place
    const staticDest = path.join(standaloneDest, 'packages', 'hub', '.next', 'static');
    fs.mkdirSync(staticDest, { recursive: true });
    execFileSync('cp', ['-Rf', staticSrc + '/.', staticDest], { stdio: 'inherit' });

    // Copy public assets (avatars, etc.) — Next.js standalone doesn't include public/
    const publicDest = path.join(standaloneDest, 'packages', 'hub', 'public');
    if (fs.existsSync(publicSrc)) {
      fs.mkdirSync(publicDest, { recursive: true });
      execFileSync('cp', ['-Rf', publicSrc + '/.', publicDest], { stdio: 'inherit' });
    }
  } else {
    if (!fs.existsSync(standaloneDest)) {
      console.error(`Error: .app bundle not found at ${appPath}. Skipping.`);
      continue;
    }
    console.log('Syncing @build-studio packages into .app...');
  }

  // Inject @build-studio/shared and @build-studio/project-server into standalone node_modules
  const nmDest = path.join(standaloneDest, 'node_modules', '@build-studio');
  fs.mkdirSync(nmDest, { recursive: true });

  const sharedDest = path.join(nmDest, 'shared');
  const projectServerDest = path.join(nmDest, 'project-server');
  fs.mkdirSync(sharedDest, { recursive: true });
  fs.mkdirSync(projectServerDest, { recursive: true });
  execFileSync('cp', ['-Rf', sharedSrc + '/.', sharedDest], { stdio: 'inherit' });
  execFileSync('cp', ['-Rf', projectServerSrc + '/.', projectServerDest], { stdio: 'inherit' });

  // Stamp the bundle version into project-server lib/.
  // server.js reads this at startup and reports it via /api/health; process-manager.js
  // compares against the on-disk stamp on Start and auto-restarts when they differ.
  fs.writeFileSync(path.join(projectServerDest, 'lib', '.bundle-version'), BUNDLE_VERSION);

  // Copy runtime deps
  let copiedCount = 0;
  for (const dep of allDeps) {
    const src = path.join(rootNm, dep);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(standaloneDest, 'node_modules', dep);
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      execFileSync('cp', ['-RLf', src, dest], { stdio: 'inherit' });
      copiedCount++;
    }
  }
  console.log(`  Runtime deps: ${copiedCount} packages copied (${allDeps.size} total resolved)`);

  // Sync the extraResources copies (Resources/project-server, Resources/shared,
  // Resources/templates). electron-builder refreshes these only on a full
  // package build, but the RUNTIME depends on them between builds — template
  // resolution (scaffold.js/onboard.js) reads Resources/templates/default, so
  // skipping this leaves init/onboard scaffolding stale after a plain inject.
  const templatesSrc = path.join(__dirname, '..', '..', 'templates');
  for (const [src, destName, excludeNm] of [
    [projectServerSrc, 'project-server', true],
    [sharedSrc, 'shared', true],
    [templatesSrc, 'templates', false],
  ]) {
    const dest = path.join(appPath, destName);
    fs.mkdirSync(dest, { recursive: true });
    if (excludeNm) {
      execFileSync('rsync', ['-a', '--exclude', 'node_modules', src + '/', dest + '/'], { stdio: 'inherit' });
    } else {
      execFileSync('cp', ['-Rf', src + '/.', dest], { stdio: 'inherit' });
    }
  }
  console.log('  extraResources: project-server, shared, templates synced');

  // Strip Finder junk copied in from the source tree — codesign refuses to
  // sign bundles containing .DS_Store files, which breaks signed packaging.
  try {
    execFileSync('find', [standaloneDest, '-name', '.DS_Store', '-delete'], { stdio: 'ignore' });
  } catch (_) {}

  // Verify — and fail loudly. A .app without the hub server launches to a
  // black window, so an incomplete injection must never pass silently.
  const hasNodeModules = fs.existsSync(path.join(standaloneDest, 'node_modules'));
  const hasServer = fs.existsSync(path.join(standaloneDest, 'packages', 'hub', 'server.js'));
  const hasShared = fs.existsSync(path.join(nmDest, 'shared', 'process-manager.js'));
  const hasProjectServer = fs.existsSync(path.join(nmDest, 'project-server', 'index.js'));
  console.log(`  node_modules: ${hasNodeModules ? '✓' : '✗'}`);
  console.log(`  server.js: ${hasServer ? '✓' : '✗'}`);
  console.log(`  @build-studio/shared: ${hasShared ? '✓' : '✗'}`);
  console.log(`  @build-studio/project-server: ${hasProjectServer ? '✓' : '✗'}`);
  if (!hasNodeModules || !hasServer || !hasShared || !hasProjectServer) {
    console.error(`Error: injection incomplete for ${appPath} — the app would launch to a black window.`);
    process.exit(1);
  }
}

// Clear Electron browser cache so the app loads fresh JS/CSS
const os = require('os');
if (!appResourcesOverride) {
  const cacheDir = path.join(os.homedir(), 'Library', 'Application Support', '@build-studio', 'desktop');
  for (const dir of ['Cache', 'Code Cache', 'GPUCache', 'Service Worker']) {
    const p = path.join(cacheDir, dir);
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      console.log(`  Cleared cache: ${dir}`);
    }
  }
}

// ─── Stale project-server detection ───────────────────────────────────────────
// Each managed project runs its own detached project-server. Those servers
// outlive `inject-resources.js` runs and adopt-on-Start (process-manager.js:138),
// so freshly-injected code only takes effect after the per-project Node process
// restarts. Detect any running on stale code and either warn or kill them.

async function detectAndHandleStaleServers() {
  let registry;
  try {
    // Same module path the hub uses — works in dev tree and once published.
    registry = require('../shared/registry');
  } catch (e) {
    console.warn(`  (Stale-server check skipped: cannot load registry — ${e.message})`);
    return;
  }

  let projects;
  try {
    projects = registry.list();
  } catch (e) {
    console.warn(`  (Stale-server check skipped: registry.list() failed — ${e.message})`);
    return;
  }
  if (!projects || projects.length === 0) return;

  const checks = projects.map(async (project) => {
    if (!project.port) return null;
    try {
      const health = await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${project.port}/api/health`, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => {
            try { resolve(JSON.parse(body)); } catch (err) { reject(err); }
          });
        });
        req.on('error', reject);
        req.setTimeout(800, () => { req.destroy(); reject(new Error('timeout')); });
      });
      if (health && health.ok && health.name === project.name) {
        let pid = null;
        try {
          // -sTCP:LISTEN restricts to the listening socket — a bare -ti :port
          // also matches client sockets (hub/Electron connections), whose pids
          // can sort first and receive the SIGTERM meant for the server.
          const out = execFileSync('lsof', ['-ti', `:${project.port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim();
          if (out) pid = Number(out.split('\n')[0].trim());
        } catch {}
        return { name: project.name, port: project.port, pid };
      }
    } catch {}
    return null;
  });

  const running = (await Promise.all(checks)).filter(Boolean);
  if (running.length === 0) {
    console.log('No running project-servers detected — fresh starts will pick up the new bundle.');
    return;
  }

  console.log('');
  console.log(`⚠ ${running.length} project-server${running.length === 1 ? '' : 's'} running on STALE code (synced bundle not yet loaded):`);
  for (const r of running) {
    console.log(`    - ${r.name} (port ${r.port}${r.pid ? `, PID ${r.pid}` : ''})`);
  }

  if (!restartProjects) {
    console.log('');
    console.log('  Code in lib/api/ and lib/oneshot.js is changed on disk but not in memory.');
    console.log('  To pick up the new bundle in the running servers:');
    console.log('    • Stop each project from the hub, then Start it again, OR');
    console.log(`    • Re-run with the --restart-projects flag to kill them now:`);
    console.log(`        node inject-resources.js${syncOnly ? ' --sync-only' : ''} --restart-projects`);
    return;
  }

  console.log('');
  console.log('  --restart-projects given → killing stale processes…');
  for (const r of running) {
    if (!r.pid) {
      console.log(`    - ${r.name}: skipped (no PID resolved)`);
      continue;
    }
    try {
      process.kill(r.pid, 'SIGTERM');
      console.log(`    - ${r.name}: SIGTERM sent to PID ${r.pid}`);
    } catch (e) {
      console.log(`    - ${r.name}: kill failed — ${e.message}`);
    }
  }
  console.log('  Click Start for each project in the hub to relaunch on the fresh bundle.');
}

if (appResourcesOverride) {
  // Packaging context (afterPack): never touch running servers or user state.
  console.log('Done.');
} else {
  detectAndHandleStaleServers().then(() => {
    console.log('Done.');
  });
}
