'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isShellCommand, classifyAgentProcess, decideRecovery, hasResumeArtifacts, inResumeGrace, allAgentsOf, isRevived, paneReturnedToShell } = require('./agent-recovery');

const MIN2 = 2 * 60 * 1000;

test('isShellCommand: shells, login shells, and paths match; CLIs do not', () => {
  for (const s of ['zsh', 'bash', '-zsh', '/bin/bash', 'fish', 'sh']) {
    assert.equal(isShellCommand(s), true, s);
  }
  for (const s of ['claude', 'node', 'codex', 'python3', 'xcodebuild', '', null, undefined]) {
    assert.equal(isShellCommand(s), false, String(s));
  }
});

test('classify: alive while log is fresh, regardless of pane command', () => {
  assert.equal(classifyAgentProcess({ paneCommand: 'zsh', idleMs: 10_000 }), 'alive');
  assert.equal(classifyAgentProcess({ paneCommand: null, idleMs: 10_000 }), 'alive');
});

test('classify: shell pane + confirmed silence = dead', () => {
  assert.equal(classifyAgentProcess({ paneCommand: 'zsh', idleMs: MIN2 }), 'dead');
  assert.equal(classifyAgentProcess({ paneCommand: '-zsh', idleMs: MIN2 + 1 }), 'dead');
});

test('classify: live CLI pane stays alive even when silent (interactive dialog case)', () => {
  assert.equal(classifyAgentProcess({ paneCommand: 'claude', idleMs: 20 * 60 * 1000 }), 'alive');
  assert.equal(classifyAgentProcess({ paneCommand: 'node', idleMs: 20 * 60 * 1000 }), 'alive');
});

test('classify: missing window + confirmed silence = gone', () => {
  assert.equal(classifyAgentProcess({ paneCommand: null, idleMs: MIN2 }), 'gone');
  assert.equal(classifyAgentProcess({ paneCommand: '', idleMs: MIN2 }), 'gone');
});

test('classify: shell pane + confirmed silence BUT a live child (still compiling) = alive', () => {
  // fazon FAZ-186 QA validation (2026-07-21): a long foreground
  // `xcodebuild ... | tee` left the pane idle and shell-attributed for 2+
  // minutes while the agent was alive. A live descendant process overrides
  // the shell-pane "dead" verdict.
  assert.equal(classifyAgentProcess({ paneCommand: 'zsh', idleMs: MIN2, hasLiveChild: true }), 'alive');
  assert.equal(classifyAgentProcess({ paneCommand: 'zsh', idleMs: MIN2, hasLiveChild: false }), 'dead');
});

test('decideRecovery: resume only with session id + script and attempts left', () => {
  const agent = { cliSessionId: 'u-u-i-d', resumeScript: 'start-x-resume.sh' };
  assert.equal(decideRecovery(agent), 'resume');
  assert.equal(decideRecovery({ ...agent, autoResumeCount: 1 }), 'resume');
  assert.equal(decideRecovery({ ...agent, autoResumeCount: 2 }), 'halt');
  assert.equal(decideRecovery({ resumeScript: 'x.sh' }), 'halt'); // no session id (codex)
  assert.equal(decideRecovery({ cliSessionId: 'u' }), 'halt');    // no script
  assert.equal(decideRecovery(null), 'halt');
});

test('inResumeGrace: true within window, false outside or without timestamp', () => {
  const now = Date.now();
  assert.equal(inResumeGrace({ lastAutoResumeAt: new Date(now - 60_000).toISOString() }, now), true);
  assert.equal(inResumeGrace({ lastAutoResumeAt: new Date(now - 10 * 60_000).toISOString() }, now), false);
  assert.equal(inResumeGrace({}, now), false);
  assert.equal(inResumeGrace({ lastAutoResumeAt: 'garbage' }, now), false);
});

test('hasResumeArtifacts: only claude agents (session id + script) qualify', () => {
  assert.equal(hasResumeArtifacts({ cliSessionId: 'u-u-i-d', resumeScript: 'start-x-resume.sh' }), true);
  assert.equal(hasResumeArtifacts({ resumeScript: 'x.sh' }), false);   // opencode/codex — no session id
  assert.equal(hasResumeArtifacts({ cliSessionId: 'u' }), false);      // no script
  assert.equal(hasResumeArtifacts({}), false);
  assert.equal(hasResumeArtifacts(null), false);
});

// --- allAgentsOf (2026-07-31) ------------------------------------------------
//
// The stale-session sweep in server.js reads every agent through this. It used
// to read only steps[*].agents, which silently skipped task_execution runs.

