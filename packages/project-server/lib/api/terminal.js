const express = require('express');
const fs = require('fs');
const path = require('path');
const { stripAnsi, renderPipePaneLog } = require('../tmux');

/**
 * Resolve a role name or tmux window name to the live tmux target of an
 * agent in the active workflow (any step, task-execution state) or run.
 * Returns { sessionName, window } or null. Used by the WebSocket
 * live-terminal attach in server.js — the client only ever names an
 * agent; the tmux target is always resolved server-side from state.
 */
function resolveAgentTarget(state, roleOrWindow, draftStatePath = null) {
  const key = String(roleOrWindow || '').toLowerCase();
  const match = (a) => a && (a.window === roleOrWindow || (a.role || '').toLowerCase() === key);
  const wf = state.loadWorkflow();
  if (wf) {
    let agent = (wf.steps?.[wf.currentStep]?.agents || []).find(match);
    if (!agent && wf.taskExecution?.taskStates) {
      for (const ts of Object.values(wf.taskExecution.taskStates)) {
        agent = (ts.agents || []).find(match);
        if (agent) break;
      }
    }
    if (!agent) {
      for (const step of Object.values(wf.steps || {})) {
        agent = (step.agents || []).find(match);
        if (agent) break;
      }
    }
    if (agent && agent.window) return { sessionName: wf.sessionName, window: agent.window };
  }
  const run = typeof state.loadRun === 'function' ? state.loadRun() : null;
  if (run) {
    const worker = (run.workers || []).find(w => w.window === roleOrWindow || w.branch === roleOrWindow);
    if (worker && worker.window) return { sessionName: run.sessionName, window: worker.window };
  }
  // Drafting sessions live outside the workflow slot in their own tmux session,
  // so neither lookup above can see them. Resolving them here is what lets the
  // existing terminal panel attach to a drafting window unchanged — the panel
  // needs a {sessionName, window}, and where that pair comes from is not its
  // concern.
  if (draftStatePath) {
    try {
      const { loadDraftState } = require('../drafting');
      const draft = loadDraftState(draftStatePath);
      const entry = Object.values((draft && draft.sessions) || {})
        .find(d => d && d.window === roleOrWindow);
      if (entry && draft.sessionName) return { sessionName: draft.sessionName, window: entry.window };
    } catch (_) { /* advisory — a missing drafting state is not an error here */ }
  }
  return null;
}

function createTerminalRouter(config, state, tmuxOps) {
  const router = express.Router();

  // Workflow terminal capture
  router.get('/workflow/:role', (req, res) => {
    const { role } = req.params;
    const lines = Math.min(parseInt(req.query.lines || '80', 10), 300);
    const wf = state.loadWorkflow();
    if (!wf) return res.json({ log: '' });
    const roleLC = role.toLowerCase();

    // Search all steps and task states for matching agent (not just current step)
    let agent = null;
    // 1. Check current step first
    const currentStep = wf.steps[wf.currentStep];
    if (currentStep?.agents) {
      agent = currentStep.agents.find(a => a.role?.toLowerCase() === roleLC || a.window === role);
    }
    // 2. Check task execution states
    if (!agent && wf.taskExecution?.taskStates) {
      for (const ts of Object.values(wf.taskExecution.taskStates)) {
        agent = (ts.agents || []).find(a => a.role?.toLowerCase() === roleLC || a.window === role);
        if (agent) break;
      }
    }
    // 3. Check all other steps
    if (!agent) {
      for (const step of Object.values(wf.steps || {})) {
        agent = (step.agents || []).find(a => a.role?.toLowerCase() === roleLC || a.window === role);
        if (agent) break;
      }
    }

    if (!agent || !agent.window) return res.json({ log: '' });
    const target = `${wf.sessionName}:${agent.window}`;
    const live = stripAnsi(tmuxOps.capturePane(target, lines));
    if (live && live.trim()) return res.json({ log: live, source: 'pane' });

    // The pane is gone — reaped as soon as the agent reported, or lost with the
    // session. This endpoint used to stop here and return '', which the hub
    // renders as "No output yet — agent starting..." — so a FINISHED agent's
    // log read as one that had never begun, and the more successfully a step
    // ran the less of it you could see. pipe-pane has been streaming to disk
    // all along, so read the tail of that instead.
    //
    // `/workflow/log` already had this fallback; this route did not, and the
    // hub calls THIS one. Any future log route needs the same treatment — the
    // pane is the live view, the file is the record.
    try {
      const file = path.join(config.logsPath, `${agent.window}-${wf.id}.log`);
      const text = fs.readFileSync(file, 'utf8');
      // renderPipePaneLog, NOT stripAnsi: this is the raw stream, where \r is
      // the line break and stripAnsi deletes it (see tmux.js).
      const tail = renderPipePaneLog(text).split('\n').slice(-lines).join('\n');
      return res.json({ log: tail, source: 'file' });
    } catch (_) {
      return res.json({ log: live || '', source: 'pane' });
    }
  });

  // Workflow message sending
  router.post('/workflow/:role/message', (req, res) => {
    const { role } = req.params;
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'message required' });
    const wf = state.loadWorkflow();
    if (!wf) return res.status(404).json({ error: 'no active workflow' });
    const step = wf.steps[wf.currentStep];
    if (!step || !step.agents) return res.status(400).json({ error: 'no agents in current step' });
    const agent = step.agents.find(a => a.role.toLowerCase() === role.toLowerCase() || a.window === role);
    if (!agent || !agent.window) return res.status(404).json({ error: `agent ${role} not found` });
    const target = `${wf.sessionName}:${agent.window}`;
    tmuxOps.sendMessage(target, message);
    res.json({ ok: true });
  });

  // Run terminal capture
  router.get('/run/:branch', (req, res) => {
    const { branch } = req.params;
    const lines = Math.min(parseInt(req.query.lines || '80', 10), 300);
    const run = state.loadRun();
    if (!run) return res.json({ log: '' });
    const worker = run.workers.find(w => w.branch === branch);
    if (!worker) return res.json({ log: '' });
    const target = `${run.sessionName}:${worker.window}`;
    res.json({ log: stripAnsi(tmuxOps.capturePane(target, lines)) });
  });

  return router;
}

module.exports = { createTerminalRouter, resolveAgentTarget };
