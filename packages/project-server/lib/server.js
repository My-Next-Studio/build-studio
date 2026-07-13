try { require('dotenv').config(); } catch {}
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const pty = require('node-pty');
const path = require('path');
const fs = require('fs');

const { loadConfig, watchConfig } = require('./config');
const { createStateManager } = require('./state');
const { createGitOps } = require('./git');
const { createTmuxOps } = require('./tmux');
const { createFilesRouter } = require('./api/files');
const { createQueueRouter } = require('./api/queue');
const { createStatusRouter } = require('./api/status');
const { createTerminalRouter } = require('./api/terminal');
const { createWorkflowRouter } = require('./api/workflow');
const { createRunRouter } = require('./api/run');
const { createDeploymentRouter } = require('./api/deployment');
const { createRunbooksRouter } = require('./api/runbooks');
const { createOpsUITestsRouter } = require('./api/ops-uitests');
const { createDemoSetupRouter } = require('./api/demo-setup');
const { createBacklogRouter } = require('./api/backlog');
const { createOverseer } = require('./overseer');

function startServer(projectRoot, opts = {}) {
  const config = loadConfig(projectRoot);
  if (opts.portOverride) config.port = opts.portOverride;

  // PRD-001 backlog #8: watch config.yaml for edits and hot-reload without
  // restarting the project-server. Frozen keys (port, paths) stay; everything
  // else (step_strategies, step_models, step_efforts, roles, workflow) updates
  // in-place so existing closures (workflow router, overseer) pick it up.
  watchConfig(config);

  const app = express();
  app.use(express.json());

  // CORS — allow hub and other origins to connect directly
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Health check
  const startedAt = new Date().toISOString();
  // Bundle version stamp written by packages/desktop/inject-resources.js into
  // lib/.bundle-version. Read once at startup; reported via /api/health so the
  // hub's process-manager can detect when the on-disk bundle has been updated
  // and auto-restart this server on the next Start click.
  // Falls back to null in dev (running from source without an inject step).
  let bundleVersion = null;
  try {
    bundleVersion = fs.readFileSync(path.join(__dirname, '.bundle-version'), 'utf8').trim() || null;
  } catch {}

  app.get('/api/health', (req, res) => res.json({
    ok: true,
    name: config.name,
    projectRoot: config.projectRoot,
    uptime: process.uptime(),
    startedAt,
    bundleVersion,
  }));

  // SSE
  const sseClients = new Set();
  app.get('/api/sse', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
    sseClients.add(send);
    req.on('close', () => sseClients.delete(send));
  });

  function broadcast(event, data) {
    for (const send of sseClients) send({ event, ...data });
  }

  // Shared services
  const state = createStateManager(config, broadcast);
  const gitOps = createGitOps(config);
  const tmuxOps = createTmuxOps(config);
  const overseer = createOverseer(config, state, broadcast);

  // Start overseer when a workflow is live on server startup
  const existingWf = state.loadWorkflow();
  if (existingWf && existingWf.currentStep && existingWf.currentStep !== 'completed') {
    overseer.startOverseer();
  }

  // Watch workflow saves to start/stop overseer on workflow lifecycle changes
  const _baseSaveWorkflow = state.saveWorkflow.bind(state);
  state.saveWorkflow = function (wf) {
    _baseSaveWorkflow(wf);
    const terminal = ['completed', 'cancelled', 'failed'];
    if (terminal.includes(wf.currentStep)) {
      overseer.stopOverseer();
    } else if (wf.currentStep && !overseer.isRunning()) {
      overseer.startOverseer();
    }
  };

  // Overseer API endpoint — dismiss a pending escalation
  app.post('/api/overseer/dismiss', (req, res) => {
    overseer.dismissEscalation();
    res.json({ ok: true });
  });

  // Overseer API endpoint — nudge a stuck agent by sending "continue" to
  // its tmux pane. Triggered from the UI when the user believes a usage
  // limit has lifted.
  app.post('/api/overseer/nudge-agent', (req, res) => {
    const { window: windowName } = req.body || {};
    const result = overseer.nudgeAgent(windowName);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  });

  // G2 — Force-complete a stuck task. Takes the agent's pane scrollback as
  // synthetic feedback, marks the task done. For wallclock overruns where
  // the work is likely committed but the agent is iterating uselessly.
  app.post('/api/overseer/force-complete-task', (req, res) => {
    const { window: windowName } = req.body || {};
    const result = overseer.forceCompleteTaskAgent(windowName);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  });

  // G2 — Kill-and-skip a stuck task. Terminates the agent and marks the
  // task done with no work attribution. For ill-conceived tasks that the
  // planner anti-pattern check should have rejected.
  app.post('/api/overseer/kill-skip-task', (req, res) => {
    const { window: windowName } = req.body || {};
    const result = overseer.killAndSkipTaskAgent(windowName);
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ok: true });
  });

  // API routers
  const { router: filesRouter } = createFilesRouter(config, broadcast);
  const { router: queueRouter, parseExecutionPlan } = createQueueRouter(config, broadcast);
  const statusRouter = createStatusRouter(config, gitOps, state);
  const terminalRouter = createTerminalRouter(config, state, tmuxOps);
  const workflowRouter = createWorkflowRouter(config, state, gitOps, tmuxOps, broadcast);
  const runRouter = createRunRouter(config, state, gitOps, tmuxOps, broadcast, parseExecutionPlan);
  const deploymentRouter = createDeploymentRouter(config, gitOps);
  const runbooksRouter = createRunbooksRouter(config);
  const opsUITestsRouter = createOpsUITestsRouter(config);
  const demoSetupRouter = createDemoSetupRouter(config);
  const backlogRouter = createBacklogRouter(config);

  app.use('/api', filesRouter);
  app.use('/api', queueRouter);
  app.use('/api', statusRouter);
  app.use('/api/terminal', terminalRouter);
  app.use('/api', workflowRouter);
  app.use('/api', runRouter);
  app.use('/api', deploymentRouter);
  app.use('/api', runbooksRouter);
  app.use('/api', opsUITestsRouter);
  app.use('/api', demoSetupRouter);
  app.use('/api', backlogRouter);

  // Config endpoint for frontend
  const { listPresets } = require('./presets');
  app.get('/api/config', (req, res) => res.json({
    name: config.name,
    port: config.port,
    preset: config.preset || null,
    roles: config.roles,
    workflow: config.workflow,
    step_models: config.step_models,
    agent_defaults: { model: config.agent_defaults.model },
  }));

  // Presets endpoint — lists available workflow presets
  app.get('/api/presets', (req, res) => res.json({ presets: listPresets() }));

  // WebSocket / persistent pty terminal
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });
  wss.on('error', () => {}); // Suppress WSS error when server fails to bind

  let persistentPty = null;
  let ptyScrollback = [];
  const PTY_BUFFER_LIMIT = 50000;
  const ptyClients = new Set();

  function spawnPersistentPty() {
    const shell = process.env.SHELL || '/bin/zsh';
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    try {
      persistentPty = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: 220,
        rows: 50,
        cwd: config.projectRoot,
        env,
      });
    } catch (e) {
      console.warn(`⚠ Terminal tab unavailable: ${e.message}`);
      console.warn('  node-pty may not support your Node.js version. Terminal features disabled.');
      persistentPty = null;
      return;
    }

    ptyScrollback = [];

    persistentPty.onData((data) => {
      ptyScrollback.push(data);
      let totalLen = ptyScrollback.reduce((s, c) => s + c.length, 0);
      while (totalLen > PTY_BUFFER_LIMIT && ptyScrollback.length > 1) {
        totalLen -= ptyScrollback.shift().length;
      }
      for (const client of ptyClients) {
        if (client.readyState === client.OPEN) {
          client.send(JSON.stringify({ type: 'output', data }));
        }
      }
    });

    persistentPty.onExit(() => {
      for (const client of ptyClients) {
        if (client.readyState === client.OPEN) {
          client.send(JSON.stringify({ type: 'exit' }));
        }
      }
      persistentPty = null;
      ptyScrollback = [];
    });
  }

  // Live agent terminal: a dedicated pty per connection that attaches to the
  // agent's tmux window through a grouped "view" session. Grouped = shares the
  // workflow session's windows but keeps its own current-window, so viewing
  // one agent never flips what another viewer (or the run itself) sees.
  // destroy-unattached reaps the view session the moment the socket closes.
  function handleAgentTerminal(ws, agentWindow) {
    const { resolveAgentTarget } = require('./api/terminal');
    const target = resolveAgentTarget(state, agentWindow);
    if (!target) {
      ws.send(JSON.stringify({ type: 'error', data: `No agent "${agentWindow}" found in the active workflow or run` }));
      ws.close();
      return;
    }
    const viewSession = `view-${String(agentWindow).replace(/[^a-zA-Z0-9_-]/g, '')}-${Date.now().toString(36)}`;
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;
    let agentPty;
    try {
      agentPty = pty.spawn('tmux', [
        'new-session', '-t', target.sessionName, '-s', viewSession, ';',
        'set-option', 'destroy-unattached', 'on', ';',
        'select-window', '-t', `${viewSession}:=${target.window}`,
      ], { name: 'xterm-256color', cols: 220, rows: 50, cwd: config.projectRoot, env });
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', data: `Could not attach to agent terminal: ${e.message}` }));
      ws.close();
      return;
    }
    agentPty.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'output', data }));
    });
    agentPty.onExit(() => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'exit' }));
        ws.close();
      }
    });
    ws.on('message', (raw) => {
      try {
        const { type, data, cols, rows } = JSON.parse(raw);
        if (type === 'input') agentPty.write(data);
        if (type === 'resize') agentPty.resize(Math.max(cols, 2), Math.max(rows, 2));
      } catch (_) {}
    });
    ws.on('close', () => {
      try { agentPty.kill(); } catch (_) {}
      // destroy-unattached reaps the grouped view session; belt and braces:
      try { require('child_process').execFile('tmux', ['kill-session', '-t', viewSession], () => {}); } catch (_) {}
    });
  }

  wss.on('connection', (ws, req) => {
    let agentWindow = null;
    try {
      agentWindow = new URL(req.url, 'http://localhost').searchParams.get('agentWindow');
    } catch (_) {}
    if (agentWindow) return handleAgentTerminal(ws, agentWindow);

    if (!persistentPty) spawnPersistentPty();
    if (!persistentPty) {
      ws.send(JSON.stringify({ type: 'error', data: 'Terminal unavailable — node-pty failed to spawn' }));
      ws.close();
      return;
    }
    ptyClients.add(ws);

    if (ptyScrollback.length > 0) {
      ws.send(JSON.stringify({ type: 'replay', data: ptyScrollback.join('') }));
    }

    ws.on('message', (raw) => {
      try {
        const { type, data, cols, rows } = JSON.parse(raw);
        if (type === 'input' && persistentPty) persistentPty.write(data);
        if (type === 'resize' && persistentPty) persistentPty.resize(Math.max(cols, 2), Math.max(rows, 2));
      } catch (_) {}
    });

    ws.on('close', () => ptyClients.delete(ws));
  });

  // Stale workflow check on startup
  const wf = state.loadWorkflow();
  if (wf && wf.currentStep !== 'completed') {
    if (!tmuxOps.hasSession(wf.sessionName)) {
      for (const step of Object.values(wf.steps || {})) {
        for (const agent of step.agents || []) {
          if (agent.status === 'running') {
            agent.status = 'error';
            agent.error = 'Session lost (server restart)';
          }
        }
      }
      state.saveWorkflow(wf);
      console.log(`⚠ Stale workflow detected (${wf.id}) — agents marked as lost`);
    }
  }

  // Agent timeout — mark agents as stalled only when the log file shows no
  // activity for AGENT_IDLE_TIMEOUT_MS. Differentiates "stuck" from "still
  // working" so a long-running QA regression (>30min of streaming output)
  // isn't marked as timed out while it's actively producing logs.
  const AGENT_IDLE_TIMEOUT_MS = 15 * 60 * 1000; // 15 min of log silence = stalled
  const AGENT_MIN_RUNTIME_MS = 5 * 60 * 1000; // don't apply idle check before this

  // Periodic stale session + timeout check (every 30s)
  setInterval(() => {
    const activeWf = state.loadWorkflow();
    if (activeWf && activeWf.currentStep !== 'completed' && activeWf.sessionName) {
      let changed = false;

      // Check for dead tmux session
      if (!tmuxOps.hasSession(activeWf.sessionName)) {
        for (const step of Object.values(activeWf.steps || {})) {
          for (const agent of step.agents || []) {
            if (agent.status === 'running') {
              agent.status = 'error';
              agent.error = 'Session lost';
              changed = true;
            }
          }
        }
      }

      // Idle-based timeout — mark stalled when the agent's log file has not
      // been written to for AGENT_IDLE_TIMEOUT_MS. tmux pipe-pane streams all
      // pane output (including the Claude CLI's per-second spinner updates)
      // to the log, so log mtime is a reliable "is the agent alive" signal.
      const currentStep = activeWf.steps[activeWf.currentStep];
      if (currentStep && currentStep.agents) {
        const now = Date.now();
        for (const agent of currentStep.agents) {
          if (agent.status !== 'running' || !agent.startedAt || !agent.window) continue;
          const elapsed = now - new Date(agent.startedAt).getTime();
          if (elapsed < AGENT_MIN_RUNTIME_MS) continue;

          const logFile = path.join(config.logsPath, `${agent.window}-${activeWf.id}.log`);
          let idleMs;
          try {
            idleMs = now - fs.statSync(logFile).mtimeMs;
          } catch (_) {
            // Log missing — fall back to elapsed time so we still time out a runaway agent
            idleMs = elapsed;
          }

          if (idleMs > AGENT_IDLE_TIMEOUT_MS) {
            agent.status = 'error';
            agent.error = `Stalled — no log activity for ${Math.round(idleMs / 60000)} minutes (total elapsed ${Math.round(elapsed / 60000)}m). Agent may be stuck (waiting for input, crashed, or context exhausted). Cancel and re-launch.`;
            changed = true;
            console.log(`[workflow] Agent ${agent.role} stalled — log idle for ${Math.round(idleMs / 60000)}m in step ${activeWf.currentStep}`);
          }
        }
      }

      if (changed) {
        state.saveWorkflow(activeWf);
        broadcast('workflow-updated', {});
      }
    }

    const activeRun = state.loadRun();
    if (activeRun && activeRun.state === 'executing' && activeRun.sessionName) {
      if (!tmuxOps.hasSession(activeRun.sessionName)) {
        activeRun.state = 'stale';
        state.saveRun(activeRun);
      }
    }
  }, 30000);

  // Start server, auto-incrementing port if already in use
  const maxAttempts = 20;
  let attempt = 0;
  let currentPort = config.port;

  const tryListen = () => {
    server.listen(currentPort, () => {
      config.port = currentPort;
      console.log(`\nBuild Studio — ${config.name}`);
      console.log(`  Server:  http://localhost:${currentPort}`);
      console.log(`  Project: ${config.projectRoot}`);
      console.log(`  Docs:    ${config.docsPath}`);
      const allRoles = [
        ...(config.roles.review || []),
        ...(config.roles.execution || []),
        ...(config.roles.standalone || []),
      ];
      console.log(`  Roles:   ${allRoles.length} (${(config.roles.review || []).length} review, ${(config.roles.execution || []).length} execution, ${(config.roles.standalone || []).length} standalone)\n`);
    });
  };

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      attempt++;
      if (attempt >= maxAttempts) {
        // Emit structured JSON so process-manager / hub can surface a clear message
        process.stderr.write(JSON.stringify({
          event: 'port_conflict',
          port: currentPort,
          project: config.name,
          message: `Could not bind to any port in range ${config.port}–${currentPort}. Another process may be using these ports.`,
        }) + '\n');
        console.error(`\nError: Could not find a free port (tried ${config.port}–${currentPort}).`);
        process.exit(1);
      }
      currentPort++;
      server.close();
      tryListen();
      return;
    }
    throw e;
  });

  tryListen();
}

module.exports = { startServer };