test('allAgentsOf finds agents in both homes', () => {
  const wf = {
    steps: { code_review: { agents: [{ role: 'CR' }] }, merge_to_main: {} },
    taskExecution: { taskStates: { 0: { agents: [{ role: 'iOS Dev' }] }, 1: { agents: [] } } },
  };
  assert.deepEqual(allAgentsOf(wf).map((a) => a.role), ['CR', 'iOS Dev']);
});

test('allAgentsOf finds task agents when the step mirror is empty', () => {
  // deskrhythm DR-092: the shape that made a killed session invisible.
  const wf = {
    steps: { task_execution: { status: 'running', agents: [] } },
    taskExecution: { taskStates: { 0: { agents: [{ role: 'iOS Dev', status: 'running' }] } } },
  };
  assert.equal(allAgentsOf(wf).length, 1);
});

test('allAgentsOf yields live objects, so a sweep can mark them', () => {
  const wf = { steps: {}, taskExecution: { taskStates: { 0: { agents: [{ role: 'X', status: 'running' }] } } } };
  for (const a of allAgentsOf(wf)) a.status = 'error';
  assert.equal(wf.taskExecution.taskStates[0].agents[0].status, 'error');
});

test('allAgentsOf yields both views when the mirror is populated', () => {
  // updateStepAgents mirrors a shallow COPY, so both must be marked or the two
  // views disagree about whether the agent is alive.
  const src = { role: 'X', status: 'running' };
  const wf = {
    steps: { task_execution: { agents: [{ ...src, taskIndex: 0 }] } },
    taskExecution: { taskStates: { 0: { agents: [src] } } },
  };
  const all = allAgentsOf(wf);
  assert.equal(all.length, 2);
  for (const a of all) a.status = 'error';
  assert.equal(wf.steps.task_execution.agents[0].status, 'error');
  assert.equal(wf.taskExecution.taskStates[0].agents[0].status, 'error');
});

test('allAgentsOf tolerates an empty or absent workflow', () => {
  assert.deepEqual(allAgentsOf(null), []);
  assert.deepEqual(allAgentsOf({}), []);
});

// ─── Revival: the verdict is about a process, and a human can change that ────

const MIN = 60 * 1000;

test('an agent revived from the live terminal is detected', () => {
  // The fazon fix_execution case: pane fell back to a shell, agent marked dead,
  // owner answered the blocking question in the terminal, agent carried on.
  assert.equal(isRevived({ paneCommand: 'claude', idleMs: 5 * 1000 }), true);
  assert.equal(isRevived({ paneCommand: 'node', idleMs: 30 * 1000 }), true);
});

test('a pane still sitting at a shell prompt is not revived', () => {
  assert.equal(isRevived({ paneCommand: 'zsh', idleMs: 1000 }), false);
  assert.equal(isRevived({ paneCommand: '-zsh', idleMs: 1000 }), false);
  assert.equal(isRevived({ paneCommand: 'bash', idleMs: 1000 }), false);
});

test('a real process that has gone silent is not revived', () => {
  // Both signals are required — a live-looking pane command with no output
  // could be a hung process, and revival would re-arm the stall machinery.
  assert.equal(isRevived({ paneCommand: 'claude', idleMs: 5 * MIN }), false);
});

test('a missing window cannot be revived', () => {
  assert.equal(isRevived({ paneCommand: null, idleMs: 0 }), false);
  assert.equal(isRevived({ paneCommand: '', idleMs: 0 }), false);
  assert.equal(isRevived({ paneCommand: undefined, idleMs: 0 }), false);
});

test('revival and death are exact opposites on the same inputs', () => {
  // Whatever one calls alive, the other must not call dead — otherwise the
  // watchdog oscillates, flipping the card every tick.
  for (const paneCommand of ['claude', 'codex', 'node', 'zsh', '-bash']) {
    for (const idleMs of [0, 30 * 1000, 3 * MIN, 30 * MIN]) {
      const revived = isRevived({ paneCommand, idleMs });
      const cls = classifyAgentProcess({ paneCommand, idleMs, hasLiveChild: false });
      if (revived) assert.equal(cls, 'alive', `${paneCommand}@${idleMs} revived but classified ${cls}`);
    }
  }
});

// ─── The pane command alone is not evidence of death (fazon FAZ-261) ─────────
//
// Agents launch as `bash start-<agent>.sh` without `exec`, so that wrapper is
// the foreground process-GROUP LEADER for the agent's whole life and tmux
// reports `bash` even while claude runs healthily beneath it. Any check that
// read the pane command on its own therefore misfired on live agents.

test('paneReturnedToShell: a live child means the agent has NOT exited', () => {
  // The exact shape of the FAZ-261 stall: pane says bash, claude alive beneath.
  assert.equal(paneReturnedToShell({ paneCommand: 'bash', hasLiveChild: true }), false);
  assert.equal(paneReturnedToShell({ paneCommand: '-zsh', hasLiveChild: true }), false);
});

