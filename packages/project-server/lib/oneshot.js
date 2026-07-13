'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn: defaultSpawn } = require('child_process');
const { createTmuxOps } = require('./tmux');

const DEFAULT_MAX_DURATION_MS = 10 * 60 * 1000; // 10 minutes
const RETENTION_DAYS = 7;

// Mirror run.js's model-name → CLI model-id mapping so oneshot launches use the
// same model the workflow agents do for the same project.
const MODEL_IDS = { opus: 'claude-opus-4-6', sonnet: 'claude-sonnet-4-6' };

/**
 * Resolve the argv + env for a `claude` spawn from the project's agent_defaults.
 * Mirrors the logic in api/run.js so oneshot launches behave identically to
 * workflow-agent launches with respect to permission bypass, API-key handling,
 * and model selection.
 */
function buildSpawnOptions({ promptFile, projectRoot, agentDefaults }) {
  const argv = ['-p', '@' + promptFile];

  const { resolvePermissionMode } = require('./permission-mode');
  const permissionMode = resolvePermissionMode(agentDefaults);
  if (permissionMode !== 'default') argv.unshift('--permission-mode', permissionMode);

  const modelKey = agentDefaults && agentDefaults.model;
  if (modelKey) {
    const modelId = MODEL_IDS[modelKey] || modelKey;
    argv.unshift('--model', modelId);
  }

  const env = { ...process.env };
  if (agentDefaults && agentDefaults.unset_api_key === true) {
    delete env.ANTHROPIC_API_KEY;
  }
  // Ensure `claude` resolves. The workflow-agent launch (api/run.js) runs claude inside a
  // bash script that first does `eval "$(/opt/homebrew/bin/brew shellenv)"`, so it gets the
  // full PATH. This is a DIRECT spawn, which inherits the project-server's PATH — and when
  // the server is launched from a GUI context (Electron from Finder/Dock) that PATH is
  // minimal and lacks the homebrew / npm-global bin dirs where the CLI lives → spawn claude
  // ENOENT. Prepend the standard install locations so the lookup succeeds regardless.
  const home = process.env.HOME || '';
  env.PATH = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin',
    home && `${home}/.npm-global/bin`, home && `${home}/.local/bin`,
    '/usr/bin', '/bin', '/usr/sbin', '/sbin',
    process.env.PATH || '',
  ].filter(Boolean).join(':');

  return { argv, spawnOpts: { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'], env } };
}

function sweepOldFiles(oneshotDir) {
  if (!fs.existsSync(oneshotDir)) return;
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  try {
    for (const f of fs.readdirSync(oneshotDir)) {
      if (!f.endsWith('.log') && !f.endsWith('.prompt.txt')) continue;
      const abs = path.join(oneshotDir, f);
      try {
        if (fs.statSync(abs).mtimeMs < cutoff) fs.unlinkSync(abs);
      } catch {}
    }
  } catch {}
}

/**
 * Factory that creates a oneshot runner with injectable dependencies (for testing).
 */
function createOneShotRunner({ spawnFn = defaultSpawn, tmuxOpsFactory = createTmuxOps } = {}) {
  // Per-project concurrency map: projectRoot → runId
  const concurrencyMap = new Map();

  // Status registry: runId → status object
  const statusRegistry = new Map();

  function getOneShotStatus(runId) {
    return statusRegistry.get(runId) || null;
  }

  function spawnPass(promptFile, projectRoot, logPath, agentDefaults) {
    return new Promise((resolve, reject) => {
      // Open synchronously so the fd is valid even if the oneshotDir is cleaned
      // up before the async I/O completes (e.g. in tests with short timeouts).
      const fd = fs.openSync(logPath, 'a');
      const logStream = fs.createWriteStream(null, { fd, autoClose: true });

      // Argv array — no shell interpolation of user-supplied content.
      // Honors project agent_defaults (skip_permissions, unset_api_key, model)
      // so oneshot launches behave the same way workflow agents do.
      const { argv, spawnOpts } = buildSpawnOptions({ promptFile, projectRoot, agentDefaults });
      const proc = spawnFn('claude', argv, spawnOpts);

      let stderrBuf = '';
      proc.stdout.on('data', (chunk) => logStream.write(chunk));
      proc.stderr.on('data', (chunk) => {
        logStream.write(chunk);
        stderrBuf += chunk.toString();
      });

      proc.on('close', (code) => {
        logStream.end(() => {
          if (code === 0) {
            resolve();
          } else {
            const err = new Error(`claude exited with code ${code}`);
            err.exitCode = code;
            err.stderr = stderrBuf;
            reject(err);
          }
        });
      });

      proc.on('error', (err) => {
        logStream.end(() => reject(err));
      });
    });
  }

  function runPassesSequentially(promptFiles, projectRoot, logPath, agentDefaults) {
    return promptFiles.reduce(
      (chain, promptFile) => chain.then(() => spawnPass(promptFile, projectRoot, logPath, agentDefaults)),
      Promise.resolve()
    );
  }

  function teardown(projectRoot, promptFiles) {
    concurrencyMap.delete(projectRoot);
    for (const f of promptFiles) {
      try { fs.unlinkSync(f); } catch {}
    }
    const oneshotDir = path.join(projectRoot, 'tmp', 'oneshot');
    sweepOldFiles(oneshotDir);
  }

  /**
   * Run a one-shot claude agent session (no worktree, no state.saveRun()).
   *
   * @param {object} opts
   * @param {string} opts.projectRoot    - absolute path to the project working tree
   * @param {string} opts.prompt         - prompt for pass 1 (or the only pass)
   * @param {string} opts.label          - short label used in session name ("marketing", "suggest", …)
   * @param {string[]} [opts.passes]     - if provided, prompts for passes 2, 3, … (pass 1 is always opts.prompt)
   * @param {number}  [opts.maxDurationMs] - timeout override (default 10 min)
   * @param {object}  [opts.agentDefaults] - { skip_permissions, unset_api_key, model } from project config.agent_defaults.
   *                                         Honored on every spawned `claude` pass so oneshot launches
   *                                         match workflow agents (no permission hangs, no accidental API spend,
   *                                         correct model). Pass `undefined` to use plain `claude` defaults.
   * @returns {{ runId, sessionName, logPath, donePromise }}
   * @throws {Error} with code 'CONFLICT' if a run is already active for this projectRoot
   */
  function runOneShot({ projectRoot, prompt, label, passes, maxDurationMs, agentDefaults } = {}) {
    if (concurrencyMap.has(projectRoot)) {
      const err = new Error(
        'A marketing run is already in progress; wait for it to finish or cancel it'
      );
      err.code = 'CONFLICT';
      throw err;
    }

    const runId = crypto.randomBytes(8).toString('hex');
    const timestamp = Date.now();
    const sessionName = `oneshot-${label}-${timestamp}`;
    const oneshotDir = path.join(projectRoot, 'tmp', 'oneshot');

    fs.mkdirSync(oneshotDir, { recursive: true });
    sweepOldFiles(oneshotDir);

    const logPath = path.join(oneshotDir, `${sessionName}.log`);

    // Build the ordered pass prompts: prompt is always pass 1; passes adds subsequent ones.
    const allPassPrompts = [prompt, ...(passes || [])];

    const promptFiles = allPassPrompts.map((passPrompt, i) => {
      const promptFile = path.join(oneshotDir, `${runId}-pass${i}.prompt.txt`);
      fs.writeFileSync(promptFile, passPrompt || '', 'utf8');
      return promptFile;
    });

    const startedAt = Date.now();
    const status = {
      runId,
      state: 'running',
      startedAt,
      durationMs: 0,
      exitCode: null,
      stderr: null,
    };
    statusRegistry.set(runId, status);
    concurrencyMap.set(projectRoot, runId);

    // Create tmux session for observability (failures here are non-fatal).
    const tmuxOps = tmuxOpsFactory({ name: label || 'oneshot' });
    try {
      tmuxOps.createSession(sessionName, 'oneshot', projectRoot);
      tmuxOps.pipePaneToLog(`${sessionName}:oneshot`, logPath, projectRoot);
    } catch {}

    const maxDuration = maxDurationMs !== undefined ? maxDurationMs : DEFAULT_MAX_DURATION_MS;
    let timedOut = false;

    const donePromise = new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        try { tmuxOps.killSession(sessionName); } catch {}
        teardown(projectRoot, promptFiles);
        status.state = 'timeout';
        status.durationMs = Date.now() - startedAt;
        resolve({ state: 'timeout' });
      }, maxDuration);

      runPassesSequentially(promptFiles, projectRoot, logPath, agentDefaults)
        .then(() => {
          if (timedOut) return;
          clearTimeout(timeoutHandle);
          try { tmuxOps.killSession(sessionName); } catch {}
          teardown(projectRoot, promptFiles);
          status.state = 'complete';
          status.durationMs = Date.now() - startedAt;
          resolve({ state: 'complete' });
        })
        .catch((err) => {
          if (timedOut) return;
          clearTimeout(timeoutHandle);
          try { tmuxOps.killSession(sessionName); } catch {}
          teardown(projectRoot, promptFiles);
          status.state = 'error';
          status.durationMs = Date.now() - startedAt;
          status.exitCode = err.exitCode || null;
          status.stderr = err.stderr || err.message;
          resolve({ state: 'error' });
        });
    });

    return { runId, sessionName, logPath, donePromise };
  }

  return { runOneShot, getOneShotStatus };
}

// Default singleton instance used by the server.
const { runOneShot, getOneShotStatus } = createOneShotRunner();

module.exports = {
  runOneShot,
  getOneShotStatus,
  sweepOldFiles,
  buildSpawnOptions, // exported for unit tests
  createOneShotRunner, // exported for unit tests
};
