const { app, BrowserWindow, shell, Menu, nativeImage, ipcMain, desktopCapturer } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const { execFileSync } = require('child_process');
const fs = require('fs');

const HUB_PORT = 18080;
const isDev = process.env.NODE_ENV === 'development';
const os = require('os');

let mainWindow = null;
let hubProcess = null;

// ── Crash diagnostics + recovery ──────────────────────────────────────────────
// A Finder-launched app has no visible stdout, so a renderer/GPU crash used to
// leave a black window with no trace — the only fix was force-quit + relaunch.
// We now (a) persist crash details to a file we can read after the fact, and
// (b) auto-reload the dead web contents so the black screen self-recovers.
const crashLogPath = path.join(os.homedir(), '.build-studio', 'crash.log');
function logCrash(line) {
  const entry = `[${new Date().toISOString()}] ${line}\n`;
  try {
    fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
    fs.appendFileSync(crashLogPath, entry);
  } catch {}
  console.error(entry.trim());
}

// Reload the main window after a crash, but guard against a crash-on-load loop:
// if we reload too many times in a short window, stop and leave the window so
// the failure stays visible instead of thrashing.
let crashReloadTimes = [];
function recoverFromCrash(label) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const now = Date.now();
  crashReloadTimes = crashReloadTimes.filter((t) => now - t < 30000);
  crashReloadTimes.push(now);
  if (crashReloadTimes.length > 3) {
    logCrash(`${label}: >3 reloads in 30s — leaving window to avoid a reload loop`);
    return;
  }
  logCrash(`${label}: recovering via reload (attempt ${crashReloadTimes.length}/3)`);
  mainWindow.webContents.reload();
}

// ── Demo Recording (see packages/desktop/demo/) ───────────────────────────────
// Capture lives in main because webContents.capturePage() + getDisplayMedia
// source selection are main-process APIs. The recorder is lazy so the module
// only loads when first used.
const { DemoRecorder } = require('./demo/demoRecorder');
let demoRecorder = null;
function getDemoRecorder() {
  if (!demoRecorder) {
    demoRecorder = new DemoRecorder({
      getWindow: () => mainWindow,
      send: (ch, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(ch, payload);
      },
      fetchWorkflow: (port) => fetchWorkflow(port),
    });
  }
  return demoRecorder;
}

let demoIpcRegistered = false;
function registerDemoIpc() {
  if (demoIpcRegistered) return;
  demoIpcRegistered = true;
  const rec = () => getDemoRecorder();
  ipcMain.handle('demo:start', (_e, opts) => rec().start(opts));
  ipcMain.handle('demo:stop', () => rec().stop());
  ipcMain.handle('demo:status', () => rec().getStatus());
  ipcMain.handle('demo:set-interval', (_e, sec) => rec().setAutomationInterval(sec));
  ipcMain.handle('demo:privacy-pause', (_e, on) => rec().privacyPause(on));
  ipcMain.handle('demo:set-blur', (_e, on) => rec().setBlur(on));
  ipcMain.handle('demo:mark', (_e, { label, meta }) => rec().mark(label, meta));
  // High-frequency one-way channels (manual video chunks from the renderer).
  ipcMain.on('demo:video-chunk', (_e, arrayBuffer) => {
    try { rec().onVideoChunk(Buffer.from(arrayBuffer)); } catch (err) { console.error('[demo] chunk write failed:', err.message); }
  });
  ipcMain.on('demo:manual-stopped', (_e, meta) => rec().onManualStopped(meta));
  // Phase 2b — external window/screen capture for the Demos tab. List sources so
  // the renderer can show a picker; set a one-shot source the display handler returns.
  ipcMain.handle('demo:list-capture-sources', async () => {
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false });
    let ownId = null;
    try { ownId = mainWindow && mainWindow.getMediaSourceId(); } catch {}
    return sources
      .filter((s) => s.id !== ownId) // hide our own window
      .map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail ? s.thumbnail.toDataURL() : null }));
  });
  ipcMain.handle('demo:set-capture-source', (_e, id) => { pendingCaptureSourceId = id || null; return true; });
}