test('paneReturnedToShell: a shell with nothing under it is a real exit', () => {
  assert.equal(paneReturnedToShell({ paneCommand: 'bash', hasLiveChild: false }), true);
  assert.equal(paneReturnedToShell({ paneCommand: '-zsh', hasLiveChild: false }), true);
});

test('paneReturnedToShell: a non-shell pane is never an exit', () => {
  for (const cmd of ['claude', 'node', 'codex', 'xcodebuild']) {
    assert.equal(paneReturnedToShell({ paneCommand: cmd, hasLiveChild: false }), false, cmd);
  }
});

test('an agent waiting at a prompt is not reported as exited', () => {
  // What the owner saw: "Process exited ... pane is back at a shell prompt"
  // for a claude process that had been up for 50 minutes holding uncommitted
  // work, because only the pane command was consulted.
  assert.equal(isShellCommand('bash'), true, 'the weaker signal still says shell');
  assert.equal(
    paneReturnedToShell({ paneCommand: 'bash', hasLiveChild: true }), false,
    'the signal the callers use must disagree',
  );
});

test('revival now works for the case its own docs describe', () => {
  // isRevived rejected every shell pane, which is every claude agent always —
  // so "owner answers the prompt, agent resumes" could never clear the error.
  assert.equal(isRevived({ paneCommand: 'bash', idleMs: 1000, hasLiveChild: true }), true);
  // Still requires fresh output: a live but silent process is not revived.
  assert.equal(isRevived({ paneCommand: 'bash', idleMs: 5 * MIN, hasLiveChild: true }), false);
  // And a shell with nothing under it stays dead.
  assert.equal(isRevived({ paneCommand: 'bash', idleMs: 1000, hasLiveChild: false }), false);
});

test('classify: unchanged — a live child still outranks a shell pane', () => {
  assert.equal(classifyAgentProcess({ paneCommand: 'bash', idleMs: MIN2, hasLiveChild: true }), 'alive');
  assert.equal(classifyAgentProcess({ paneCommand: 'bash', idleMs: MIN2, hasLiveChild: false }), 'dead');
});

// ─── A lost tmux session (fazon FAZ-460, 2026-10-25: a power cut mid-run) ─────

const { planLostSessionRecovery } = require('./agent-recovery');

const claudeAgent = (over = {}) => ({
  role: 'iOS Dev', status: 'running', window: 't1-ios-dev', agentCwd: '/p',
  cliSessionId: 'u-u-i-d', resumeScript: 'start-t1-ios-dev-resume.sh', ...over,
});

test('lost session: a claude agent is resumed into its own window and directory', () => {
  const wf = { steps: {}, taskExecution: { taskStates: { 0: { agents: [claudeAgent()] } } } };
  const [p] = planLostSessionRecovery(wf);
  assert.equal(p.action, 'resume');
  assert.equal(p.window, 't1-ios-dev');
  assert.equal(p.cwd, '/p');
  assert.equal(p.resumeScript, 'start-t1-ios-dev-resume.sh');
});

test('lost session: a task agent and its step mirror are resumed once, and both are marked', () => {
  const src = claudeAgent();
  const wf = {
    steps: { task_execution: { agents: [{ ...src, taskIndex: 0 }] } },
    taskExecution: { taskStates: { 0: { agents: [src] } } },
  };
  const plan = planLostSessionRecovery(wf);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].agents.length, 2);
});

test('lost session: agents with no way to resume halt', () => {
  const wf = {
    steps: {
      a: { agents: [claudeAgent({ window: 'a', cliSessionId: undefined })] },                  // codex
      b: { agents: [claudeAgent({ window: 'b', autoResumeCount: 2 })] },                       // cap reached
      c: { agents: [claudeAgent({ window: 'c', agentCwd: '/gone' })] },                        // worktree removed
      d: { agents: [claudeAgent({ window: 'd', agentCwd: undefined })] },
    },
  };
  const plan = planLostSessionRecovery(wf, { cwdExists: dir => dir !== '/gone' });
  assert.deepEqual(plan.map(p => [p.window, p.action]), [['a', 'halt'], ['b', 'halt'], ['c', 'halt'], ['d', 'halt']]);
});

test('lost session: only running agents are touched', () => {
  const wf = { steps: { s: { agents: [claudeAgent({ status: 'done' }), claudeAgent({ status: 'error', window: 'x' })] } } };
  assert.deepEqual(planLostSessionRecovery(wf), []);
  assert.deepEqual(planLostSessionRecovery(null), []);
});
