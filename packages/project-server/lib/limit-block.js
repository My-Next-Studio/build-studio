'use strict';

/**
 * "Is this agent stuck, or is it waiting for a usage limit to reset?"
 *
 * The two look identical to the idle watchdog — no log output for fifteen
 * minutes — but they need opposite handling. A stalled agent needs a human. An
 * agent that hit the provider's usage limit needs nothing except time, and it
 * announces exactly how much:
 *
 *     You've hit your session limit · resets 10am (Europe/Stockholm)
 *
 * Reporting that as "Stalled — no log activity for 15 minutes" was wrong in
 * both directions. It sent the reader looking for a dead process (the agents
 * were alive at their prompt the whole time), and it moved them into `error`,
 * where the review-advance guard treats them as terminal — so the first agent
 * to come back could carry the step forward on its own verdict while five
 * others had said nothing (fazon, 2026-08-03).
 *
 * Everything here is pure; the log reading and the tmux nudge live in server.js.
 */

/** The notice, in the shapes the CLI prints it. */
const LIMIT_RE = /(?:hit|reached)\s+your\s+(?:session|usage|weekly)\s+limit/i;

/**
 * The CLI's interactive limit dialog:
 *
 *     What do you want to do?
 *     ❯ 1. Stop and wait for limit to reset
 *       2. Upgrade your plan
 *       3. Switch to Team plan
 *     Enter to confirm · Esc to cancel
 *
 * A SECOND, distinct blocked state, and the one a nudge must not be pasted
 * into: option 1 is already selected, so the agent needs a bare Enter, not a
 * sentence. Pasting prose into a chooser types into nothing and then confirms
 * whatever happened to be highlighted.
 *
 * It is also why detection cannot rely on the notice alone — this dialog can be
 * on screen with the notice already scrolled out of the pane entirely.
 */
const CHOOSER_RE = /stop and wait for (?:the )?limit to reset/i;

/** `resets 10am`, `resets 10:30 pm`, `resets at 3 PM` — the trailing zone is the machine's own. */
const RESET_RE = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;

/**
 * Read a limit notice out of an agent's recent output.
 *
 * @param {string} text     tail of the agent's pipe-pane log (ANSI is tolerated)
 * @param {Date}   now      reference time — the caller's clock, injected so this stays testable
 * @returns {null|{raw:string, resetsAt:Date|null}}  null when this is not a limit notice
 */
function parseLimitNotice(text, now = new Date()) {
  // \r as well as \n: this is TUI output, which redraws with carriage returns
  // and can put an entire screen on one "line". Splitting on \n alone yields a
  // single enormous blob, and taking its head returns the startup banner rather
  // than the notice — measured against a real 157 KB agent log.
  const clean = stripAnsi(String(text || '')).replace(/\r/g, '\n');

  // The LAST occurrence: an agent can hit the limit, resume, and hit it again,
  // and only the most recent reset time is the one still to wait for.
  let idx = -1;
  const scan = new RegExp(LIMIT_RE.source, 'gi');
  for (let m = scan.exec(clean); m; m = scan.exec(clean)) idx = m.index;
  if (idx < 0) return null;

  // A window forward from the match — the reset clause follows the phrase.
  // Cut at the first newline so the following screen content stays out.
  const raw = clean.slice(idx, idx + 200).split('\n')[0].trim().replace(/\s+/g, ' ');

  return { raw, resetsAt: parseResetTime(raw, now) };
}

/**
 * The next wall-clock occurrence of the announced reset time.
 *
 * Interpreted in the MACHINE's local zone on purpose: the CLI prints the reset
 * in the user's own timezone (it names it in parentheses), and that is the same
 * clock this process runs on. Converting via the named zone would be re-deriving
 * what the local clock already agrees with.
 *
 * Returns null when no time is announced — the caller decides what to do with
 * an unknown reset rather than this guessing one.
 */
function parseResetTime(raw, seenAt = new Date()) {
  const now = seenAt;
  const m = RESET_RE.exec(raw || '');
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3] ? m[3].toLowerCase() : null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (minute < 0 || minute > 59) return null;

  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  const at = new Date(now.getTime());
  at.setHours(hour, minute, 0, 0);
  // A reset time that has already passed today refers to tomorrow — "resets
  // 10am" seen at 11pm is nine hours away, not thirteen hours ago.
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/**
 * Is a blocked agent due to be resumed?
 *
 * @param {{resetsAt?:string|Date|null, detectedAt?:string|Date, resumeCount?:number}} block
 * @param {Date} now
 * @param {{maxResumes?:number, unknownResetDelayMs?:number}} [opts]
 * @returns {{due:boolean, reason:string}}
 */
