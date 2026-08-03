'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseLimitNotice, parseResetTime, isResumeDue, describeBlock } = require('./limit-block');

// The real notice, as the CLI prints it (2026-08-03).
const NOTICE = "You've hit your session limit · resets 10am (Europe/Stockholm)";
const NOW = new Date('2026-08-03T07:11:00');

test('reads the notice and the reset time', () => {
  const b = parseLimitNotice(NOTICE, NOW);
  assert.match(b.raw, /hit your session limit/);
  assert.equal(b.resetsAt.getHours(), 10);
  assert.equal(b.resetsAt.getMinutes(), 0);
});

test('survives ANSI and carriage-return TUI output', () => {
  // The agent log is a TUI redraw stream: escape sequences everywhere and \r
  // rather than \n as the separator. Splitting on \n alone puts a whole screen
  // on one "line", and taking its head returns the startup banner instead of
  // the notice — which is what a first cut of this actually did against a real
  // 157 KB log.
  const noisy =
    '[38;5;246m ▐▛███▜▌Claude Code v2.1.220 [39m\r'
    + '[1B[49m  ⎿  [38;5;211m' + NOTICE + '[39m[K\r'
    + '[2B[38;5;246m✻ Sautéed for 3s[39m\r';
  const b = parseLimitNotice(noisy, NOW);
  assert.match(b.raw, /hit your session limit · resets 10am/);
  assert.equal(b.resetsAt.getHours(), 10);
  assert.equal(/Claude Code/.test(b.raw), false, 'must not capture the banner');
});

test('takes the LAST notice — an agent can be blocked twice', () => {
  const text = "hit your session limit · resets 3am\n…work…\nhit your usage limit · resets 11pm";
  const b = parseLimitNotice(text, new Date('2026-08-03T12:00:00'));
  assert.equal(b.resetsAt.getHours(), 23);
});

test('ordinary agent output is not a limit notice', () => {
  for (const s of ['', null, undefined, 'Approved: yes', 'the rate limit design is discussed in §4']) {
    assert.equal(parseLimitNotice(s, NOW), null, JSON.stringify(s));
  }
});

test('a notice with no announced reset time parses, with a null reset', () => {
  const b = parseLimitNotice("You've hit your usage limit.", NOW);
  assert.ok(b);
  assert.equal(b.resetsAt, null);
});

test('reset times: 12-hour forms, and a past time means tomorrow', () => {
  const at = (s, now) => parseResetTime(s, now);
  assert.equal(at('resets 10am', NOW).getHours(), 10);
  assert.equal(at('resets 3pm', NOW).getHours(), 15);
  assert.equal(at('resets 12am', NOW).getHours(), 0);
  assert.equal(at('resets 12pm', NOW).getHours(), 12);
  assert.equal(at('resets at 10:30 pm', NOW).getMinutes(), 30);
  // Seen at 11pm, "resets 10am" is nine hours away — not thirteen hours ago.
  const late = new Date('2026-08-03T23:00:00');
  const t = at('resets 10am', late);
  assert.equal(t.getDate(), late.getDate() + 1);
});

test('nonsense times are refused rather than guessed', () => {
  assert.equal(parseResetTime('resets 99', NOW), null);
  assert.equal(parseResetTime('resets soon', NOW), null);
  assert.equal(parseResetTime('', NOW), null);
});

test('resume is due only once the reset has passed', () => {
  const resetsAt = new Date('2026-08-03T10:00:00');
  assert.equal(isResumeDue({ resetsAt }, new Date('2026-08-03T09:59:00')).due, false);
  assert.equal(isResumeDue({ resetsAt }, new Date('2026-08-03T10:00:00')).due, true);
  assert.equal(isResumeDue({ resetsAt }, new Date('2026-08-03T10:01:00')).due, true);
});

test('with no reset time, resume falls back to a delay rather than never', () => {
  const detectedAt = new Date('2026-08-03T07:00:00');
  const opts = { unknownResetDelayMs: 60 * 60 * 1000 };
  assert.equal(isResumeDue({ detectedAt }, new Date('2026-08-03T07:30:00'), opts).due, false);
  assert.equal(isResumeDue({ detectedAt }, new Date('2026-08-03T08:00:00'), opts).due, true);
});

test('auto-resume gives up rather than hammering a persistent limit', () => {
  const resetsAt = new Date('2026-08-03T10:00:00');
  const now = new Date('2026-08-03T11:00:00');
  assert.equal(isResumeDue({ resetsAt, resumeCount: 2 }, now, { maxResumes: 3 }).due, true);
  const v = isResumeDue({ resetsAt, resumeCount: 3 }, now, { maxResumes: 3 });
  assert.equal(v.due, false);
  assert.match(v.reason, /exhausted/);
});

test('the description says what is happening and when it clears', () => {
  const resetsAt = new Date('2026-08-03T10:00:00');
  const d = describeBlock({ resetsAt, detectedAt: NOW }, NOW);
  assert.match(d, /Blocked on the provider usage limit/);
  assert.match(d, /resuming automatically/i);
  // Exhausted reads differently — it points at the manual route instead.
  const e = describeBlock({ resetsAt, resumeCount: 3 }, new Date('2026-08-03T11:00:00'));
  assert.match(e, /gave up/);
  assert.match(e, /live terminal/);
});