// When pendingCaptureSourceId is set (Phase 2b external capture), the next
// getDisplayMedia returns that user-picked source. Otherwise it auto-grants the
// app's OWN window (Phase 1 dashboard manual video). No OS picker either way.
let pendingCaptureSourceId = null;
function setupDisplayMediaHandler() {
  try {
    const { session } = require('electron');
    session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
      const types = pendingCaptureSourceId ? ['screen', 'window'] : ['window'];
      desktopCapturer.getSources({ types }).then((sources) => {
        let src = null;
        if (pendingCaptureSourceId) {
          src = sources.find((s) => s.id === pendingCaptureSourceId) || null;
          pendingCaptureSourceId = null; // one-shot
        } else {
          try {
            const ownId = mainWindow && mainWindow.getMediaSourceId();
            src = sources.find((s) => s.id === ownId) || sources[0];
          } catch { src = sources[0]; }
        }
        callback(src ? { video: src } : {});
      }).catch(() => callback({}));
    }, { useSystemPicker: false });
  } catch (e) {
    console.error('[demo] setupDisplayMediaHandler failed:', e.message);
  }
}

// ── Window state persistence ──────────────────
const windowStatePath = path.join(os.homedir(), '.build-studio', 'window-state.json');

function loadWindowState() {
  try {
    if (fs.existsSync(windowStatePath)) {
      return JSON.parse(fs.readFileSync(windowStatePath, 'utf8'));
    }
  } catch {}
  return null;
}

function saveWindowState(win) {
  try {
    const bounds = win.getBounds();
    const maximized = win.isMaximized();
    const dir = path.dirname(windowStatePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(windowStatePath, JSON.stringify({ bounds, maximized }));
  } catch {}
}

// macOS GUI apps don't inherit shell PATH — find node explicitly
function findNode() {
  // Common locations
  const candidates = [
    process.env.PATH && 'node', // works if PATH is set (terminal launch)
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    path.join(process.env.HOME || '', '.nvm/versions/node'),
    '/usr/bin/node',
  ];

  // Try which via a login shell to get the real PATH
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const result = execFileSync(shell, ['-ilc', 'which node'], {
      encoding: 'utf8',
      timeout: 5000,
      env: { ...process.env, HOME: process.env.HOME || require('os').homedir() },
    }).trim();
    if (result && fs.existsSync(result)) return result;
  } catch {}

  // Fallback: check common paths
  for (const p of ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']) {
    if (fs.existsSync(p)) return p;
  }

  return 'node'; // last resort
}

function getResourcePath(...parts) {
  if (isDev) {
    // In dev, resolve relative to the monorepo
    return path.join(__dirname, '..', ...parts);
  }
  return path.join(process.resourcesPath, ...parts);
}

function killPort(port) {
  try {
    const pids = execFileSync('lsof', ['-ti', `:${port}`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    for (const pid of pids) {
      try { process.kill(Number(pid)); } catch {}
    }
  } catch {}
}

function startHubServer() {
  killPort(HUB_PORT);
  return new Promise((resolve, reject) => {
    if (isDev) {
      // In dev mode, start Next.js dev server
      const hubDir = getResourcePath('hub');
      hubProcess = spawn('npx', ['next', 'dev', '--port', String(HUB_PORT)], {
        cwd: hubDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NODE_ENV: 'development' },
        shell: true,
      });

      hubProcess.stdout.on('data', (data) => {
        const text = data.toString();
        process.stdout.write(text);
        if (text.includes('Ready in') || text.includes('localhost')) {
          // Give it a moment after "Ready"
          setTimeout(resolve, 500);
        }
      });

      hubProcess.stderr.on('data', (data) => {
        process.stderr.write(data.toString());
      });

      hubProcess.on('error', reject);

      // Timeout after 30s
      setTimeout(() => resolve(), 30000);
    } else {
      // In production, run the standalone Next.js server
      const hubDir = getResourcePath('standalone', 'packages', 'hub');
      const serverJs = path.join(hubDir, 'server.js');

      const nodeBin = findNode();
      const nodeBinDir = path.dirname(nodeBin);
      console.log('Using node at:', nodeBin);
      console.log('Server at:', serverJs);
      const projectServerPath = getResourcePath('standalone', 'node_modules', '@build-studio', 'project-server');
      const cmd = `cd ${JSON.stringify(hubDir)} && exec ${JSON.stringify(nodeBin)} ${JSON.stringify(serverJs)}`;
      hubProcess = spawn('/bin/sh', ['-c', cmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: `${nodeBinDir}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${process.env.PATH || ''}`,
          HOME: process.env.HOME || require('os').homedir(),
          PORT: String(HUB_PORT),
          HOSTNAME: '0.0.0.0',
          NODE_ENV: 'production',
          BUILD_STUDIO_PROJECT_SERVER: projectServerPath,
        },
      });

      hubProcess.stdout.on('data', (data) => {
        const text = data.toString();
        process.stdout.write(text);
        if (text.includes('Listening') || text.includes('Ready') || text.includes('started')) {
          setTimeout(resolve, 300);
        }
      });

      hubProcess.stderr.on('data', (data) => {
        process.stderr.write(data.toString());
      });

      hubProcess.on('error', reject);
      setTimeout(() => resolve(), 15000);
    }
  });
}

