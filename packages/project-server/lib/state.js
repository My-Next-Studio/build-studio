const fs = require('fs');
const path = require('path');

function syncAgentStatus(wf, docsPath) {
  const statusFile = path.join(docsPath, 'agent-status.json');
  let existing = { agents: [] };
  try {
    if (fs.existsSync(statusFile)) {
      existing = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
    }
  } catch (_) {}

  // Build a map of currently active agents from all workflow steps
  const activeAgents = new Map();
  for (const [stepKey, step] of Object.entries(wf.steps || {})) {
    if (!step.agents) continue;
    for (const agent of step.agents) {
      if (!agent.role) continue;
      const status = step.status === 'running' && (agent.status === 'running' || agent.status === 'pending')
        ? 'working'
        : agent.status === 'done' ? 'done'
        : agent.status === 'error' ? 'error'
        : null;
      if (status) {
        activeAgents.set(agent.role, {
          status,
          lastActivity: `${wf.type}/${stepKey} (round ${wf.round || 1})`,
          lastUpdated: wf.updatedAt || new Date().toISOString(),
        });
      }
    }
  }

  // Update existing agents, preserving those not in the workflow
  const updated = (existing.agents || []).map(a => {
    const active = activeAgents.get(a.role);
    if (active) {
      activeAgents.delete(a.role);
      return { ...a, ...active };
    }
    // Reset to idle if workflow is completed or deleted
    if (wf.currentStep === 'completed' && a.status !== 'idle') {
      return { ...a, status: 'idle' };
    }
    return a;
  });

  // Add any workflow agents not already in the roster
  for (const [role, info] of activeAgents) {
    updated.push({ role, ...info });
  }

  fs.writeFileSync(statusFile, JSON.stringify({ agents: updated }, null, 2));
}

const MAX_SNAPSHOTS = 10;

function createStateManager(config, broadcast) {
  const wfFile = path.join(config.statePath, 'workflow-state.json');
  const runFile = path.join(config.statePath, 'run-state.json');
  const snapshotsDir = path.join(config.statePath, 'snapshots');

  // Track last saved currentStep in memory to detect transitions
  let _lastStep = null;
  let _onCompleted = null;

  function snapshotWorkflow(wf) {
    try {
      fs.mkdirSync(snapshotsDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = `workflow-${wf.id || 'unknown'}-step-${wf.currentStep || 'unknown'}-${ts}.json`;
      fs.writeFileSync(path.join(snapshotsDir, name), JSON.stringify(wf, null, 2));

      // Prune oldest snapshots, keep at most MAX_SNAPSHOTS
      const files = fs.readdirSync(snapshotsDir)
        .filter(f => f.endsWith('.json'))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(snapshotsDir, f)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime);
      for (const old of files.slice(0, Math.max(0, files.length - MAX_SNAPSHOTS))) {
        try { fs.unlinkSync(path.join(snapshotsDir, old.name)); } catch (_) {}
      }
    } catch (_) {}
  }

  return {
    loadWorkflow() {
      if (!fs.existsSync(wfFile)) return null;
      try {
        const wf = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
        _lastStep = wf.currentStep;
        return wf;
      } catch (_) { return null; }
    },

    registerCompletionHook(fn) {
      _onCompleted = fn;
    },

    saveWorkflow(wf) {
      // Snapshot before each step transition so any past step can be restored
      if (wf.currentStep !== _lastStep) {
        snapshotWorkflow(wf);
        if (wf.currentStep === 'completed' && _lastStep !== 'completed' && _onCompleted) {
          try { _onCompleted(wf); } catch (e) { console.error('[state] completion hook failed:', e.message); }
        }
        _lastStep = wf.currentStep;
      }
      wf.updatedAt = new Date().toISOString();
      const tmp = wfFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(wf, null, 2));
      fs.renameSync(tmp, wfFile);
      syncAgentStatus(wf, config.docsPath);
      broadcast('workflow-updated', {});
    },

    deleteWorkflow() {
      _lastStep = null;
      if (fs.existsSync(wfFile)) fs.unlinkSync(wfFile);
      broadcast('workflow-updated', {});
    },

    listSnapshots() {
      if (!fs.existsSync(snapshotsDir)) return [];
      return fs.readdirSync(snapshotsDir)
        .filter(f => f.endsWith('.json'))
        .sort()
        .reverse()
        .map(f => ({
          file: f,
          mtime: fs.statSync(path.join(snapshotsDir, f)).mtime,
        }));
    },

    restoreSnapshot(filename) {
      const snapshotPath = path.join(snapshotsDir, path.basename(filename));
      if (!fs.existsSync(snapshotPath)) throw new Error(`Snapshot not found: ${filename}`);
      const wf = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      wf.updatedAt = new Date().toISOString();
      wf._restoredFrom = filename;
      fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2));
      _lastStep = wf.currentStep;
      syncAgentStatus(wf, config.docsPath);
      broadcast('workflow-updated', {});
      return wf;
    },

    loadRun() {
      if (!fs.existsSync(runFile)) return null;
      try { return JSON.parse(fs.readFileSync(runFile, 'utf8')); } catch (_) { return null; }
    },

    saveRun(run) {
      fs.writeFileSync(runFile, JSON.stringify(run, null, 2));
      broadcast('run-state-updated', {});
    },

    deleteRun() {
      if (fs.existsSync(runFile)) fs.unlinkSync(runFile);
      broadcast('run-state-updated', {});
    },
  };
}

module.exports = { createStateManager };
