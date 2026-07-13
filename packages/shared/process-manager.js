const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { PIDS_DIR } = require('./constants');
const registry = require('./registry');

/**
 * Check if a TCP port is free by attempting a connection.
 * Returns true if free (connection refused), false if occupied.
 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (e) => { resolve(e.code === 'ECONNREFUSED'); });
    socket.setTimeout(500, () => { socket.destroy(); resolve(true); });
  });
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function findNodeBin() {
  // Try login shell to get proper PATH (handles nvm, homebrew, etc.)
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const result = execFileSync(shell, ['-ilc', 'which node'], {
      encoding: 'utf8', timeout: 5000,
      env: { ...process.env, HOME: process.env.HOME || require('os').homedir() },
    }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {}
  // Fallback: common paths
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (fs.existsSync(p)) return p;
  }
  return 'node';
}

function pidFilePath(name) {
  return path.join(PIDS_DIR, `${name}.json`);
}

/**
 * Resolve the project-server's lib/ directory — same lookup logic as the spawn
 * target below. Returns the directory path, or null if neither candidate exists.
 */
function projectServerLibDir() {
  const envDir = process.env.BUILD_STUDIO_PROJECT_SERVER;
  if (envDir) return path.join(envDir, 'lib');
  return path.join(__dirname, '..', 'project-server', 'lib');
}

/**
 * Read the on-disk bundle-version stamp (written by inject-resources.js).
 * Returns the trimmed string, or null in dev mode (no stamp file).
 */
function readOnDiskBundleVersion() {
  const dir = projectServerLibDir();
  try {
    const v = fs.readFileSync(path.join(dir, '.bundle-version'), 'utf8').trim();
    return v || null;
  } catch {
    return null;
  }
}

/**
 * GET /api/health on a running server, with a tight timeout.
 * Returns the parsed health body or null on any failure.
 */
