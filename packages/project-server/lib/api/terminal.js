const express = require('express');
const { stripAnsi } = require('../tmux');

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
    res.json({ log: stripAnsi(tmuxOps.capturePane(target, lines)) });
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

module.exports = { createTerminalRouter };
