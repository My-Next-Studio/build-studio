'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyStalledAgent, isAwaitingInput, extractQuestion } = require('./agent-stalled');

// Real pane tails, trimmed. The discriminator is what the pane ENDS with.
const WORKING = '✻ Whirlpooling… (1m 6s · ↓ 4.0k tokens)\n⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt · ← for agents';
const WAITING = '### Action Items\n- [ ] (none)\n❯\n⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';
const EXPIRED = '⏺ Login expired · Please run /login\n✻ Cogitated for 41s\n❯\n⏵⏵ bypass permissions on';
const LONG = 10 * 60 * 1000;

test('a working agent is never flagged, however long it has run', () => {
  assert.equal(classifyStalledAgent({ paneText: WORKING, idleMs: LONG, hasFeedback: false }), null);
});

test('an agent that already reported is never flagged', () => {
  assert.equal(classifyStalledAgent({ paneText: WAITING, idleMs: LONG, hasFeedback: true }), null);
});

test('auth expiry is caught, and does not wait out the confirmation window', () => {
  // The message is terminal — waiting two minutes to say so helps nobody, and
  // this one blocked three agents for 39 minutes with nothing surfacing it.
  const r = classifyStalledAgent({ paneText: EXPIRED, idleMs: 0, hasFeedback: false });
  assert.equal(r.reason, 'auth_blocked');
  assert.match(r.action, /\/login/);
  assert.match(r.detail, /every other agent in this step is likely blocked/);
});

test('the other auth and quota shapes are covered', () => {
  for (const t of ['Invalid API key · Please run /login', 'Your credit balance is too low', 'usage limit reached', 'session limit reached · resets 3pm']) {
    const r = classifyStalledAgent({ paneText: `${t}\n❯`, idleMs: 0, hasFeedback: false });
    assert.equal(r && r.reason, 'auth_blocked', t);
  }
});

test('finished-but-not-reported needs the recoverable report to claim it', () => {
  const r = classifyStalledAgent({ paneText: WAITING, idleMs: LONG, hasFeedback: false, hasRecoverableReport: true });
  assert.equal(r.reason, 'finished_not_reported');
  assert.match(r.action, /Recover/);
});

test('a bare prompt with nothing recoverable is reported as the weaker case', () => {
  const r = classifyStalledAgent({ paneText: WAITING, idleMs: LONG, hasFeedback: false });
  assert.equal(r.reason, 'agent_waiting');
  // Must not imply a diagnosis it does not have, or offer an action that would
  // silently discard work.
  assert.doesNotMatch(r.action, /Recover/);
});

test('a brief pause between tool calls is not a stall', () => {
  assert.equal(classifyStalledAgent({ paneText: WAITING, idleMs: 5000, hasFeedback: false }), null);
});

test('an unreadable pane proves nothing and is never flagged', () => {
  for (const t of ['', '   ', null, undefined]) {
    assert.equal(classifyStalledAgent({ paneText: t, idleMs: LONG, hasFeedback: false }), null);
  }
});

test('isAwaitingInput keys off positive evidence of working', () => {
  assert.equal(isAwaitingInput(WORKING), false);
  assert.equal(isAwaitingInput(WAITING), true);
  assert.equal(isAwaitingInput(''), false);   // no evidence either way
});

// ─── A selection dialog is waiting, not working (fazon FAZ-261, 2026-08-18) ──
//
// The CLI's question prompt draws a footer containing "Esc to cancel", which
// WORKING_MARKERS matches — so the single most common way an agent blocks on a
// human read as proof it was busy, and nothing surfaced it.

