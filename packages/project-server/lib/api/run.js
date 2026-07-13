const express = require('express');
const fs = require('fs');
const path = require('path');

function createRunRouter(config, state, gitOps, tmuxOps, broadcast, parseExecutionPlan) {
  const router = express.Router();
  const { projectRoot, worktreesPath, logsPath } = config;

  router.get('/run', (req, res) => res.json({ run: state.loadRun() }));

  router.get('/run/commits', (req, res) => {
    const run = state.loadRun();
    if (!run) return res.json({ commits: {} });
    const commits = {};
    for (const worker of run.workers || []) {
      const count = gitOps.commitsAhead(worker.branch);
      const last = count > 0 ? gitOps.lastCommit(worker.branch) : '';
      commits[worker.branch] = { count, last };
    }
    res.json({ commits });
  });

  router.post('/run/merge/:branch', (req, res) => {
    const { branch } = req.params;
    const run = state.loadRun();
    if (!run) return res.status(404).json({ error: 'no active run' });
    const worker = run.workers.find(w => w.branch === branch);
    if (!worker) return res.status(404).json({ error: `worker ${branch} not found` });

    try {
      const count = gitOps.commitsAhead(branch);
      if (count === 0) return res.json({ status: 'empty', message: 'No commits to merge' });
      const msg = `Merge ${branch}: ${worker.role}`;
      gitOps.mergeBranch(branch, projectRoot, msg);
      worker.merged = true;
      state.saveRun(run);

      // Cleanup worktree
      gitOps.removeWorktree(branch);
      broadcast('worktrees-updated', {});
      res.json({ status: 'merged', message: msg });
    } catch (e) {
      gitOps.abortMerge(projectRoot);
      res.status(500).json({ status: 'conflict', error: e.message });
    }
  });

  router.post('/run/cancel', (req, res) => {
    const run = state.loadRun();
    if (!run) return res.status(404).json({ error: 'no active run' });

    // Kill tmux session
    if (run.sessionName) tmuxOps.killSession(run.sessionName);

    // Remove worktrees
    for (const worker of run.workers || []) {
      if (worker.branch && !worker.merged) {
        gitOps.removeWorktree(worker.branch);
      }
    }

    state.deleteRun();
    broadcast('worktrees-updated', {});
    res.json({ ok: true });
  });

  router.post('/run/open', (req, res) => {
    const run = state.loadRun();
    if (!run) return res.status(404).json({ error: 'no active run' });
    tmuxOps.openTerminal(run.sessionName);
    res.json({ ok: true });
  });

  router.get('/worktrees', (req, res) => res.json({ worktrees: gitOps.listWorktrees() }));

  router.post('/launch', (req, res) => {
    const activeWorkflow = state.loadWorkflow();
    if (activeWorkflow && activeWorkflow.currentStep !== 'completed') {
      return res.status(409).json({ error: 'A workflow is active — cancel it before using the Execution tab' });
    }

    const { tasks, allowAll = true } = req.body;
    if (!tasks || !Array.isArray(tasks))
      return res.status(400).json({ error: 'tasks array required' });

    fs.mkdirSync(worktreesPath, { recursive: true });
    fs.mkdirSync(logsPath, { recursive: true });

    const sessionName = tmuxOps.generateSessionName();
    const workers = [];
    let sessionCreated = false;
    const skipPerms = config.agent_defaults.skip_permissions;
    const unsetKey = config.agent_defaults.unset_api_key;

    for (const task of tasks) {
      const branch = String(task.branch || '').replace(/[^a-zA-Z0-9\-_]/g, '-').slice(0, 60);
      if (!branch) { workers.push({ branch: '?', role: task.role, error: 'invalid branch name', status: 'error' }); continue; }

      let wtPath;
      try {
        wtPath = gitOps.createWorktree(branch);
      } catch (e) {
        workers.push({ branch, role: task.role, error: `Worktree: ${e.message}`, status: 'error' });
        continue;
      }

      const skill = task.skill || task.role.toLowerCase().replace(/[\s/]/g, '_');

      // Write TASK.md
      fs.writeFileSync(path.join(wtPath, 'TASK.md'),
        [`# Task: ${task.role}`, '', task.instruction, '', '---', `Skill: /${skill}`].join('\n'));

      // Write startup script
      const dangerFlag = (allowAll && skipPerms) ? ' --dangerously-skip-permissions' : '';
      const taskModel = task.model || config.agent_defaults.model || 'opus';
      const MODEL_IDS = { opus: 'claude-opus-4-6', sonnet: 'claude-sonnet-4-6' };
      const modelFlag = ` --model ${MODEL_IDS[taskModel] || taskModel}`;
      const initialPrompt = `Read TASK.md and execute the task using /${skill}. When you are done, commit your output files with git (git add docs/ src/ && git commit -m "feat: <short description>"). Do NOT add or commit TASK.md or start.sh. Do not skip the commit.`;
      const startScript = `#!/bin/bash\neval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null\nclaude${dangerFlag}${modelFlag} "${initialPrompt.replace(/"/g, '\\"')}"\n`;
      fs.writeFileSync(path.join(wtPath, 'start.sh'), startScript, { mode: 0o755 });

      const windowName = branch.replace(/^agent-/, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 15);
      const logFile = path.join(logsPath, `${branch}.log`);
      const target = `${sessionName}:${windowName}`;
      const keyUnset = unsetKey ? 'unset ANTHROPIC_API_KEY && ' : '';

      try {
        if (!sessionCreated) {
          tmuxOps.createSession(sessionName, windowName, projectRoot);
          sessionCreated = true;
        } else {
          tmuxOps.createWindow(sessionName, windowName, projectRoot);
        }
        tmuxOps.sendKeys(target, `cd '${wtPath}' && ${keyUnset}bash start.sh`, projectRoot);
        tmuxOps.pipePaneToLog(target, logFile, projectRoot);
      } catch (e) {
        workers.push({ branch, role: task.role, error: `tmux: ${e.message}`, status: 'error' });
        continue;
      }

      workers.push({ branch, role: task.role, skill, window: windowName, logFile, status: 'running', startedAt: new Date().toISOString() });
    }

    const plan = parseExecutionPlan();
    const titleLine = (plan.content || '').split('\n').find(l => l.startsWith('#')) || '';
    const run = {
      id: new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19),
      sessionName,
      title: titleLine.replace(/^#+\s*/, '') || 'Agent Run',
      state: 'executing',
      allowAll,
      startedAt: new Date().toISOString(),
      workers,
    };
    state.saveRun(run);

    if (sessionCreated) tmuxOps.openTerminal(sessionName);

    broadcast('worktrees-updated', {});
    res.json({ results: workers, sessionName, runId: run.id });
  });

  return router;
}

module.exports = { createRunRouter };
