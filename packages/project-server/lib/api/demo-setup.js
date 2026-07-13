/**
 * Operations → Demo setup button backend.
 *
 * Generic contract: if the managed project has `scripts/demo-setup.sh`, the
 * hub shows a "Demo setup" card in Operations → Services. The script owns
 * everything project-specific (boot simulator, `simctl status_bar` override,
 * seed demo data, …); this router just runs it.
 *
 * Endpoints:
 *   GET  /api/demo-setup       — { available, script, running, lastRun }
 *   POST /api/demo-setup/run   — run the script; responds when it finishes
 *
 * The run is synchronous from the client's point of view (the button shows a
 * spinner), but guarded by a hard timeout that kills the whole process group —
 * simctl is known to hang under UITest load on this machine.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT_REL = path.join('scripts', 'demo-setup.sh');
const MAX_OUTPUT_BYTES = 200 * 1024;

function createDemoSetupRouter(config) {
  const router = express.Router();
  const scriptAbs = path.join(config.projectRoot, SCRIPT_REL);
  const lastRunFile = path.join(config.tmpPath, 'demo-setup-last.json');
  let running = false;

  function readLastRun() {
    try { return JSON.parse(fs.readFileSync(lastRunFile, 'utf8')); } catch (_) { return null; }
  }

  function saveLastRun(meta) {
    try {
      fs.mkdirSync(path.dirname(lastRunFile), { recursive: true });
      fs.writeFileSync(lastRunFile, JSON.stringify(meta, null, 2));
    } catch (e) {
      console.error('[demo-setup] failed to persist last run:', e.message);
    }
  }

  router.get('/demo-setup', (req, res) => {
    res.json({
      available: fs.existsSync(scriptAbs),
      script: SCRIPT_REL,
      running,
      lastRun: readLastRun(),
    });
  });

  router.post('/demo-setup/run', (req, res) => {
    if (running) {
      return res.status(409).json({ error: 'Demo setup is already running.' });
    }
    if (!fs.existsSync(scriptAbs)) {
      return res.status(404).json({ error: `No ${SCRIPT_REL} in this project.` });
    }

    const timeoutSeconds = typeof config.demo_setup_timeout_seconds === 'number'
      ? config.demo_setup_timeout_seconds
      : 180;

    running = true;
    const startedAt = new Date().toISOString();
    let output = '';
    let truncated = false;
    let timedOut = false;

    const child = spawn('bash', [scriptAbs], {
      cwd: config.projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // own process group → timeout kill reaches simctl children
    });

    const append = (buf) => {
      if (output.length >= MAX_OUTPUT_BYTES) { truncated = true; return; }
      output += buf.toString('utf8');
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);

    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { try { child.kill('SIGKILL'); } catch (_) {} }
    }, timeoutSeconds * 1000);

    child.on('error', (err) => {
      clearTimeout(timer);
      running = false;
      const meta = {
        startedAt, completedAt: new Date().toISOString(),
        status: 'errored', exitCode: null, output: `spawn failed: ${err.message}`, truncated: false,
      };
      saveLastRun(meta);
      res.status(500).json({ error: err.message, lastRun: meta });
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      running = false;
      const completedAt = new Date().toISOString();
      const status = timedOut ? 'timeout' : code === 0 ? 'ok' : 'failed';
      const meta = {
        startedAt, completedAt,
        durationSeconds: Math.round((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000),
        status,
        exitCode: code,
        signal: signal || null,
        output: output.slice(0, MAX_OUTPUT_BYTES),
        truncated,
      };
      saveLastRun(meta);
      if (!res.headersSent) res.json({ lastRun: meta });
    });
  });

  return router;
}

module.exports = { createDemoSetupRouter };