function fetchHealth(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/health`, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(1000, () => { req.destroy(); resolve(null); });
  });
}

/**
 * Decide whether a running server's reported bundleVersion is stale relative to
 * what's on disk. Returns true only when both sides report a version AND they
 * differ. If either side is null (dev mode, missing stamp), assume not-stale —
 * we don't want to thrash on missing metadata.
 */
function isBundleStale(runningVersion, onDiskVersion) {
  if (!runningVersion || !onDiskVersion) return false;
  return runningVersion !== onDiskVersion;
}

function readPidFile(name) {
  const p = pidFilePath(name);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

function writePidFile(name, info) {
  ensureDir(PIDS_DIR);
  fs.writeFileSync(pidFilePath(name), JSON.stringify(info, null, 2));
}

function removePidFile(name) {
  const p = pidFilePath(name);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

/**
 * Find and kill any rogue project-server processes for a given project path.
 * Catches processes started outside the process-manager (e.g. from a dev terminal)
 * that share the same workflow state file and can cause stale overseer data.
 */
function killStaleServers(projectPath, keepPid) {
  try {
    // Find all node processes with project-server and this project path in their command line
    const out = execFileSync('ps', ['ax', '-o', 'pid,command'], { encoding: 'utf8', timeout: 3000 });
    const killed = [];
    for (const line of out.split('\n')) {
      if (!line.includes('project-server') || !line.includes(projectPath)) continue;
      const pid = parseInt(line.trim(), 10);
      if (!pid || pid === process.pid || pid === keepPid) continue;
      try {
        process.kill(pid, 'SIGTERM');
        killed.push(pid);
      } catch {}
    }
    if (killed.length > 0) {
      console.log(`[process-manager] Killed ${killed.length} stale server(s) for "${projectPath}": PIDs ${killed.join(', ')}`);
    }
    return killed;
  } catch { return []; }
}

/**
 * Start a project server as a detached child process.
 * Returns { pid, port }.
 */
async function startProject(name) {
  const project = registry.get(name);
  if (!project) throw new Error(`Project "${name}" not found in registry`);

  // Kill any rogue project-server processes for this project before checking state.
  // This prevents stale processes (e.g. from dev terminals) from sharing the workflow
  // state file and injecting outdated overseer data.
  const existing = readPidFile(name);
  const keepPid = (existing && isProcessAlive(existing.pid)) ? existing.pid : null;
  killStaleServers(project.path, keepPid);

  // Check if already running by PID
  if (existing && isProcessAlive(existing.pid)) {
    // Compare the running server's bundle version against the on-disk stamp.
    // Mismatch → freshly-injected code on disk; kill the running server and
    // fall through to spawn so it gets reloaded.
    const onDisk = readOnDiskBundleVersion();
    const health = await fetchHealth(existing.port);
    if (health && isBundleStale(health.bundleVersion, onDisk)) {
      console.log(`[process-manager] Stale bundle for "${name}" (running ${health.bundleVersion} vs on-disk ${onDisk}) — restarting.`);
      try { process.kill(existing.pid, 'SIGTERM'); } catch {}
      // Give the OS a moment to release the port before respawn.
      await new Promise((r) => setTimeout(r, 500));
      removePidFile(name);
    } else {
      return { pid: existing.pid, port: existing.port, alreadyRunning: true };
    }
  }

  // Check if the configured port is already bound by something else
  let portFree = await isPortFree(project.port);
  if (!portFree) {
    let killedStaleAndFreed = false;
    // Before erroring, check if it's already our project server (lost PID file after restart)
    try {
      const health = await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${project.port}/api/health`, (res) => {
          let body = '';
          res.on('data', d => body += d);
          res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('bad json')); } });
        });
        req.on('error', reject);
        req.setTimeout(1000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      if (health.ok && health.name === name) {
        // Recover the PID first so we can either adopt or restart.
        let pid = null;
        try {
          const out = execFileSync('lsof', ['-ti', `:${project.port}`], { encoding: 'utf8' }).trim();
          if (out) pid = Number(out.split('\n')[0].trim());
        } catch {}

        // Bundle staleness check — same logic as the PID-file fast path above.
        const onDisk = readOnDiskBundleVersion();
        if (isBundleStale(health.bundleVersion, onDisk)) {
          console.log(`[process-manager] Stale bundle for "${name}" (running ${health.bundleVersion} vs on-disk ${onDisk}) — restarting.`);
          if (pid) {
            try { process.kill(pid, 'SIGTERM'); } catch {}
            await new Promise((r) => setTimeout(r, 500));
          }
          removePidFile(name);
          // Re-check the port so the EPORT_CONFLICT throw below doesn't fire.
          if (await isPortFree(project.port)) {
            portFree = true;
            killedStaleAndFreed = true;
          }
        } else {
          const info = { pid, port: project.port, startedAt: health.startedAt || new Date().toISOString() };
          writePidFile(name, info);
          console.log(`[process-manager] Adopted already-running server for "${name}" (PID ${pid})`);
          return { ...info, alreadyRunning: true };
        }
      }
    } catch {}
    // If we just killed a stale server and the port freed, drop through to spawn.
    // Otherwise the port is held by something we don't own — error as before.
    if (!killedStaleAndFreed) {
      let holder = 'unknown process';
      try {
        const out = execFileSync('lsof', ['-ti', `:${project.port}`], { encoding: 'utf8' }).trim();
        if (out) holder = `PID ${out.split('\n')[0].trim()}`;
      } catch {}
      const msg = `Port conflict: :${project.port} is already in use by ${holder}. Choose a different port for project "${name}" or stop the conflicting process.`;
      console.error(`[process-manager] ${msg}`);
      throw Object.assign(new Error(msg), { code: 'EPORT_CONFLICT', port: project.port, holder });
    }
  }

  // Resolve project-server path — works in both workspace and packaged app
  const serverScript = process.env.BUILD_STUDIO_PROJECT_SERVER
    ? path.join(process.env.BUILD_STUDIO_PROJECT_SERVER, 'index.js')
    : path.join(__dirname, '..', 'project-server', 'index.js');
  const logDir = path.join(project.path, 'tmp', '.logs');
  ensureDir(logDir);

  const out = fs.openSync(path.join(logDir, 'server-stdout.log'), 'a');
  const err = fs.openSync(path.join(logDir, 'server-stderr.log'), 'a');

  // Find node — GUI apps on macOS may not have PATH set
  const nodeBin = findNodeBin();

  // Use shell with cd to guarantee cwd is set before Node loads any modules.
  // spawn's cwd option fails silently when the parent process has an invalid cwd (e.g. inside Electron .app bundle).
  const cmd = `cd ${JSON.stringify(project.path)} && exec ${JSON.stringify(nodeBin)} ${JSON.stringify(serverScript)} --project ${JSON.stringify(project.path)} --port ${project.port}`;
  const child = spawn('/bin/sh', ['-c', cmd], {
    detached: true,
    stdio: ['ignore', out, err],
    env: {
      ...process.env,
      PATH: `${path.dirname(nodeBin)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
      HOME: process.env.HOME || require('os').homedir(),
    },
  });

  child.unref();

  const info = {
    pid: child.pid,
    port: project.port,
    startedAt: new Date().toISOString(),
  };
  writePidFile(name, info);

  return { ...info, alreadyRunning: false };
}

/**
 * Stop a project server.
 */
async function stopProject(name) {
  const info = readPidFile(name);
  if (!info) return { stopped: false, reason: 'no pid file' };

  if (!isProcessAlive(info.pid)) {
    removePidFile(name);
    return { stopped: true, reason: 'process already dead' };
  }

  // SIGTERM first
  process.kill(info.pid, 'SIGTERM');

  // Wait up to 5s for graceful shutdown
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isProcessAlive(info.pid)) {
    await new Promise(r => setTimeout(r, 200));
  }

  // Force kill if still alive
  if (isProcessAlive(info.pid)) {
    try { process.kill(info.pid, 'SIGKILL'); } catch {}
  }

  removePidFile(name);
  return { stopped: true, reason: 'terminated' };
}

/**
 * Check if a project server is running and healthy.
 */
async function getStatus(name) {
  const info = readPidFile(name);
  if (!info) return { running: false, reason: 'no pid file' };
  if (!isProcessAlive(info.pid)) {
    removePidFile(name);
    return { running: false, reason: 'process dead' };
  }

  // HTTP health check
  try {
    const health = await httpGet(`http://localhost:${info.port}/api/health`, 2000);
    return { running: true, pid: info.pid, port: info.port, startedAt: info.startedAt, health };
  } catch {
    return { running: true, pid: info.pid, port: info.port, startedAt: info.startedAt, health: null };
  }
}

/**
 * Reconcile all PID files — remove stale ones.
 */
function reconcile() {
  ensureDir(PIDS_DIR);
  const files = fs.readdirSync(PIDS_DIR).filter(f => f.endsWith('.json'));
  const stale = [];
  for (const file of files) {
    const name = file.replace('.json', '');
    const info = readPidFile(name);
    if (info && !isProcessAlive(info.pid)) {
      removePidFile(name);
      stale.push(name);
    }
  }
  return stale;
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

module.exports = {
  startProject, stopProject, getStatus, reconcile, readPidFile, isProcessAlive,
  // Exported for unit tests.
  isBundleStale, readOnDiskBundleVersion, projectServerLibDir,
};
