'use strict';

/**
 * The tmux sessions a project owns outside its workflow session, and closing
 * them when the project is removed.
 *
 * Drafting and the owner interview run in their own tmux sessions on purpose
 * (so reaping a finished run cannot take a conversation with it). The flip
 * side: removing a project stopped its server but left those sessions, and
 * their agents, running. Found after removing two test projects (2026-10-03).
 *
 * Names come from the same functions that create the sessions, so the two
 * cannot drift apart.
 */

const { execFileSync } = require('child_process');
const { draftSessionName } = require('./drafting');
const { interviewSessionName } = require('./kickoff-interview');

function projectSessionNames(projectName) {
  return [draftSessionName(projectName), interviewSessionName(projectName)];
}

/**
 * Close the project's drafting and interview sessions. Best effort: a session
 * that does not exist is the normal case.
 *
 * `=name` is tmux's EXACT match. A plain `-t name` falls back to a prefix
 * match, so removing "hello-world" would have closed "draft-hello-world-kickoff".
 *
 * @returns {string[]} the sessions actually closed
 */
function closeProjectSessions(projectName, { exec = execFileSync } = {}) {
  const closed = [];
  for (const s of projectSessionNames(projectName)) {
    try {
      exec('tmux', ['kill-session', '-t', `=${s}`], { stdio: 'ignore' });
      closed.push(s);
    } catch (_) { /* not running: nothing to close */ }
  }
  return closed;
}

module.exports = { projectSessionNames, closeProjectSessions };
