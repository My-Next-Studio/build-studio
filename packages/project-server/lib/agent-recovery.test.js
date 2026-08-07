'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isShellCommand, classifyAgentProcess, decideRecovery, hasResumeArtifacts, inResumeGrace, allAgentsOf, isRevived } = require('./agent-recovery');

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
