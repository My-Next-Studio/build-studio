'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const { projectSessionNames, closeProjectSessions } = require('./project-sessions');
const { draftSessionName } = require('./drafting');
const { interviewSessionName } = require('./kickoff-interview');

test('the names are the ones drafting and the interview create', () => {
  assert.deepEqual(projectSessionNames('My App'), [draftSessionName('My App'), interviewSessionName('My App')]);
});

test('closing targets each session by EXACT name', () => {
  const calls = [];
  const exec = (bin, args) => { calls.push([bin, ...args]); if (args[2].startsWith('=interview')) throw new Error('no session'); };
  const closed = closeProjectSessions('hello-world', { exec });
  assert.deepEqual(calls, [
    ['tmux', 'kill-session', '-t', '=draft-hello-world'],
    ['tmux', 'kill-session', '-t', '=interview-hello-world'],
  ]);
  assert.deepEqual(closed, ['draft-hello-world'], 'a missing session is not reported as closed');
});

// Against real tmux, when it is installed: removing "hello-world" must not
// close "draft-hello-world-kickoff". A plain -t prefix-matches; =name does not.
test('removing a project never closes a longer-named project\'s session', (t) => {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); } catch (_) { t.skip('tmux not installed'); return; }
  const other = `draft-bs-test-${process.pid}-kickoff`;
  execFileSync('tmux', ['new-session', '-d', '-s', other, 'sleep 60']);
  try {
    closeProjectSessions(`bs-test-${process.pid}`);
    execFileSync('tmux', ['has-session', '-t', `=${other}`]); // throws if it was closed
  } finally {
    try { execFileSync('tmux', ['kill-session', '-t', `=${other}`], { stdio: 'ignore' }); } catch (_) {}
  }
});