const QUESTION_MENU = [
  ' ☐ FAZ-261 scope',
  'Widening the field turns two currently-green gates red. How should I proceed?',
  '❯ 1. Full fix incl. version bump (Recommended)',
  '  2. Land gates only, schema fix deferred',
  '  5. Type something.',
  '  6. Chat about this',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

const DIALOG_WORKING_PANE = [
  '⏺ Running cd /Volumes/Extern/projects/fazon; git status --short',
  '✢ Moseying… (27m 24s · ↓ 50.7k tokens)',
  '❯ ',
  '  ⏵⏵ bypass permissions on · 1 shell · esc to interrupt · ← for agents · ↓ to manage',
].join('\n');

test('a question dialog is recognised as waiting despite its "Esc to cancel"', () => {
  assert.equal(isAwaitingInput(QUESTION_MENU), true);
  const v = classifyStalledAgent({ paneText: QUESTION_MENU, idleMs: 20 * 60 * 1000, hasFeedback: false });
  assert.equal(v && v.reason, 'awaiting_decision');
});

// A long-running agent has almost always left something report-shaped in its
// transcript by the time it asks a question, so these two signals arrive
// TOGETHER — and the dialog is the true one. Reporting "finished but never
// reported" here offered Recover (posts a partial report as the step result)
// and relaunch (discards the context and any uncommitted work) for an agent
// that was neither finished nor safe to restart.
test('a dialog outranks a recoverable report — both signals fire at once', () => {
  const v = classifyStalledAgent({
    paneText: QUESTION_MENU, idleMs: 20 * 60 * 1000, hasFeedback: false, hasRecoverableReport: true,
  });
  assert.equal(v.reason, 'awaiting_decision');
  assert.doesNotMatch(v.action, /^Use Recover/);
  assert.match(v.action, /answer it/i);
});

test('the awaiting-decision action warns off both destructive moves', () => {
  const v = classifyStalledAgent({
    paneText: QUESTION_MENU, idleMs: 20 * 60 * 1000, hasFeedback: false, hasRecoverableReport: true,
  });
  // Named explicitly: the dashboard offers both buttons right next to this text.
  assert.match(v.action, /relaunch/i);
  assert.match(v.action, /uncommitted work/i);
  // And must not repeat the claim that misled: it did NOT produce a report.
  assert.doesNotMatch(v.detail, /produced a complete report/i);
  assert.match(v.detail, /intact/i);
});

test('a bare prompt with a recoverable report is still finished_not_reported', () => {
  // The fix must not swallow the case it sits in front of: no dialog markers,
  // report in hand — that really is an agent that forgot to POST.
  const v = classifyStalledAgent({
    paneText: WAITING, idleMs: LONG, hasFeedback: false, hasRecoverableReport: true,
  });
  assert.equal(v.reason, 'finished_not_reported');
});

test('a genuinely working agent is still not flagged', () => {
  // Captured from a live agent mid-run. The false-positive direction matters:
  // this fires on every tick, and crying wolf trains the owner to ignore it.
  assert.equal(isAwaitingInput(DIALOG_WORKING_PANE), false);
  assert.equal(classifyStalledAgent({ paneText: DIALOG_WORKING_PANE, idleMs: 20 * 60 * 1000, hasFeedback: false }), null);
});

test('an agent that already reported is never flagged, dialog or not', () => {
  assert.equal(classifyStalledAgent({ paneText: QUESTION_MENU, idleMs: 20 * 60 * 1000, hasFeedback: true }), null);
});

// ─── The card says WHAT is being asked (launch-studio LS-167, 2026-09-30) ────
// "An agent is waiting for your decision" was computed but read as a failure,
// and nothing showed the question — the owner had to find the terminal to
// learn it was a dependency question with three options.

const DEPENDENCY_QUESTION = [
  '⏺ Checking the dependency before building.',
  '────────────────────────────────────────────────────────────',
  ' ☐ Dependency',
  '',
  'LS-167 (PRD-083) depends on LS-179 (PRD-082), which is Reviewed but not built. How should I proceed?',
  '',
  '❯ 1. Stop, report blocked (Recommended)',
  '  2. Build 082 + 083 here',
  '  3. Minimal 082 subset',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');

test('the awaiting_decision verdict carries the question and its options', () => {
  const v = classifyStalledAgent({ paneText: DEPENDENCY_QUESTION, idleMs: LONG, hasFeedback: false });
  assert.equal(v.reason, 'awaiting_decision');
  assert.match(v.question, /^Dependency\n/);
  assert.match(v.question, /depends on LS-179/);
  assert.match(v.question, /3\. Minimal 082 subset$/);
  assert.doesNotMatch(v.question, /Checking the dependency|Enter to select|────/);
});

test('no dialog, no question', () => {
  assert.equal(extractQuestion(WORKING), null);
  assert.equal(extractQuestion(''), null);
});

// ── non-interactive CLIs (codex exec, opencode run) ─────────────────────────
// launch-studio LS-187, 2026-10-05: a codex curator sent a tool result at 06:43
// and got nothing back. The pane never shows Claude's "esc to interrupt", so it
// was reported as "sitting at an input prompt… answer it in the live terminal".

{
  const { classifyStalledAgent, MODEL_STALL_MS } = require('./agent-stalled');
  const NOW = Date.parse('2026-10-05T06:53:00Z');
  const CODEX_PANE = 'docs/learnings/qa/a.md\ndocs/learnings/qa/b.md\n'; // plain output, no working marker
  const MIN = 60 * 1000;

  test('a quiet codex agent is not "at an input prompt"', () => {
    const r = classifyStalledAgent({ paneText: CODEX_PANE, idleMs: 3 * MIN, hasFeedback: false, cli: 'codex', now: NOW });
    assert.equal(r, null, 'three quiet minutes is a long model turn, not a stall');
  });

  test('a codex agent whose rollout has not moved reads as waiting on the model', () => {
    const r = classifyStalledAgent({
      paneText: CODEX_PANE, idleMs: 12 * MIN, hasFeedback: false, cli: 'codex',
      modelLastActivityMs: NOW - 12 * MIN, now: NOW,
    });
    assert.equal(r.reason, 'model_stalled');
    assert.match(r.detail, /12 min/);
    assert.match(r.detail, /nothing to answer in its terminal/);
    assert.doesNotMatch(r.action, /answer it in the live terminal/i);
    assert.match(r.action, /relaunch/i);
  });

  test('the rollout beats the pane log: a streaming codex agent is fine though its log is old', () => {
    const r = classifyStalledAgent({
      paneText: CODEX_PANE, idleMs: 15 * MIN, hasFeedback: false, cli: 'codex',
      modelLastActivityMs: NOW - 2 * MIN, now: NOW,
    });
    assert.equal(r, null);
  });

  test('without a rollout, long silence is reported as silence, not as a prompt', () => {
    const r = classifyStalledAgent({ paneText: CODEX_PANE, idleMs: MODEL_STALL_MS + MIN, hasFeedback: false, cli: 'opencode', now: NOW });
    assert.equal(r.reason, 'agent_silent');
    assert.match(r.detail, /not waiting for input/);
  });

  test('credential failures are still caught on non-interactive CLIs', () => {
    const r = classifyStalledAgent({ paneText: 'error: Invalid API key', idleMs: 1000, hasFeedback: false, cli: 'codex', now: NOW });
    assert.equal(r.reason, 'auth_blocked');
  });

  test('Claude agents keep the prompt reading', () => {
    const r = classifyStalledAgent({ paneText: '❯ \n⏵⏵ bypass permissions (shift+tab to cycle)', idleMs: 3 * MIN, hasFeedback: false, cli: 'claude', now: NOW });
    assert.equal(r.reason, 'agent_waiting');
  });
}

{
  const { hasBackgroundWork } = require('./agent-stalled');
  // fazon FAZ-376, 2026-10-05: a dev agent between turns, its full test suite
  // running in two background shells.
  const WAITING_ON_SHELLS = [
    '✻ Worked for 10m 6s · done 8:00 AM · 2 shells still running',
    '◎ /goal active (1h)',
    '❯ wait for the full test run',
    '⏵⏵ bypass permissions on · 2 shells · ← for agents',
  ].join('\n');

  test('background shells and goal mode count as pending work', () => {
    assert.ok(hasBackgroundWork(WAITING_ON_SHELLS));
    assert.ok(hasBackgroundWork('✻ Worked for 3m · 1 shell still running'));
    assert.ok(hasBackgroundWork('⏵⏵ bypass permissions on · 1 shell · ← for agents'));
    assert.ok(hasBackgroundWork('◎ /goal active (20m)'));
    assert.equal(hasBackgroundWork('✻ Worked for 10m 6s\n❯ \n⏵⏵ bypass permissions on'), false);
  });

  test('an agent waiting on background shells is not stalled, even with a transcript text', () => {
    const r = classifyStalledAgent({
      paneText: WAITING_ON_SHELLS, idleMs: 30 * 60 * 1000, hasFeedback: false,
      hasRecoverableReport: true, cli: 'claude',
    });
    assert.equal(r, null);
  });

  test('a dialog still wins over background work', () => {
    const r = classifyStalledAgent({
      paneText: WAITING_ON_SHELLS + '\nDo you want to proceed?\n❯ 1. Yes\n  2. No\nEnter to select · ↑/↓ to navigate · Esc to cancel',
      idleMs: 30 * 60 * 1000, hasFeedback: false, cli: 'claude',
    });
    assert.equal(r && r.reason, 'awaiting_decision', 'a question asked mid-shell is still flagged');
  });
}
