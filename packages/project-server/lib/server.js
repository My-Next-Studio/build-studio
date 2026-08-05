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
const { createMonitorRouter } = require('./api/monitor');
const { createMonitor } = require('./monitor');
const { createRunbooksRouter } = require('./api/runbooks');
const { createOpsUITestsRouter } = require('./api/ops-uitests');
const { createDemoSetupRouter } = require('./api/demo-setup');
const { createBacklogRouter } = require('./api/backlog');
const { createSupportRouter } = require('./api/support');
const { createCliConfigRouter } = require('./api/cli-config');
const { createOverseer } = require('./overseer');
const { parseAllowedOrigins, isAllowedOrigin } = require('./allowed-origins');

function startServer(projectRoot, opts = {}) {
  const config = loadConfig(projectRoot);
  if (opts.portOverride) config.port = opts.portOverride;

  // PRD-001 backlog #8: watch config.yaml for edits and hot-reload without
  // restarting the project-server. Frozen keys (port, paths) stay; everything
  // else (step_strategies, step_models, step_efforts, roles, workflow) updates
  // in-place so existing closures (workflow router, overseer) pick it up.
  watchConfig(config);

  const app = express();
  // Default (small-limit) JSON parsing for every route EXCEPT the Support
  // report-create endpoint, which accepts base64 attachments and mounts its own
  // express.json({ limit: '40mb' }) route middleware.
  //
  // WHY this skip exists (do NOT "simplify" it away): body-parser runs in
  // registration order and marks the body consumed on the first parser to touch
  // it, so a global express.json() mounted here would ALWAYS run before any
  // route-level parser and reject the request at its own limit first — the
  // route-level 40mb cap could never take effect. base64 inflates payloads ~33%,
  // so the default 100kb cap actually bites at ~75KB of raw attachment. Skipping
  // exactly POST /api/support/reports lets its route-level parser govern that one
  // endpoint while the app-wide limit (and its narrow DoS surface) stays 100kb
  // everywhere else. Mounting the router before this line isn't an option — CORS
  // is registered after it, so that would drop CORS/preflight for support routes.
  const defaultJsonParser = express.json();
  app.use((req, res, next) => {
    if (req.method === 'POST' && req.path === '/api/support/reports') return next();
    return defaultJsonParser(req, res, next);
  });

  // CORS — echo back an allow-listed origin, never '*'. See lib/allowed-origins.js
  // for why the 127.0.0.1 bind does not already cover this.
  const allowedOrigins = parseAllowedOrigins(process.env.BUILD_STUDIO_ALLOWED_ORIGINS);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    // Vary: Origin unconditionally — the response body is identical either way,
    // but the ACAO header is not, and a cache that missed that could hand a
    // hub-stamped header to some other origin.
    res.setHeader('Vary', 'Origin');
    if (isAllowedOrigin(origin, allowedOrigins)) {
      // Only set ACAO when there IS an origin to echo. A no-origin caller is a
      // non-browser client that neither needs nor reads the header.
      if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    }
    // A disallowed origin still gets 204 on the preflight, just without the
    // headers that would let it proceed — the browser fails the actual request.
    // Answering 403 here would leak "this port is a project-server" to any page
    // that probes it; a bare 204 is indistinguishable from an endpoint that
    // simply does not do CORS.
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
  // One monitor per project-server, shared by the CI/CD tab and the Monitor
  // tab so a single cached `gh run list` answers both.
  const monitor = createMonitor(config);
  const deploymentRouter = createDeploymentRouter(config, gitOps, { monitor });
  const monitorRouter = createMonitorRouter(config, monitor);
  const runbooksRouter = createRunbooksRouter(config);
  const opsUITestsRouter = createOpsUITestsRouter(config);
  const demoSetupRouter = createDemoSetupRouter(config);
  const backlogRouter = createBacklogRouter(config);
  const supportRouter = createSupportRouter(config);
  const cliConfigRouter = createCliConfigRouter(config);

  app.use('/api', filesRouter);
  app.use('/api', queueRouter);
  app.use('/api', statusRouter);
  app.use('/api/terminal', terminalRouter);
  app.use('/api', workflowRouter);
  app.use('/api', runRouter);
  app.use('/api', deploymentRouter);
  app.use('/api', monitorRouter);
  app.use('/api', runbooksRouter);
  app.use('/api', opsUITestsRouter);
  app.use('/api', demoSetupRouter);
  app.use('/api', backlogRouter);
  app.use('/api', supportRouter);
  app.use('/api', cliConfigRouter);

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
  // Origin check on the handshake. This is NOT redundant with the CORS
  // middleware above: WebSockets are exempt from the same-origin policy
  // entirely, so no CORS header this server sends can stop a page from opening
  // ws://localhost:<port>. And this socket is not a read-only feed — the
  // connection handler below hands every client the persistent pty and writes
  // their {type:'input'} straight to the shell. Unguarded, any page you visit
  // gets an interactive shell running as you, in your project directory.
  //
  // Browsers set Origin on every WebSocket handshake and it cannot be forged
  // from page JavaScript, which is exactly what makes it usable here.
  const wss = new WebSocketServer({
    server,
    verifyClient: ({ origin }, done) => {
      if (isAllowedOrigin(origin, allowedOrigins)) return done(true);
      console.warn(`[ws] rejected handshake from origin ${origin}`);
      done(false, 403, 'Forbidden origin');
    },
  });
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
        // Mouse mode on the VIEW session only (grouped sessions keep their own
        // options, so the agent's session is untouched): the hub viewer's wheel
        // enters tmux copy-mode and scrolls real pane history — without this,
        // scrolling is impossible in the hub (tmux runs the alternate screen,
        // so xterm.js has no scrollback of its own to offer).
        'set-option', 'mouse', 'on', ';',
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
  // Dead-process discrimination + auto-resume (see lib/agent-recovery.js):
  const AGENT_DEAD_CONFIRM_MS = 2 * 60 * 1000;  // shell pane + this much silence = process dead
  const AGENT_RESUME_GRACE_MS = 3 * 60 * 1000;  // after firing a resume, let the CLI boot before re-judging
  const AGENT_MAX_AUTO_RESUMES = 2;             // then fall through to the loud halt
  const agentRecovery = require('./agent-recovery');
  // Provider usage limits (see lib/limit-block.js). Capped so a limit that keeps
  // re-blocking surfaces instead of being hammered the instant each reset lands.
  const limitBlock = require('./limit-block');
  const LIMIT_MAX_AUTO_RESUMES = 3;
  const LIMIT_RESUME_MESSAGE = 'The usage limit that interrupted you has reset. Continue your assigned task from where you left off — your original instructions still apply in full, including reporting your structured feedback via the curl POST at the end of your prompt.';

  // Periodic stale session + timeout check (every 30s)
  setInterval(() => {
   // A throw anywhere in this tick used to be an uncaught exception, which
   // exits the process — so a single bad line in the watchdog took the whole
   // project-server down and the project simply vanished from the hub, showing
   // "Start server" with no indication why (2026-08-03: a ReferenceError from a
   // hoisting mistake did exactly that, mid-run). The watchdog is advisory; it
   // must never be able to kill the server it is watching.
   try {
    const activeWf = state.loadWorkflow();
    if (activeWf && activeWf.currentStep !== 'completed' && activeWf.sessionName) {
      let changed = false;

      // Check for dead tmux session.
      //
      // Sweep BOTH agent homes. Task-execution agents live on
      // wf.taskExecution.taskStates[i].agents and are only mirrored onto
      // steps.task_execution.agents by updateStepAgents — which the normal
      // launch path does not call, so the mirror is routinely empty while a
      // task is running. Reading only steps[*].agents therefore missed exactly
      // the case this check exists for: a machine restart kills the tmux
      // session, and a task_execution agent stays 'running' forever with no
      // process behind it (deskrhythm DR-092, 2026-07-29 — the run sat inert
      // for hours, needsAttention stayed null, and the project could not start
      // anything else because the slot was still held).
      if (!tmuxOps.hasSession(activeWf.sessionName)) {
        for (const agent of agentRecovery.allAgentsOf(activeWf)) {
          if (agent.status === 'running') {
            agent.status = 'error';
            agent.error = 'Session lost — the tmux session is gone (machine restart, or the session was killed). Relaunch the step.';
            changed = true;
          }
        }
      }

      // Idle-based timeout — mark stalled when the agent's log file has not
      // been written to for AGENT_IDLE_TIMEOUT_MS. tmux pipe-pane streams all
      // pane output (including the Claude CLI's per-second spinner updates)
      // to the log, so log mtime is a reliable "is the agent alive" signal.
      //
      // Read through the task_execution mirror, for the same reason the
      // stale-session sweep above does: task agents live on
      // taskExecution.taskStates[i].agents and the step's copy is routinely
      // empty, so watching only the step skipped every task_execution run. A
      // codex agent that died on a usage limit therefore sat 'running' with a
      // shell prompt in its pane and nothing reported it (fazon FAZ-196,
      // 2026-07-31 — 40 minutes past a 15-minute timeout, needsAttention null).
      // allAgentsOf rather than the current step's list: it yields BOTH homes,
      // so marking an agent updates the mirror and the source together. (The
      // mirror is a shallow copy — marking one and not the other leaves the
      // launch guard still seeing 'running'.) Scoping by status is equivalent
      // to scoping by step, since only current-step agents are ever 'running'.
      {
        const now = Date.now();
        for (const agent of agentRecovery.allAgentsOf(activeWf)) {
          // An agent already marked 'error' by the idle timeout is still worth
          // examining, because that verdict may be the mislabel this code
          // exists to correct: a usage-limit block reads as a stall. If the
          // pane still shows the limit state, it is reclassified below and the
          // run recovers — otherwise the error stands and it is skipped.
          //
          // Without this the fix would only help blocks that happen AFTER a
          // deploy; an agent already sitting in 'error' would stay there.
          const errorMaybeLimit = agent.status === 'error' && !agent.feedback;
          if ((agent.status !== 'running' && !errorMaybeLimit) || !agent.startedAt || !agent.window) continue;
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

          // The agent's tmux target — needed by both the limit check below and
          // the dead/stalled classifier further down.
          const target = `${activeWf.sessionName}:${agent.window}`;

          // Waiting on a provider usage limit looks exactly like a stall to an
          // idle-timeout — no output for fifteen minutes either way — but it
          // needs the opposite handling: nothing, until the reset lands.
          //
          // Read the PANE, not the log tail. The notice scrolls far back in the
          // log because an idle TUI keeps repainting: measured 140 KB of redraw
          // after the notice in a real agent log, so any fixed tail misses it.
          // The pane still shows it, because nothing has happened since.
          let logText = '';
          let logSeenAt = null;
          try {
            logText = fs.readFileSync(logFile, 'utf8');
            logSeenAt = fs.statSync(logFile).mtimeMs;
          } catch (_) { /* no log yet */ }
          const limit = limitBlock.detectLimitState({
            pane: tmuxOps.capturePane(target, 200),
            log: logText,
            // Anchor to when the notice was printed, not to now — see
            // lib/limit-block.js. Getting this wrong parks an agent for a day
            // over a reset that already passed.
            seenAt: agent.blockedOnLimit ? agent.blockedOnLimit.detectedAt : (logSeenAt || now),
          }, new Date(now));
          if (limit) {
            if (!agent.blockedOnLimit) {
              agent.blockedOnLimit = {
                raw: limit.raw,
                resetsAt: limit.resetsAt ? limit.resetsAt.toISOString() : null,
                detectedAt: new Date(now).toISOString(),
                resumeCount: 0,
              };
              changed = true;
              console.log(`[limit] ${agent.role} blocked in ${activeWf.currentStep} — ${limitBlock.describeBlock(agent.blockedOnLimit, new Date(now))}`);
            }
            // Deliberately NOT marked 'error'. An errored agent is treated as a
            // terminal state by the review-advance guard, which is how one
            // returning agent came to carry a whole step forward while five
            // others had said nothing (2026-08-03). It is still running; it is
            // just waiting.
            const verdict = limitBlock.isResumeDue(agent.blockedOnLimit, new Date(now), {
              maxResumes: LIMIT_MAX_AUTO_RESUMES,
            });
            if (verdict.due) {
              try {
                if (limit.needsConfirm) {
                  // The CLI's chooser is on screen with "Stop and wait for
                  // limit to reset" already highlighted. It needs a bare Enter,
                  // NOT a pasted sentence — prose typed into a chooser goes
                  // nowhere and the trailing Enter then confirms whatever was
                  // selected. Dismiss it here; the nudge follows on a later tick
                  // once the pane is back to a prompt.
                  tmuxOps.sendKeysRaw(target, 'Enter');
                  console.log(`[limit] ${agent.role} — confirmed the CLI's wait-for-reset choice`);
                } else {
                  tmuxOps.sendMessage(target, LIMIT_RESUME_MESSAGE);
                  agent.blockedOnLimit.resumeCount = (agent.blockedOnLimit.resumeCount || 0) + 1;
                  agent.blockedOnLimit.lastResumeAt = new Date(now).toISOString();
                  console.log(`[limit] ${agent.role} auto-resumed (attempt ${agent.blockedOnLimit.resumeCount}/${LIMIT_MAX_AUTO_RESUMES}) — ${verdict.reason}`);
                }
                changed = true;
              } catch (e) {
                console.warn(`[limit] ${agent.role} auto-resume failed: ${e.message}`);
              }
            }
            continue; // never fall through to the stall timeout while blocked
          }
          // Output resumed after a block — the agent is working again.
          if (agent.blockedOnLimit) {
            console.log(`[limit] ${agent.role} resumed — clearing the block`);
            agent.blockedOnLimit = undefined;
            changed = true;
          }

          // An agent already in 'error' has had its verdict; the only thing that
          // can change it is the limit reclassification above. Nothing below
          // applies to it, and re-running the dead/stall judgement would just
          // rewrite the same error.
          if (agent.status === 'error') continue;

          // Just fired a resume — let the CLI boot and start repainting before
          // any further dead/stall judgement (the 30s tick would double-fire).
          if (agentRecovery.inResumeGrace(agent, now, AGENT_RESUME_GRACE_MS)) continue;

          // Dead-vs-stalled discrimination: a DEAD process (pane fell back to
          // the login shell — SIGKILL, crash fallout, CLI update) is recovered
          // immediately via the pre-written resume script (claude --resume with
          // the pinned session id = context intact). A live-but-silent process
          // (e.g. waiting at an interactive dialog) falls through to the slow
          // stall timeout below — resuming that one would destroy context.
          let cls = agentRecovery.classifyAgentProcess({
            paneCommand: tmuxOps.paneCommand(target),
            idleMs,
            deadConfirmMs: AGENT_DEAD_CONFIRM_MS,
            hasLiveChild: tmuxOps.hasLiveDescendant(tmuxOps.panePid(target)),
          });
          // The shell-pane dead heuristic is only trustworthy for claude agents
          // (constant repaints; stable pane command) and only pays off when a
          // resume script exists — it false-fired on a healthy opencode agent
          // (launch-studio qa_tests, 2026-07-20). Agents without resume
          // artifacts fall through to the idle stall timeout below, whose
          // verdict is accurate for a genuinely dead process too.
          if (cls === 'dead' && !agentRecovery.hasResumeArtifacts(agent)) cls = 'alive';
          if (cls !== 'alive') {
            const decision = cls === 'dead'
              ? agentRecovery.decideRecovery(agent, { maxAutoResumes: AGENT_MAX_AUTO_RESUMES })
              : 'halt'; // window gone — nowhere to resume in place
            if (decision === 'resume') {
              try {
                tmuxOps.sendKeys(target, `bash ${agent.resumeScript}`, config.projectRoot);
                agent.autoResumeCount = (agent.autoResumeCount || 0) + 1;
                agent.lastAutoResumeAt = new Date(now).toISOString();
                changed = true;
                console.log(`[agent-recovery] ${agent.role} process died in ${activeWf.currentStep} — auto-resumed with context (attempt ${agent.autoResumeCount}/${AGENT_MAX_AUTO_RESUMES}, session ${agent.cliSessionId})`);
              } catch (e) {
                agent.status = 'error';
                agent.error = `Agent process died and auto-resume failed (${e.message}). Relaunch the step.`;
                changed = true;
              }
            } else {
              agent.status = 'error';
              agent.error = cls === 'gone'
                ? 'Agent window disappeared — cannot recover in place. Relaunch the step.'
                : `Agent process died (pane returned to a shell prompt)${agent.cliSessionId ? ` — auto-resume exhausted after ${agent.autoResumeCount || 0} attempt(s)` : ' — auto-resume unavailable for this CLI'}. Relaunch the step.`;
              changed = true;
              console.log(`[agent-recovery] ${agent.role} ${cls} in ${activeWf.currentStep} — halted (${agent.error})`);
            }
            continue;
          }

          if (idleMs > AGENT_IDLE_TIMEOUT_MS) {
            agent.status = 'error';
            // Say which of the two it is. An agent on a CLI with no resumable
            // session (codex, opencode) is downgraded from 'dead' to 'alive'
            // above — deliberately, because the shell-pane heuristic false-fired
            // on a healthy opencode agent at the 2-minute mark. But that
            // downgrade only means "not confident enough to auto-resume"; it
            // does not mean the agent is alive, and reporting the result as
            // "may be stuck, waiting for input, or context exhausted" sends you
            // hunting for a live process that exited cleanly a quarter of an
            // hour ago (launch-studio, 2026-08-03: a codex QA agent that had
            // committed 557 lines of tests and quit).
            //
            // By the time the 15-minute timeout fires, the shell-pane signal is
            // far more trustworthy than it was at 2 minutes, so it is worth
            // reading again to name the outcome correctly.
            const exited = agentRecovery.isShellCommand(tmuxOps.paneCommand(target));
            agent.error = exited
              ? `Process exited ${Math.round(idleMs / 60000)} minutes ago (pane is back at a shell prompt) after ${Math.round(elapsed / 60000)}m of work`
                + `${agent.cliSessionId ? '' : ` — ${agent.cli || 'this CLI'} has no resumable session, so it cannot be continued in place`}. `
                + 'Check whether it committed its work before relaunching — if it did, recover that instead of redoing it.'
              : `Stalled — no log activity for ${Math.round(idleMs / 60000)} minutes (total elapsed ${Math.round(elapsed / 60000)}m). Agent may be stuck (waiting for input, crashed, or context exhausted). Cancel and re-launch.`;
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
   } catch (e) {
     console.error('[watchdog] tick failed (server stays up):', e && e.stack ? e.stack : e);
   }
  }, 30000);

  // Start server, auto-incrementing port if already in use
  const maxAttempts = 20;
  let attempt = 0;
  let currentPort = config.port;

  // Bind to loopback. Omitting the host makes Node listen on 0.0.0.0, which put
  // this API — workflow control, config writes, project file reads, tmux session
  // proxying, all of it unauthenticated — on every network the machine joins.
  // The only client is the Electron app on the same machine, over localhost.
  // Set BUILD_STUDIO_LISTEN_HOST=0.0.0.0 to opt back in deliberately.
  const listenHost = process.env.BUILD_STUDIO_LISTEN_HOST || '127.0.0.1';

  const tryListen = () => {
    server.listen(currentPort, listenHost, () => {
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
      // Warm the CI/alert caches so the first hub poll after a restart shows
      // real state instead of an empty light. No-ops without deployment.repo.
      monitor.prime();
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