function isResumeDue(block, now = new Date(), opts = {}) {
  const maxResumes = Number.isFinite(opts.maxResumes) ? opts.maxResumes : 3;
  const unknownDelay = Number.isFinite(opts.unknownResetDelayMs) ? opts.unknownResetDelayMs : 60 * 60 * 1000;
  if (!block) return { due: false, reason: 'not blocked' };
  if ((block.resumeCount || 0) >= maxResumes) {
    // A limit that keeps re-blocking is not something to hammer: stop and let
    // it surface, rather than burning the reset the moment it arrives.
    return { due: false, reason: `auto-resume exhausted after ${block.resumeCount} attempt(s)` };
  }
  const t = block.resetsAt ? new Date(block.resetsAt).getTime() : null;
  if (t && Number.isFinite(t)) {
    return now.getTime() >= t
      ? { due: true, reason: 'reset time reached' }
      : { due: false, reason: `waiting for reset at ${new Date(t).toISOString()}` };
  }
  // No announced reset — retry on a conservative delay rather than never.
  const since = block.detectedAt ? new Date(block.detectedAt).getTime() : null;
  if (!since || !Number.isFinite(since)) return { due: false, reason: 'no reset time and no detection time' };
  return now.getTime() - since >= unknownDelay
    ? { due: true, reason: 'fallback delay elapsed (no reset time announced)' }
    : { due: false, reason: 'waiting out the fallback delay (no reset time announced)' };
}

/** Human summary for the UI — says what is happening and when it resolves. */
function describeBlock(block, now = new Date()) {
  if (!block) return null;
  const when = block.resetsAt ? new Date(block.resetsAt) : null;
  const valid = when && Number.isFinite(when.getTime());
  const clock = valid
    ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : null;
  const exhausted = isResumeDue(block, now).reason.startsWith('auto-resume exhausted');
  if (exhausted) {
    return `Blocked on the provider usage limit. Auto-resume gave up after ${block.resumeCount} attempt(s) — resume it from the live terminal.`;
  }
  return clock
    ? `Blocked on the provider usage limit — resuming automatically at ${clock}.`
    : 'Blocked on the provider usage limit — no reset time announced; retrying automatically.';
}

function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/**
 * Is this agent blocked on a usage limit, and what does it need?
 *
 * Two sources, because neither alone is sufficient:
 *
 *  - the PANE says what state the agent is in RIGHT NOW (waiting at a prompt,
 *    or sitting on the chooser). The log cannot say this: an idle TUI repaints
 *    endlessly, so the log's tail is redraw noise.
 *  - the LOG holds the reset time, which the pane may have scrolled away.
 *    Measured on a real blocked agent: the pane showed only the chooser, while
 *    `resets 3pm` was still in the log.
 *
 * @param {{pane?:string, log?:string}} sources
 * @param {Date} now
 * @returns {null|{raw:string, resetsAt:Date|null, needsConfirm:boolean}}
 */
function detectLimitState({ pane = '', log = '', seenAt } = {}, now = new Date()) {
  // Anchor the reset arithmetic to when the notice was PRINTED — callers pass
  // the log's mtime. Anchoring on `now` instead computes the NEXT occurrence of
  // the announced clock time, so a notice printed at 14:11 saying "resets 3pm",
  // read at 15:16, resolves to tomorrow and parks the agent for ~24 hours over
  // a reset that already happened. Measured exactly that way on a live agent.
  const anchor = seenAt ? new Date(seenAt) : now;
  const paneClean = stripAnsi(String(pane)).replace(/\r/g, '\n');
  const fromPane = parseLimitNotice(pane, anchor);
  const needsConfirm = CHOOSER_RE.test(paneClean);

  // The CURRENT state has to come from the pane. A limit notice sitting in the
  // log proves only that the agent was blocked at some point — it may have
  // resumed and moved on since.
  if (!fromPane && !needsConfirm) return null;

  const fromLog = fromPane && fromPane.resetsAt ? null : parseLimitNotice(log, anchor);
  const resetsAt = (fromPane && fromPane.resetsAt) || (fromLog && fromLog.resetsAt) || null;
  const raw = (fromPane && fromPane.raw)
    || (fromLog && fromLog.raw)
    || 'Waiting at the usage-limit prompt';
  return { raw, resetsAt, needsConfirm };
}

module.exports = {
  parseLimitNotice, parseResetTime, isResumeDue, describeBlock, detectLimitState,
  LIMIT_RE, CHOOSER_RE,
};
