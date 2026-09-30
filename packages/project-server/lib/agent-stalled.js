'use strict';

/**
 * "This agent is alive and will never make progress."
 *
 * `agent-recovery.js` answers a different question — is the PROCESS alive? — and
 * answers it correctly. Its core assumption is even documented there: *a live
 * Claude repaints its UI constantly, so a live agent's log never goes silent*.
 * That is true, and it is exactly why a permanently blocked agent is invisible:
 * it is alive, it is repainting, and the idle-stall timer never fires.
 *
 * Liveness and progress are different axes. Three real failures in one day, all
 * of which left the process healthy and nothing surfaced any of them:
 *
 *  - **Auth expiry mid-run.** Three reviewers hit `Login expired · Please run
 *    /login` and sat at the prompt for 39 minutes while the three that had
 *    already reported looked fine.
 *  - **Finished but never reported.** An agent wrote a complete review, then
 *    stopped without running its feedback POST. `workflow/feedback` appeared in
 *    its log exactly once — in the prompt, never executed. Twice in five days.
 *  - **Waiting at a prompt** with nothing recoverable behind it.
 *
 * The discriminator is what the pane ENDS with. A working agent shows a spinner
 * and an interrupt hint; a blocked one shows a bare prompt:
 *
 *     ✻ Whirlpooling… (1m 6s · ↓ 4.0k tokens)     <- working
 *     ⏵⏵ bypass permissions … · esc to interrupt
 *
 *     ❯                                            <- waiting, forever
 *     ⏵⏵ bypass permissions (shift+tab to cycle)
 *
 * Everything here is advisory. A false positive costs a glance; a false halt
 * costs a run — the same call the owner already made for human gates.
 */

/**
 * Auth and quota failures, which the agent cannot resolve and which typically
 * hit every running agent at once. Matched against pane text, so the strings
 * are what the CLI actually prints.
 */
const AUTH_PATTERNS = [
  { re: /Login expired/i, why: 'the CLI login expired', fix: 'Run `/login` in a terminal, then relaunch the step.' },
  { re: /Please run \/login/i, why: 'the CLI is asking for login', fix: 'Run `/login` in a terminal, then relaunch the step.' },
  { re: /Invalid API key/i, why: 'the API key was rejected', fix: 'Fix the credential, then relaunch the step.' },
  { re: /credit balance is too low/i, why: 'the account is out of credit', fix: 'Top up the account, then relaunch the step.' },
  { re: /(usage|rate) limit (reached|exceeded)/i, why: 'a usage limit was reached', fix: 'Wait for the limit to reset, then relaunch the step.' },
  { re: /session limit .*(reached|exceeded)/i, why: 'the session limit was reached', fix: 'Wait for the session limit to reset, then relaunch the step.' },
];

/** The CLI only prints this while it is actually working on something. */
const WORKING_MARKERS = [
  /esc to interrupt/i,
  /\besc\b to cancel/i,
];

/**
 * Positive evidence that the pane is at a DIALOG, checked before the working
 * markers and overriding them.
 *
 * The absence-of-working-marker rule below is right in general but has one
 * systematic blind spot: a selection dialog draws its own footer, and that
 * footer says "Esc to cancel" — which `WORKING_MARKERS` matches. So the single
 * most common way an agent blocks on a human, the CLI's own question prompt,
 * was read as proof it was busy.
 *
 * That is exactly what happened on fazon FAZ-261 (2026-08-18): a dev agent hit
 * a genuine design fork, drew a six-option menu, and waited. Nothing surfaced
 * it — the idle timeout eventually fired and reported the process as EXITED,
 * while it sat holding 50 minutes of context and uncommitted work.
 *
 * These markers are the dialog's navigation affordances, which no working
 * spinner prints.
 */
const WAITING_MARKERS = [
  /enter to select/i,
  /↑\/↓ to navigate/i,
  /\bto navigate\b.*\bto cancel\b/i,
];

/**
 * Is the pane sitting at an input prompt rather than working?
 *
 * Deliberately positive-evidence-based: we look for the WORKING marker and
 * treat its absence as waiting, rather than trying to enumerate every shape a
 * prompt can take. A pane we cannot read at all is not evidence of anything.
 */
function isAwaitingInput(paneText) {
  const t = String(paneText || '');
  if (!t.trim()) return false;
  // A dialog's own footer beats the working markers it happens to contain.
  if (WAITING_MARKERS.some((re) => re.test(t))) return true;
  return !WORKING_MARKERS.some((re) => re.test(t));
}

/**
 * Classify a RUNNING agent that the process check already called alive.
 *
 * @param {object} p
 * @param {string} p.paneText        recent pane capture
 * @param {number} p.idleMs          ms since the agent's log last changed
 * @param {boolean} p.hasFeedback    has it reported?
 * @param {boolean} [p.hasRecoverableReport]  does a transcript/commit report exist?
 * @param {number} [p.waitConfirmMs] how long a bare prompt must persist
 * @returns {{reason,title,detail,action}|null}
 */
