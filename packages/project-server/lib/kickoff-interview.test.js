'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ki = require('./kickoff-interview');

function project(cli = 'claude') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kickoff-interview-'));
  return {
    projectRoot: root, name: 'Example App',
    logsPath: path.join(root, 'tmp', '.logs'),
    cli: { default: cli, groups: {} }, step_groups: null,
  };
}

function fakeTmux({ pid = null, agentRunning = false } = {}) {
  const calls = [];
  return {
    calls,
    ensureWindow: (s, w) => { calls.push(['ensureWindow', s, w]); return `${s}:${w}`; },
    sendKeys: (t, cmd) => { calls.push(['sendKeys', t, cmd]); },
    pipePaneToLog: (t, f) => { calls.push(['pipePaneToLog', t, f]); },
    killWindowAndChildren: (t) => { calls.push(['kill', t]); },
    panePid: () => pid,
    hasLiveDescendant: () => agentRunning,
  };
}
const sent = (tmux) => tmux.calls.filter((c) => c[0] === 'sendKeys').map((c) => c[2]);

test('the opening prompt names the skill, says a human is there, and carries the marker', () => {
  const p = ki.interviewPrompt('Example App');
  assert.match(p, /`owner_interview` skill/);
  assert.match(p, /INTERACTIVE/);
  assert.ok(p.includes(ki.interviewMarker('Example App')));
  assert.match(p, /Finish interview/);
});

test('a fresh Claude interview pins a session id in its own tmux session', () => {
  const config = project('claude');
  const tmux = fakeTmux();
  const s = ki.launchInterview({ config, tmux, tmuxOps: tmux });
  assert.equal(s.cli, 'claude');
  assert.match(s.cliSessionId, /^[0-9a-f-]{36}$/);
  assert.equal(s.sessionName, 'interview-Example-App');
  assert.equal(s.window, 'interview');
  assert.equal(s.resumed, false);
  assert.deepEqual(tmux.calls[0], ['ensureWindow', 'interview-Example-App', 'interview']);
  assert.match(sent(tmux)[0], new RegExp(`--session-id '${s.cliSessionId}'`));
  const prompt = fs.readFileSync(path.join(config.projectRoot, 'prompt-interview.txt'), 'utf8');
  assert.ok(prompt.includes(ki.interviewMarker('Example App')));
});

test('Resume continues the same Claude conversation', () => {
  const config = project('claude');
  const tmux = fakeTmux();
  const prior = { cli: 'claude', cliSessionId: 'c-1', startedAt: '2026-10-02T08:00:00.000Z', sessionName: 'interview-Example-App', window: 'interview' };
  const s = ki.launchInterview({ config, tmuxOps: tmux, prior });
  assert.equal(s.resumed, true);
  assert.equal(s.cliSessionId, 'c-1');
  assert.equal(s.startedAt, prior.startedAt, 'the conversation keeps its original start');
  assert.match(sent(tmux)[0], /--resume 'c-1'/);
  assert.match(fs.readFileSync(path.join(config.projectRoot, 'prompt-interview.txt'), 'utf8'), /Continue the owner interview/);
});

test('Codex: the id is read back by the interview marker, then resumed', () => {
  const config = project('codex');
  const tmux = fakeTmux();
  const lookups = [];
  const prior = { cli: 'codex', cliSessionId: null, startedAt: '2026-10-02T08:00:00.000Z' };
  const s = ki.launchInterview({ config, tmuxOps: tmux, prior, findSessionId: (q) => { lookups.push(q); return 'cx-7'; } });
  assert.equal(lookups[0].marker, ki.interviewMarker('Example App'));
  assert.equal(s.cliSessionId, 'cx-7');
  assert.match(sent(tmux)[0], /^cd '.*' && codex 'resume' 'cx-7' /);
});

test('a CLI switch starts a fresh interview', () => {
  const config = project('codex');
  const tmux = fakeTmux();
  const prior = { cli: 'claude', cliSessionId: 'c-1', startedAt: '2026-10-02T08:00:00.000Z' };
  const s = ki.launchInterview({ config, tmuxOps: tmux, prior, findSessionId: () => { throw new Error('no lookup across CLIs'); } });
  assert.equal(s.resumed, false);
  assert.doesNotMatch(sent(tmux)[0], /c-1|resume/);
});

test('End session asks a running agent to exit and keeps the conversation', () => {
  const config = project('claude');
  const tmux = fakeTmux({ pid: 42, agentRunning: true });
  const session = { cli: 'claude', cliSessionId: 'c-1', sessionName: 'interview-Example-App', window: 'interview', startedAt: '2026-10-02T08:00:00.000Z' };
  const ended = ki.endInterview({ session, config, tmuxOps: tmux });
  assert.deepEqual(sent(tmux), ['/exit']);
  assert.equal(ended.cliSessionId, 'c-1');
  assert.ok(ended.endedAt);
});

test('End session on Codex reads the id back so Resume needs no lookup', () => {
  const config = project('codex');
  const tmux = fakeTmux({ pid: null });
  const session = { cli: 'codex', cliSessionId: null, sessionName: 's', window: 'interview', startedAt: '2026-10-02T08:00:00.000Z' };
  const ended = ki.endInterview({ session, config, tmuxOps: tmux, findSessionId: () => 'cx-8' });
  assert.equal(ended.cliSessionId, 'cx-8');
  assert.deepEqual(tmux.calls, [], 'nothing to close when the window is gone');
});

test('Finish commits only the files the interview writes, and only those that exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-paths-'));
  fs.mkdirSync(path.join(root, 'docs', 'inputs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'inputs', 'owner-interview.md'), '# x\n');
  fs.writeFileSync(path.join(root, 'docs', 'project-state.md'), '# x\n');
  assert.deepEqual(ki.interviewCommitPaths(root, 'docs'), [
    'docs/inputs/owner-interview.md', 'docs/project-state.md', 'docs/backlog',
  ]);
});

test('the onboarding prompt points at what was reconstructed, not at owner inputs', () => {
  const p = ki.interviewPrompt('Example App', 'onboarding');
  assert.match(p, /reconstructed/);
  assert.match(p, /docs\/onboarding\/survey\.md/);
  assert.doesNotMatch(p, /docs\/inputs\//);
  assert.ok(p.includes(ki.interviewMarker('Example App')), 'same marker, so read-back works in both');
  assert.match(ki.interviewPrompt('Example App'), /docs\/inputs\//, 'kickoff is the default');
});

test('an onboarding launch writes the onboarding prompt', () => {
  const config = project('claude');
  const tmux = fakeTmux();
  ki.launchInterview({ config, tmuxOps: tmux, mode: 'onboarding' });
  assert.match(fs.readFileSync(path.join(config.projectRoot, 'prompt-interview.txt'), 'utf8'), /survey\.md/);
});
