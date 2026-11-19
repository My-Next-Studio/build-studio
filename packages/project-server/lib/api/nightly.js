'use strict';

/**
 * Operations → Nightly — a project's scheduled test run. See lib/nightly.js
 * for the config, the status-directory contract and when a run starts.
 *
 *   GET  /ops/nightly                          → everything the tab shows
 *   GET  /ops/nightly/brief                    → { configured, red, running } for the tab's dot
 *   POST /ops/nightly/schedule                 → { enabled, at } — per machine, in local.json
 *   POST /ops/nightly/run                      → start a run now (detached)
 *   GET  /ops/nightly/runs/:id/log             → { tail } of that run's run.log (?lines=N)
 *   POST /ops/nightly/runs/:id/investigate     → start an agent diagnosing that run
 *   GET  /ops/nightly/runs/:id/investigation   → { state, markdown }
 *
 * Nothing here stops a run: the runner's own lock keeps two from overlapping,
 * and a suite killed mid-way leaves the project's services half set up.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawn: defaultSpawn, execFileSync } = require('child_process');
const nl = require('../nightly');
const { activeAgents } = require('../project-overview');
const { loadLocalOverrides, saveLocalOverrides } = require('../config');
const { runOneShot: defaultRunOneShot, getOneShotStatus: defaultGetOneShotStatus } = require('../oneshot');

const TICK_MS = 60 * 1000;
const INVESTIGATE_MAX_DURATION_MS = 20 * 60 * 1000;

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

/** Why a workflow makes this a bad moment to run the suite, or null. */
function workflowBusy(wf) {
  if (!wf || !wf.currentStep || wf.currentStep === 'completed') return null;
  const name = wf.itemId || wf.input || 'a workflow';
  const agents = activeAgents(wf);
  if (agents.length) return `${name} has ${agents.length === 1 ? 'an agent' : `${agents.length} agents`} at work`;
  const step = wf.steps && wf.steps[wf.currentStep];
  if (step && step.status === 'running') return `${name} is in ${wf.currentStep}`;
  return null;
}

function composeInvestigatePrompt({ label, run, statusDir, runDir, resultFile, projectRoot }) {
  const s = run.summary;
  const rel = (p) => path.relative(projectRoot, p) || '.';
  const list = (xs) => (xs && xs.length ? xs.map((x) => `- ${x}`).join('\n') : '- (none)');
  return [
    `You are diagnosing a failed scheduled test run ("${label}") in this project. Diagnose only.`,
    '',
    '## The run',
    `- Started ${s.startedAt}, finished ${s.finishedAt || '?'}, on ${s.branch || '?'} at ${s.head || '?'}${s.dirtyWorkingTree ? ' (working tree had uncommitted changes)' : ''}`,
    s.error
      ? `- It could not be carried out: ${s.error}`
      : `- ${s.passed ?? 0} passed, ${s.failed ?? 0} failed, ${s.flaky ?? 0} flaky (passed only on retry), ${s.skipped ?? 0} skipped`,
    '',
    '### Failed',
    list(s.failures),
    '',
    '### Flaky',
    list(s.flakes),
    '',
    '## Evidence',
    `- Run directory: ${rel(runDir)} — run.log (setup and test output), report.json (the test runner's JSON report, with each failure's error and stack), test-results/ (traces, screenshots).`,
    `- Earlier runs, for comparison: ${rel(path.join(statusDir, 'runs'))}/*/summary.json`,
    `- What changed since the previous passing run: git log / git diff between its head and ${s.head || 'this head'}.`,
    '',
    '## Rules',
    '- Do not edit tracked files, commit, stash, or switch branches.',
    '- Do not start, stop or reset services (databases, dev servers, containers): another run or a workflow may be using them.',
    '- You may re-run ONE failing test at a time to confirm a theory, only when the services it needs are already up.',
    '',
    '## For each failed test (and each flaky one), decide',
    '- **product bug** — the app is wrong; name the file and the change that most likely caused it;',
    '- **test bug** — the test is wrong or out of date; say what it should assert instead;',
    '- **flaky** — timing or ordering; say what makes it race;',
    '- **environment** — setup, data or machine; say what to fix.',
    'Give the evidence for each (a line from report.json or run.log, a commit). Group tests that share one cause.',
    'End with "## Suggested next steps": what to fix first, and a one-paragraph bug report for each product bug, ready to paste into the backlog.',
    '',
    '## Output',
    `Write your diagnosis as Markdown to ${resultFile} — that file is how Build Studio shows it. Write it last, in one go.`,
  ].join('\n');
}