async function waitForServer(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${port}/api/registry`, (res) => {
          let body = '';
          res.on('data', (d) => body += d);
          res.on('end', () => resolve(body));
        });
        req.on('error', reject);
        req.setTimeout(1000, () => { req.destroy(); reject(new Error('timeout')); });
      });
      return true;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return false;
}

// Shown when the hub server never came up — instead of a black window.
function showHubFailureWindow(incompleteBundle) {
  const win = new BrowserWindow({ width: 720, height: 480, title: 'Build Studio' });
  const diagnosis = incompleteBundle
    ? `<p><strong>This app bundle is incomplete</strong> — the packaged hub server
       (<code>Resources/standalone/packages/hub/server.js</code>) is missing.
       Rebuild the app with <code>npm run build</code> in <code>packages/desktop</code>;
       the packaging step injects the hub server and fails loudly if it can't.</p>`
    : `<p>The hub server did not respond on port ${HUB_PORT}. Another process may be
       using the port, or the server failed while starting.</p>`;
  const html = `<!doctype html><html><body style="background:#111114;color:#e2e8f0;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;padding:48px;line-height:1.7">
    <h2 style="color:#f87171;margin-top:0">Hub server failed to start</h2>
    ${diagnosis}
    <p style="color:#9ca3af">Details were appended to <code>${crashLogPath}</code>.
    Quit and relaunch after fixing; for help see the Troubleshooting section of the README.</p>
    </body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function createWindow(onboarding = false) {
  const saved = loadWindowState();
  mainWindow = new BrowserWindow({
    width: saved?.bounds?.width || 1440,
    height: saved?.bounds?.height || 900,
    x: saved?.bounds?.x,
    y: saved?.bounds?.y,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    backgroundColor: '#111114',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      v8CacheOptions: 'none',
      preload: path.join(__dirname, 'preload.js'),
      // Keep timers + painting alive when the app is backgrounded so the demo
      // timelapse (and the page it captures) don't freeze during long runs.
      backgroundThrottling: false,
    },
  });

  if (saved?.maximized) mainWindow.maximize();

  // Auto-grant window capture to the demo recorder's MediaRecorder.
  setupDisplayMediaHandler();

  // Save window state on move/resize
  let saveTimeout = null;
  const debounceSave = () => {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => saveWindowState(mainWindow), 300);
  };
  mainWindow.on('resize', debounceSave);
  mainWindow.on('move', debounceSave);
  mainWindow.on('maximize', debounceSave);
  mainWindow.on('unmaximize', debounceSave);

  // Force bypass cache on initial load to avoid stale chunk references after rebuilds
  const hubUrl = onboarding
    ? `http://localhost:${HUB_PORT}/?onboarding=1`
    : `http://localhost:${HUB_PORT}`;
  mainWindow.loadURL(hubUrl, { extraHeaders: 'pragma: no-cache\n' });

  // Log page errors to terminal
  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
    console.error(`Page load failed: ${errorDescription} (${errorCode}) at ${validatedURL}`);
  });
  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer] ${message}`);
  });
  mainWindow.webContents.on('render-process-gone', (event, details) => {
    logCrash(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
    // 'clean-exit' is a normal teardown (e.g. on quit) — don't fight it.
    if (details.reason === 'clean-exit') return;
    recoverFromCrash('render-process-gone');
  });

  // Cmd+Shift+I opens DevTools for debugging
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.meta && input.shift && input.key === 'i') {
      mainWindow.webContents.toggleDevTools();
    }
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://localhost:')) {
      // Project server URLs open in the app
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Defensive: block top-level navigations away from the hub. Any click that
  // tries to navigate the main window to an API URL (e.g. a misconfigured
  // <a href="/api/..."> or a form submit) would replace the React app with a
  // raw JSON/text response — Chromium then renders it with its built-in
  // "Pretty print" toggle and the user sees a black window with that checkbox.
  // We only ever want the main window on the hub origin; everything else
  // either opens externally or stays in-place as a fetch.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const hubOrigin = `http://localhost:${HUB_PORT}`;
    if (url.startsWith(`${hubOrigin}/`) || url === hubOrigin) return;
    console.warn(`[main] blocked top-level navigation to ${url}`);
    event.preventDefault();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Clear badge on focus — user has "seen" the notification.
  // Only re-badge if the count of workflows needing input increases.
  mainWindow.on('focus', () => {
    app.dock.setBadge('');
    _dockBadgeActive = false;
  });
}

