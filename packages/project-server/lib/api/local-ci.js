'use strict';

/**
 * Local CI — run the project's CI steps on this machine before a push.
 * See lib/local-ci.js for the why and for how state is judged.
 *
 *   GET  /deployment/local-ci         → { configured, verdict, badge, status, run, head, elapsedMs, logTail, canCancel }
 *   POST /deployment/local-ci/start   → starts deployment.local_ci.cmd in its cwd
 *   POST /deployment/local-ci/cancel  → SIGTERM to the process group it started
 *
 * The run is a DETACHED process group, so it outlives the tab, the hub and a
 * restart of this server: a full run takes 45–85 minutes. Nothing here ever
 * signals any process but the group this router started.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn: defaultSpawn, execFileSync } = require('child_process');
const lc = require('../local-ci');

function createLocalCiRouter(config, { spawn = defaultSpawn } = {}) {
  const router = express.Router();
  const logsPath = () => config.logsPath || path.join(config.projectRoot, 'tmp', '.logs');
  const logFile = () => path.join(logsPath(), lc.LOG_FILE);

  function head() {
    try {
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: config.projectRoot, encoding: 'utf8', timeout: 5000 }).trim();
    } catch (_) {
      return null;
    }
  }

  /** Everything the tab needs, judged once. */
  function snapshot(settings) {
    const status = lc.readStatus(settings.statusFile);
    const run = lc.readRunRecord(logsPath());
    const runAlive = !!(run && lc.isAlive(-run.pid));
    const statusAlive = !!(status && lc.isAlive(status.pid));
    const verdict = lc.interpret({ status, run, statusAlive, runAlive });
    // A status file left by an earlier run says nothing about this one.
    const current = verdict.statusIsCurrent ? status : null;
    const started = (current && current.startedAt) || (run && run.startedAt) || null;
    const ended = ['running', 'starting'].includes(verdict.state) ? Date.now()
      : Date.parse((current && (current.finishedAt || current.updatedAt)) || (run && (run.exitedAt || run.cancelRequestedAt)) || '') || null;
    return {
      configured: true,
      cmd: settings.cmd,
      verdict,
      badge: lc.freshness({ status: current, verdict, head: head() }),
      status: current,
      run: run ? { startedAt: run.startedAt, cancelRequestedAt: run.cancelRequestedAt || null, exitCode: run.exitCode ?? null } : null,
      elapsedMs: started && ended ? Math.max(0, ended - Date.parse(started)) : null,
      // The log is Build Studio's capture of a run it started. A run started in
      // a terminal has none here; its output is in that terminal.
      logTail: verdict.ours ? lc.logTail(logFile(), 60) : '',
      canCancel: !!(run && runAlive),
    };
  }

  router.get('/deployment/local-ci', (req, res) => {
    const settings = lc.localCiConfig(config);
    if (!settings) return res.json({ configured: false });
    res.json(snapshot(settings));
  });

  router.post('/deployment/local-ci/start', (req, res) => {
    const settings = lc.localCiConfig(config);
    if (!settings) return res.status(400).json({ error: 'deployment.local_ci is not configured for this project' });

    // One run per project. Ours, or one started in a terminal: both would write
    // the same status file, and two at once would also share one machine.
    const run = lc.readRunRecord(logsPath());
    if (run && lc.isAlive(-run.pid)) return res.status(409).json({ error: 'Local CI is already running.' });
    const status = lc.readStatus(settings.statusFile);
    if (status && status.state === 'running' && lc.isAlive(status.pid)) {
      return res.status(409).json({ error: `Local CI is already running (pid ${status.pid}, started outside Build Studio). Wait for it, or stop it where it was started.` });
    }
    if (!fs.existsSync(settings.cwd)) return res.status(400).json({ error: `local_ci.cwd does not exist: ${path.relative(config.projectRoot, settings.cwd) || '.'}` });

    let out;
    try {
      fs.mkdirSync(logsPath(), { recursive: true });
      out = fs.openSync(logFile(), 'w');
    } catch (e) {
      return res.status(500).json({ error: `could not open the log: ${e.message}` });
    }
    let child;
    try {
      // `cd` inside the shell, not spawn's cwd: in the app bundle the server's
      // own cwd can be invalid, and spawn's cwd option then fails silently
      // (see process-manager.js). Detached, so it is its own process group:
      // cancel signals the group, and the run outlives this server.
      child = spawn('/bin/sh', ['-c', `cd ${JSON.stringify(settings.cwd)} && ${settings.cmd}`], {
        detached: true,
        stdio: ['ignore', out, out],
        env: { ...process.env, FORCE_COLOR: '0' },
      });
    } catch (e) {
      fs.closeSync(out);
      return res.status(500).json({ error: `could not start: ${e.message}` });
    }
    fs.closeSync(out);
    if (!child || !child.pid) return res.status(500).json({ error: 'could not start the local CI process' });
    child.unref();

    const record = { pid: child.pid, startedAt: new Date().toISOString(), cmd: settings.cmd, logFile: logFile() };
    lc.writeRunRecord(logsPath(), record);
    // Recorded when this server is still the parent. After a restart it is not,
    // and the status file and the group's liveness are what remain.
    child.on('exit', (code, signal) => {
      const now = lc.readRunRecord(logsPath());
      if (!now || now.pid !== record.pid) return;
      lc.writeRunRecord(logsPath(), { ...now, exitedAt: new Date().toISOString(), exitCode: code, exitSignal: signal || null });
    });
    child.on('error', (e) => console.warn(`[local-ci] process error: ${e.message}`));
    console.log(`[local-ci] started "${settings.cmd}" (pgid ${child.pid})`);
    res.json(snapshot(settings));
  });

  router.post('/deployment/local-ci/cancel', (req, res) => {
    const settings = lc.localCiConfig(config);
    if (!settings) return res.status(400).json({ error: 'deployment.local_ci is not configured for this project' });
    const run = lc.readRunRecord(logsPath());
    // Only a run this server started: its process group is known. A run started
    // in a terminal belongs to that terminal's job, and signalling a guessed
    // group could take the owner's shell with it.
    if (!run || !lc.isAlive(-run.pid)) return res.status(409).json({ error: 'No local CI run started from Build Studio is in progress.' });
    lc.writeRunRecord(logsPath(), { ...run, cancelRequestedAt: new Date().toISOString() });
    try {
      process.kill(-run.pid, 'SIGTERM');
    } catch (e) {
      if (e.code !== 'ESRCH') return res.status(500).json({ error: `could not cancel: ${e.message}` });
    }
    console.log(`[local-ci] cancel requested (pgid ${run.pid})`);
    res.json(snapshot(settings));
  });

  return router;
}

module.exports = { createLocalCiRouter };