function createNightly(config, {
  state = null,
  spawn = defaultSpawn,
  git = (args) => execFileSync('git', args, { cwd: config.projectRoot, encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).trim(),
  runOneShot = defaultRunOneShot,
  getOneShotStatus = defaultGetOneShotStatus,
  loadLocal = () => loadLocalOverrides(config.projectRoot),
  saveLocal = (patch) => saveLocalOverrides(config.projectRoot, patch),
  now = () => Date.now(),
} = {}) {
  const router = express.Router();
  const logsPath = () => config.logsPath || path.join(config.projectRoot, 'tmp', '.logs');
  const logFile = () => path.join(logsPath(), nl.LOG_FILE);
  const recordFile = () => path.join(logsPath(), nl.RUN_RECORD);
  const schedulerFile = () => path.join(logsPath(), nl.SCHEDULER_FILE);
  const investigateDir = () => path.join(config.projectRoot, 'tmp', 'nightly-investigate');
  const settingsNow = () => nl.nightlyConfig(config, loadLocal());
  const tryGit = (args) => { try { return git(args); } catch (_) { return null; } };

  function current(settings, runs) {
    const record = nl.readJson(recordFile());
    return nl.currentState({
      lock: nl.readLock(settings.statusDir),
      record,
      recordAlive: !!(record && nl.isAlive(-record.pid)),
      newestRun: runs[0] || null,
      now: now(),
    });
  }

  function snapshot(settings) {
    const runs = nl.readRuns(settings.statusDir);
    const finished = runs.filter((r) => r.summary);
    const sched = nl.readJson(schedulerFile()) || {};
    return {
      configured: true,
      label: settings.label,
      cmd: settings.cmd,
      branch: settings.branch,
      statusDir: path.relative(config.projectRoot, settings.statusDir) || '.',
      schedule: {
        enabled: settings.enabled,
        at: settings.at,
        nextAt: settings.enabled ? new Date(nl.nextSlot(now(), settings.at)).toISOString() : null,
        lastDecision: sched.lastDecision || null,
      },
      current: current(settings, runs),
      latest: finished[0] || null,
      runs,
      recurring: nl.recurring(runs),
      typicalDurationSec: median(finished.filter((r) => ['passed', 'flaky', 'failed'].includes(r.outcome) && Number.isFinite(r.summary.durationSec)).map((r) => r.summary.durationSec)),
      // Build Studio's capture of the run it started: the runner's own run.log
      // only begins once it has a run directory.
      ownLogTail: nl.logTail(logFile(), 40),
    };
  }

  /** Start the runner, detached. Throws with `.status` for the HTTP layer. */
  function startRun(settings, trigger) {
    const runs = nl.readRuns(settings.statusDir);
    const cur = current(settings, runs);
    const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };
    if (cur.state === 'running') fail(409, `A run is already in progress${cur.pid ? ` (pid ${cur.pid})` : ''}.`);
    if (cur.state === 'starting') fail(409, 'A run was just started and is getting going.');
    if (!fs.existsSync(settings.cwd)) fail(400, `nightly.cwd does not exist: ${path.relative(config.projectRoot, settings.cwd) || '.'}`);

    fs.mkdirSync(logsPath(), { recursive: true });
    const out = fs.openSync(logFile(), 'w');
    let child;
    try {
      // A login shell, so the runner sees the PATH a terminal has (docker,
      // npm, …) rather than the bare one the app was launched with. `cd` in
      // the shell, not spawn's cwd (invalid in the app bundle). Detached: the
      // run takes ~30 minutes and must outlive this server.
      child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', `cd ${JSON.stringify(settings.cwd)} && ${settings.cmd}`], {
        detached: true,
        stdio: ['ignore', out, out],
        env: { ...process.env, FORCE_COLOR: '0' },
      });
    } finally {
      fs.closeSync(out);
    }
    if (!child || !child.pid) fail(500, 'could not start the nightly run');
    child.unref();
    child.on('error', (e) => console.warn(`[nightly] process error: ${e.message}`));
    nl.writeJson(recordFile(), { pid: child.pid, startedAt: new Date(now()).toISOString(), trigger, cmd: settings.cmd });
    console.log(`[nightly] started "${settings.cmd}" (${trigger}, pgid ${child.pid})`);
  }

  // ── scheduler ────────────────────────────────────────────────────────────

  function tick() {
    const settings = settingsNow();
    if (!settings || !settings.enabled) return null;
    const sched = nl.readJson(schedulerFile()) || {};
    if (!Number.isFinite(sched.handledSlot)) {
      // Turned on by hand-editing local.json, or the state file was lost:
      // start from the next occurrence rather than running at once.
      nl.writeJson(schedulerFile(), { ...sched, handledSlot: nl.latestSlot(now(), settings.at) });
      return null;
    }
    const runs = nl.readRuns(settings.statusDir);
    const d = nl.decide({
      settings,
      schedulerState: sched,
      now: now(),
      current: current(settings, runs),
      workflowBusy: workflowBusy(state ? state.loadWorkflow() : null),
      checkoutBranch: tryGit(['rev-parse', '--abbrev-ref', 'HEAD']),
      branchHead: tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${settings.branch}`]),
      runs,
    });
    if (d.action === 'none') return d;
    const at = new Date(now()).toISOString();
    if (d.action === 'wait') {
      // Written when the reason changes, not every minute.
      if (!sched.lastDecision || sched.lastDecision.reason !== d.reason || sched.lastDecision.slot !== d.slot) {
        nl.writeJson(schedulerFile(), { ...sched, lastDecision: { at, slot: d.slot, action: 'wait', reason: d.reason } });
      }
      return d;
    }
    if (d.action === 'start') {
      try {
        startRun(settings, 'schedule');
      } catch (e) {
        // Recorded, and tried again next tick; a broken cmd shows in the tab.
        nl.writeJson(schedulerFile(), { ...sched, lastDecision: { at, slot: d.slot, action: 'wait', reason: `could not start: ${e.message}` } });
        return { action: 'wait', slot: d.slot, reason: e.message };
      }
    } else {
      console.log(`[nightly] skipped: ${d.reason}`);
    }
    nl.writeJson(schedulerFile(), { handledSlot: d.slot, lastDecision: { at, slot: d.slot, action: d.action, reason: d.reason || null } });
    return d;
  }

  let timer = null;
  function startTicking() {
    if (timer) return;
    timer = setInterval(() => {
      try { tick(); } catch (e) { console.warn(`[nightly] tick failed: ${e.message}`); }
    }, TICK_MS);
    if (timer.unref) timer.unref();
  }
  function stopTicking() { if (timer) clearInterval(timer); timer = null; }

  function alerts() {
    const settings = settingsNow();
    if (!settings) return [];
    const a = nl.failureAlert(nl.readRuns(settings.statusDir), { project: config.name || 'project', label: settings.label });
    return a ? [a] : [];
  }

  // ── routes ───────────────────────────────────────────────────────────────

  const notConfigured = (res) => res.status(400).json({ error: 'nightly is not configured for this project (nightly.cmd and nightly.status_dir in .build-studio/config.yaml)' });

  /** The run with this id, or null. The id is never joined into a path unchecked. */
  function findRun(settings, id) {
    if (!nl.runIdToIso(id)) return null;
    return nl.readRuns(settings.statusDir).find((r) => r.id === id) || null;
  }

  router.get('/ops/nightly', (req, res) => {
    const settings = settingsNow();
    if (!settings) return res.json({ configured: false });
    try { res.json(snapshot(settings)); } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/ops/nightly/brief', (req, res) => {
    const settings = settingsNow();
    if (!settings) return res.json({ configured: false });
    const runs = nl.readRuns(settings.statusDir);
    const latest = runs.find((r) => r.summary);
    res.json({ configured: true, red: !!latest && ['failed', 'error'].includes(latest.outcome), running: current(settings, runs).state !== 'idle' });
  });

  router.post('/ops/nightly/schedule', (req, res) => {
    const settings = settingsNow();
    if (!settings) return notConfigured(res);
    const body = req.body || {};
    const enabled = typeof body.enabled === 'boolean' ? body.enabled : settings.enabled;
    const at = body.at === undefined ? settings.at : body.at;
    if (!nl.isTime(at)) return res.status(400).json({ error: 'at must be a time like 03:30' });
    try {
      saveLocal({ nightly: { enabled, at } });
      // Counted from now: turning it on at 10:00 for 03:30 runs tonight, not
      // at once for this morning's slot.
      const sched = nl.readJson(schedulerFile()) || {};
      nl.writeJson(schedulerFile(), { ...sched, handledSlot: nl.latestSlot(now(), at), lastDecision: null });
    } catch (e) {
      return res.status(500).json({ error: `could not save: ${e.message}` });
    }
    res.json(snapshot(settingsNow()));
  });

  router.post('/ops/nightly/run', (req, res) => {
    const settings = settingsNow();
    if (!settings) return notConfigured(res);
    try {
      startRun(settings, 'manual');
    } catch (e) {
      return res.status(e.status || 500).json({ error: e.message });
    }
    res.json(snapshot(settings));
  });

  router.get('/ops/nightly/runs/:id/log', (req, res) => {
    const settings = settingsNow();
    if (!settings) return notConfigured(res);
    const run = findRun(settings, req.params.id);
    if (!run) return res.status(404).json({ error: 'no such run' });
    const lines = Math.min(Math.max(Number(req.query.lines) || 200, 1), 2000);
    res.json({ tail: nl.logTail(path.join(settings.statusDir, 'runs', run.id, 'run.log'), lines) });
  });

  const investigationFiles = (id) => ({
    pointer: path.join(investigateDir(), `${id}.json`),
    result: path.join(investigateDir(), `${id}.md`),
  });

  router.post('/ops/nightly/runs/:id/investigate', (req, res) => {
    const settings = settingsNow();
    if (!settings) return notConfigured(res);
    const run = findRun(settings, req.params.id);
    if (!run) return res.status(404).json({ error: 'no such run' });
    if (!run.summary || run.outcome === 'passed') return res.status(400).json({ error: 'That run has nothing to investigate.' });
    const files = investigationFiles(run.id);
    const pointer = nl.readJson(files.pointer);
    if (pointer && getOneShotStatus(pointer.oneshotRunId)?.state === 'running') {
      return res.status(409).json({ error: 'An investigation of this run is already going.' });
    }
    fs.mkdirSync(investigateDir(), { recursive: true });
    try { fs.unlinkSync(files.result); } catch (_) { /* none yet */ }
    let started;
    try {
      started = runOneShot({
        projectRoot: config.projectRoot,
        prompt: composeInvestigatePrompt({
          label: settings.label, run, statusDir: settings.statusDir,
          runDir: path.join(settings.statusDir, 'runs', run.id), resultFile: files.result, projectRoot: config.projectRoot,
        }),
        label: 'nightly-investigate',
        maxDurationMs: INVESTIGATE_MAX_DURATION_MS,
        agentDefaults: config.agent_defaults,
      });
    } catch (e) {
      if (e.code === 'CONFLICT') return res.status(409).json({ error: 'Another one-shot agent is running in this project; try again when it is done.' });
      return res.status(500).json({ error: e.message });
    }
    nl.writeJson(files.pointer, { oneshotRunId: started.runId, sessionName: started.sessionName, startedAt: new Date(now()).toISOString() });
    res.json({ state: 'running', sessionName: started.sessionName });
  });

  router.get('/ops/nightly/runs/:id/investigation', (req, res) => {
    const settings = settingsNow();
    if (!settings) return notConfigured(res);
    const run = findRun(settings, req.params.id);
    if (!run) return res.status(404).json({ error: 'no such run' });
    const files = investigationFiles(run.id);
    const pointer = nl.readJson(files.pointer);
    if (!pointer) return res.json({ state: 'none' });
    const entry = getOneShotStatus(pointer.oneshotRunId);
    const base = { startedAt: pointer.startedAt, sessionName: pointer.sessionName || null };
    if (entry && entry.state === 'running') return res.json({ ...base, state: 'running' });
    let markdown = null;
    try { markdown = fs.readFileSync(files.result, 'utf8'); } catch (_) { /* not written */ }
    if (markdown) return res.json({ ...base, state: 'complete', markdown });
    if (entry) return res.json({ ...base, state: 'error', error: entry.stderr || `the agent ended (${entry.state}) without writing a diagnosis` });
    // No live agent and no result: it did not survive a server restart.
    return res.json({ ...base, state: 'lost' });
  });

  return { router, tick, startTicking, stopTicking, alerts };
}

module.exports = { createNightly, workflowBusy, composeInvestigatePrompt };
