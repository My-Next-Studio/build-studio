'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isShellCommand, classifyAgentProcess, decideRecovery, hasResumeArtifacts, inResumeGrace } = require('./agent-recovery');

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