/**
 * The question an agent is holding at, as the pane shows it: the dialog's
 * heading and options, up to the navigation footer. So the card can show what
 * is being asked, not just that something is (launch-studio LS-167,
 * 2026-09-30: an agent waited ten hours on a dependency question nobody saw).
 */
function extractQuestion(paneText) {
  const lines = String(paneText || '').split('\n').map((l) => l.replace(/\s+$/, ''));
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (WAITING_MARKERS.some((re) => re.test(lines[i]))) { end = i; break; }
  }
  if (end < 0) return null;
  // The dialog starts at the last rule line (────) or checkbox heading (☐)
  // above the footer; fall back to the previous 16 lines.
  let start = Math.max(0, end - 16);
  for (let i = end - 1; i >= Math.max(0, end - 40); i--) {
    if (/^\s*[☐☒]/.test(lines[i]) || /^\s*[─━]{8,}/.test(lines[i])) { start = i; if (/[☐☒]/.test(lines[i])) break; }
  }
  const body = lines.slice(start, end)
    .filter((l) => !/^\s*[─━]{8,}\s*$/.test(l))
    .map((l) => l.replace(/^\s*[│|]\s?/, '').replace(/^\s*[☐☒]\s*/, ''))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return body ? body.slice(0, 2000) : null;
}

function classifyStalledAgent({
  paneText, idleMs, hasFeedback, hasRecoverableReport = false, waitConfirmMs = 2 * 60 * 1000,
}) {
  if (hasFeedback) return null;               // it reported; nothing to see
  const text = String(paneText || '');
  if (!text.trim()) return null;              // unreadable pane proves nothing

  // 1. Auth/quota — highest confidence, and independent of timing: the message
  //    is terminal, so there is no point waiting out a confirmation window.
  for (const { re, why, fix } of AUTH_PATTERNS) {
    if (re.test(text)) {
      return {
        reason: 'auth_blocked',
        title: 'An agent is blocked on credentials',
        detail: `The CLI reported that ${why}. The agent is still running but cannot proceed, and every other agent in this step is likely blocked the same way.`,
        action: fix,
      };
    }
  }

  // Below here the signal is "sitting at a prompt", which needs to persist —
  // a pause between tool calls is not a stall.
  if (!isAwaitingInput(text)) return null;
  if (!Number.isFinite(idleMs) || idleMs < waitConfirmMs) return null;

  // 2. At a DIALOG, asking a question. This is positive evidence — the CLI's
  //    own navigation footer — and it outranks the recoverable-report heuristic
  //    below, which is only an inference.
  //
  //    Order matters here, and getting it wrong is expensive. An agent drawing
  //    a numbered menu has NOT finished: it is holding its context open waiting
  //    for a person, usually with uncommitted work in its worktree. But a long
  //    run has almost always left something report-shaped in its transcript by
  //    then, so `hasRecoverableReport` is true and the next branch claimed the
  //    agent had "finished but never reported" — offering two actions that both
  //    destroy what it is waiting to be told. Recover posts a partial answer as
  //    the step's result; relaunch throws away the context and the uncommitted
  //    work. The actual fix is one keystroke in the pane (2026-08-23: a QA agent
  //    blocked on a pre-commit hook question, reported as finished, ~50 minutes
  //    of work one Recover click away from being silently discarded).
  if (WAITING_MARKERS.some((re) => re.test(text))) {
    const question = extractQuestion(text);
    return {
      reason: 'awaiting_decision',
      ...(question ? { question } : {}),
      title: 'An agent is waiting for your decision',
      detail: 'The agent asked a question and is holding at its own prompt. It has not finished — its context and any uncommitted work are intact, and it will wait indefinitely.',
      action: 'Open that agent\'s terminal and answer it. Do NOT recover or relaunch — recovering posts a partial report as the step result, and relaunching discards its context and any uncommitted work.',
    };
  }

  // 3. Finished but never reported. The strong clause is the recoverable
  //    report: the agent's own words already exist, it simply never sent them.
  if (hasRecoverableReport) {
    return {
      reason: 'finished_not_reported',
      title: 'An agent finished but never reported',
      detail: 'The agent produced a complete report and stopped without posting it, so the step will wait indefinitely. Its own output is still recoverable.',
      action: 'Use Recover on that agent to deliver its report, or relaunch the step.',
    };
  }

  // 4. Waiting, with nothing behind it and no dialog on screen. Weakest signal —
  //    say so rather than implying a diagnosis, and offer no automatic action.
  return {
    reason: 'agent_waiting',
    title: 'An agent is waiting and will not proceed',
    detail: 'The agent is alive but sitting at an input prompt with nothing to recover — it may be at a dialog, or have stopped without producing output.',
    action: 'Check the agent log, answer it in the live terminal, or relaunch the step.',
  };
}

module.exports = { classifyStalledAgent, isAwaitingInput, extractQuestion, AUTH_PATTERNS, WAITING_MARKERS };