function buildMenu() {
  const template = [
    {
      label: app.getName(),
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Dock badge — notify when a workflow needs user input ───────────────────────
// A workflow needs attention when:
//   (a) all agents in the current step are done → waiting for Approve/Advance, or
//   (b) the overseer has escalated an issue that needs acknowledgement.
// When the window is focused the badge clears automatically.

let _dockBadgeActive = false;
let _dockPollInterval = null;
let _dismissedCount = 0; // count user last dismissed — only re-badge if this changes

function workflowNeedsInput(wf) {
  if (!wf || !wf.currentStep || wf.currentStep === 'completed') return false;
  if (wf.type !== 'execution') return false;

  // Overseer escalation
  if (wf.overseer?.pendingEscalation) return true;

  const step = wf.steps?.[wf.currentStep];
  if (!step) return false;

  // Step has error or blocked status → user must intervene
  if (step.status === 'error' || step.status === 'blocked') return true;

  // All agents in current step are done → user must approve/advance
  const agents = step.agents || [];
  if (agents.length > 0 && agents.every(a => a.status === 'done' || a.status === 'error')) return true;

  // Task execution: check if current task's agents are all done
  if (wf.currentStep === 'task_execution' && wf.taskExecution?.taskStates) {
    for (const ts of Object.values(wf.taskExecution.taskStates)) {
      const ta = ts.agents || [];
      if (ta.length > 0 && ts.status !== 'done' && ta.every(a => a.status === 'done' || a.status === 'error')) return true;
    }
  }

  return false;
}

async function fetchWorkflow(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/workflow`, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

async function updateDockBadge() {
  if (process.platform !== 'darwin') return;
  try {
    const shared = require('@build-studio/shared');
    const projects = shared.registry.list();

    let needsAttention = 0;
    await Promise.all(projects.map(async (p) => {
      try {
        const data = await fetchWorkflow(p.port);
        if (workflowNeedsInput(data?.workflow || data)) needsAttention++;
      } catch {}
    }));

    // If window is focused, user is looking — just track count, no badge
    const focused = BrowserWindow.getFocusedWindow();
    if (focused) {
      _dismissedCount = needsAttention;
      if (_dockBadgeActive) {
        app.dock.setBadge('');
        _dockBadgeActive = false;
      }
    } else if (needsAttention > _dismissedCount) {
      // New workflow(s) need attention since user last looked
      app.dock.setBadge('●');
      if (!_dockBadgeActive) {
        app.dock.bounce('informational');
        _dockBadgeActive = true;
      }
      _dismissedCount = 0; // reset so we don't re-bounce for same count
    } else if (needsAttention === 0) {
      app.dock.setBadge('');
      _dockBadgeActive = false;
    }
  } catch (e) {
    console.error('[dock-badge] updateDockBadge error:', e.message);
  }
}

function startDockBadgePoll() {
  if (_dockPollInterval) return;
  _dockPollInterval = setInterval(updateDockBadge, 15_000);
  // First check after 8s — gives project servers time to start up
  setTimeout(updateDockBadge, 8000);
}

// A GPU/compositor process crash typically blacks the window without producing
// a macOS .ips report. Chromium usually relaunches the GPU process on its own,
// but the existing render contents can stay black — so log it and reload to
// re-establish compositing.
app.on('child-process-gone', (event, details) => {
  logCrash(`child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
  if (details.type === 'GPU' && details.reason !== 'clean-exit') {
    recoverFromCrash('gpu-process-gone');
  }
});

app.whenReady().then(async () => {
  buildMenu();
  registerDemoIpc();

  // Clear stale HTTP cache — after a rebuild the server may use a new
  // flight-router-state schema that old cached client JS doesn't match.
  const { session } = require('electron');
  await session.defaultSession.clearCache();

  console.log('Starting hub server...');
  await startHubServer();

  console.log('Waiting for server to be ready...');
  const ready = await waitForServer(HUB_PORT);
  if (!ready) {
    // A silent black window is the worst possible failure mode: nothing on
    // screen, nothing in crash.log (it's not a crash). Show an explicit error
    // page and log the condition instead of loadURL-ing into the void.
    console.error('Hub server failed to start within timeout');
    const bundleServer = getResourcePath('standalone', 'packages', 'hub', 'server.js');
    const isDev = process.env.NODE_ENV === 'development';
    const incompleteBundle = !isDev && !fs.existsSync(bundleServer);
    logCrash(`hub-server-not-ready: nothing answering on :${HUB_PORT} after timeout${incompleteBundle ? ' — app bundle is INCOMPLETE (missing Resources/standalone hub server)' : ''}`);
    showHubFailureWindow(incompleteBundle);
    return;
  }

  // Check if this is first launch (empty registry) — show onboarding
  let showOnboarding = false;
  try {
    const shared = require('@build-studio/shared');
    const projects = shared.registry.list();
    showOnboarding = projects.length === 0;

    // Auto-start all registered project servers
    // Set BUILD_STUDIO_PROJECT_SERVER so process-manager can find the server script
    // (it's in the standalone dir, not inside app.asar)
    if (!process.env.BUILD_STUDIO_PROJECT_SERVER) {
      process.env.BUILD_STUDIO_PROJECT_SERVER = getResourcePath('standalone', 'node_modules', '@build-studio', 'project-server');
    }
    if (projects.length > 0) {
      console.log(`Auto-starting ${projects.length} project server(s)...`);
      for (const p of projects) {
        try {
          const result = await shared.processManager.startProject(p.name);
          console.log(`  ${p.name}: pid=${result.pid} port=${result.port}${result.alreadyRunning ? ' (already running)' : ''}`);
        } catch (e) {
          console.error(`  ${p.name}: failed to start — ${e.message}`);
        }
      }
    }
  } catch {}

  createWindow(showOnboarding);
  startDockBadgePoll();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(false);
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS, keep the app running (dock behavior)
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  // Finalize any in-progress demo recording so the manifest + last segment close.
  try {
    if (demoRecorder && demoRecorder.isRecording()) await demoRecorder.stop();
  } catch (e) {
    console.error('Error stopping demo recording:', e.message);
  }

  // Stop all running project servers
  try {
    const shared = require(/* turbopackIgnore: true */ '@build-studio/shared');
    const projects = shared.registry.list();
    for (const p of projects) {
      try {
        await shared.processManager.stopProject(p.name);
        console.log(`Stopped project server: ${p.name}`);
      } catch {}
    }
  } catch (e) {
    console.error('Error stopping project servers:', e);
  }

  // Kill the hub server
  if (hubProcess && !hubProcess.killed) {
    hubProcess.kill('SIGTERM');
  }
});
