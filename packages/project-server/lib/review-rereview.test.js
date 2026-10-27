'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { roleHistory, buildRereviewInstruction } = require('./review-rereview');

const WF = {
  round: 3,
  feedback: [
    { round: 1, step: 'reviewing', role: 'Brand', feedback: 'brand r1 finding' },
    { round: 1, step: 'reviewing', role: 'Architect', feedback: 'architect r1 finding' },
    { round: 1, step: 'reviewing', role: 'QA', feedback: 'qa r1 finding' },
    { round: 1, step: 'pm_fix', role: 'PM', feedback: 'pm fixed everything r1' },
    { round: 2, step: 'reviewing', role: 'Brand', feedback: 'brand r2 finding' },
    { round: 2, step: 'pm_fix', role: 'PM', feedback: 'pm fixed everything r2' },
  ],
};

test('a role sees its OWN findings, not the other reviewers', () => {
  // Feeding every reviewer all six perspectives is both the bulk of the prompt
  // and an anchoring risk — Brand reading Architect's blocker before forming
  // its own view. A targeted re-review asks a narrower question.
  const h = roleHistory(WF, 'Brand');
  assert.match(h, /brand r1 finding/);
  assert.match(h, /brand r2 finding/);
  assert.doesNotMatch(h, /architect r1 finding/);
  assert.doesNotMatch(h, /qa r1 finding/);
});

test('PM fix reports are always included — they are the claim being verified', () => {
  const h = roleHistory(WF, 'Brand');
  assert.match(h, /pm fixed everything r1/);
  assert.match(h, /pm fixed everything r2/);
  assert.match(h, /the claim you are verifying/);
});

test('role matching survives spelling variants', () => {
  const wf = { round: 2, feedback: [{ round: 1, step: 'reviewing', role: 'Code Reviewer', feedback: 'x' }] };
  assert.match(roleHistory(wf, 'code_reviewer'), /round 1/i);
  assert.match(roleHistory(wf, 'code-reviewer'), /round 1/i);
});

test('a role with no prior findings and no fixes gets nothing rather than an empty heading', () => {
  assert.equal(roleHistory({ round: 2, feedback: [] }, 'Brand'), '');
});

test('an OLDER round is truncated, and says so', () => {
  // Was "long feedback is truncated": the cap now applies only to rounds before
  // the latest, because a truncated latest round is the thing being verified.
  const wf = { round: 3, feedback: [
    { round: 1, step: 'reviewing', role: 'Brand', feedback: 'x'.repeat(5000) },
    { round: 2, step: 'reviewing', role: 'Brand', feedback: 'latest' },
  ] };
  const h = roleHistory(wf, 'Brand', 100);
  assert.match(h, /truncated/);
  assert.ok(h.includes('latest'), 'the latest round must survive whole');
  assert.ok(h.length < 1500);
});

test('the re-review instruction narrows scope without forbidding blocking', () => {
  const i = buildRereviewInstruction('Brand', 'brand', 'docs/prds/PRD-1.md', 3);
  assert.match(i, /TARGETED RE-REVIEW/);
  // Must still be able to stop a bad fix.
  assert.match(i, /NOT CLOSED/);
  assert.match(i, /REGRESSION/);
  // …while ruling out the fresh sweep that made rounds unbounded.
  assert.match(i, /Do NOT re-read and re-assess sections that no fix\s+touched/);
  assert.match(i, /### Follow-up proposals/);
});

test('it keeps the machine-parsed verdict format the gate requires', () => {
  const i = buildRereviewInstruction('QA', 'qa_review', 'docs/prds/PRD-1.md', 2);
  assert.match(i, /\*\*Approved:\*\* yes \| no/);
  assert.match(i, /\*\*Blocking:\*\* N/);
  assert.match(i, /## Review: QA/);
});

// valkomna VK-062 (2026-10-27): every round-3 review listed its round-1
// findings as "MEDIUM: … CLOSED", which read as open mediums on a clean round.
test('closed findings are counted, not listed: the report shows only what needs fixing', () => {
  const i = buildRereviewInstruction('UX', 'ux', 'p.md', 3);
  assert.doesNotMatch(i, /### Verification of prior findings/);
  assert.match(i, /\*\*Prior findings:\*\* N checked, N closed/);
  assert.match(i, /do NOT list the ones that are CLOSED/);
});

test('an all-closed round is stated as the expected good outcome', () => {
  const i = buildRereviewInstruction('Brand', 'brand', 'p.md', 2);
  assert.match(i, /If every finding of yours is CLOSED/);
  assert.match(i, /not a rubber stamp/);
});

// ─── The delta has to be handed over, not just implied (fazon, 2026-08-22) ───
//
// The instruction already said "do not re-read untouched sections". Measured on
// a real review, 5 of 6 round-2 reviewers read the full 394-line PRD anyway and
// round 2 cost MORE than round 1 (+27% cache reads, +20% turns) — because
// nothing told them HOW to see what changed.

test('a known base sha becomes a runnable diff command', () => {
  const t = buildRereviewInstruction('Brand', 'brand', 'docs/prds/PRD-125.md', 2, 'abc1234');
  assert.match(t, /git diff abc1234 -- docs\/prds\/PRD-125\.md/);
  assert.match(t, /START HERE — THE DELTA, NOT THE DOCUMENT/);
});

test('without a base sha it still says how to find the delta', () => {
  // Runs launched before the sha was recorded must not lose the guidance.
  const t = buildRereviewInstruction('QA', 'qa_review', 'docs/prds/PRD-9.md', 3, null);
  assert.match(t, /START HERE — THE DELTA/);
  assert.match(t, /git log --oneline -3 -- docs\/prds\/PRD-9\.md/);
});

test('the rest of the contract survives the new section', () => {
  // The diff block is inserted mid-template; a broken literal would truncate it.
  const t = buildRereviewInstruction('UX', 'ux', 'docs/prds/PRD-1.md', 2, 'deadbee');
  for (const marker of ['## WHAT BLOCKS', '## WHAT DOES NOT BLOCK', '**Prior findings:**', '### Action Items', 'REGRESSED']) {
    assert.ok(t.includes(marker), `missing: ${marker}`);
  }
});

test('reading the whole document is named as the thing to avoid', () => {
  const t = buildRereviewInstruction('Architect', 'architect', 'p.md', 2, 'sha');
  assert.match(t, /Re-reading the whole\s+document is exactly what this round exists to avoid/);
});

// ─── The latest round must arrive whole (fazon, 2026-08-22) ─────────────────
//
// A flat 1200-char cap gave each reviewer 11-18% of its own prior review. The
// cut landed on the first finding's TITLE, so every finding body — the thing
// being verified — was gone, as was 80% of the PM fix report claiming to close
// them. A reviewer ran `sed` over its own transcript to recover the rest.

function wfWith(entries) { return { feedback: entries }; }
const long = (n, tag) => `${tag} `.repeat(Math.ceil(n / (tag.length + 1))).slice(0, n);

test('the latest round of own findings is delivered in full', () => {
  const body = long(9000, 'FINDING');
  const h = roleHistory(wfWith([{ role: 'QA', round: 2, step: 'reviewing', feedback: body }]), 'QA');
  assert.ok(h.includes(body), 'the whole review must be present');
  assert.doesNotMatch(h, /truncated/);
});

test('the latest PM fix report is delivered in full — it is the claim', () => {
  const fix = long(6000, 'FIXED');
  const h = roleHistory(wfWith([{ role: 'PM', round: 2, step: 'pm_fix', feedback: fix }]), 'QA');
  assert.ok(h.includes(fix));
  assert.doesNotMatch(h, /truncated/);
});

test('older rounds stay capped, so the block does not grow without bound', () => {
  const h = roleHistory(wfWith([
    { role: 'QA', round: 1, step: 'reviewing', feedback: long(9000, 'OLD') },
    { role: 'QA', round: 4, step: 'reviewing', feedback: long(9000, 'NEW') },
  ]), 'QA');
  assert.match(h, /truncated/, 'round 1 should be cut');
  assert.ok(h.includes(long(9000, 'NEW')), 'round 4 should be whole');
  assert.ok(h.length < 9000 + 1200 + 3000, `block should stay bounded, got ${h.length}`);
});

test('a truncation says what was removed rather than trailing off', () => {
  // Silent truncation reads as "this is all of it", which is how a reviewer
  // ends up verifying a finding it cannot see.
  const h = roleHistory(wfWith([
    { role: 'QA', round: 1, step: 'reviewing', feedback: long(5000, 'OLD') },
    { role: 'QA', round: 2, step: 'reviewing', feedback: 'short' },
  ]), 'QA');
  assert.match(h, /more characters from an earlier round; the latest round is shown in full/);
});

test('only this role\'s findings are included', () => {
  const h = roleHistory(wfWith([
    { role: 'QA', round: 1, step: 'reviewing', feedback: 'QA-FINDING' },
    { role: 'Brand', round: 1, step: 'reviewing', feedback: 'BRAND-FINDING' },
  ]), 'QA');
  assert.ok(h.includes('QA-FINDING'));
  assert.ok(!h.includes('BRAND-FINDING'), 'other roles must not leak in');
});

test('even a full-text entry has a ceiling', () => {
  const h = roleHistory(wfWith([{ role: 'QA', round: 1, step: 'reviewing', feedback: long(40000, 'X') }]), 'QA');
  assert.match(h, /truncated/);
  assert.ok(h.length < 30000, `pathological entry must not dominate, got ${h.length}`);
});

// ── prdHeadSha ───────────────────────────────────────────────────────────────
//
// This helper exists because the inline version of it was dead code for a week.
// It called execFileSync in a scope that never imported it, threw ReferenceError
// on every round in every project, and the caller's `catch (_) {}` ate it. The
// prompt shipped in its no-diff form and nothing looked wrong — the re-review
// block was present, just never carrying a diff. These tests are the thing that
// was missing: something that actually calls it.

const path = require('path');
const fs = require('fs');
const os = require('os');
const { prdHeadSha } = require('./review-rereview');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

test('a committed file resolves to a sha', () => {
  const sha = prdHeadSha(REPO_ROOT, 'CHANGELOG.md');
  assert.match(sha || '', /^[0-9a-f]{40}$/, 'expected a full commit sha');
});

test('a path with no commits is null, not a throw and not a stale sha', () => {
  // `git log -- <unknown>` exits 0 with empty output, so this is the branch that
  // must not return '' and must not fall through to some other file's sha.
  assert.equal(prdHeadSha(REPO_ROOT, 'docs/prds/PRD-does-not-exist.md'), null);
});

test('missing arguments are null rather than a lookup of the whole repo', () => {
  assert.equal(prdHeadSha(REPO_ROOT, null), null);
  assert.equal(prdHeadSha(null, 'CHANGELOG.md'), null);
});

test('outside a git repo it is null, not an exception', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-git-'));
  assert.equal(prdHeadSha(dir, 'anything.md'), null);
});

test('the sha it returns actually produces a diff line in the prompt', () => {
  // The regression guard. Both halves worked in isolation the whole time; what
  // was broken was that the sha never reached buildRereviewInstruction.
  const sha = prdHeadSha(REPO_ROOT, 'CHANGELOG.md');
  const ins = buildRereviewInstruction('Architect', 'architect', 'CHANGELOG.md', 2, sha);
  assert.match(ins, new RegExp(`git diff ${sha} -- CHANGELOG\\.md`));
});

test('and without a sha the prompt degrades instead of emitting a broken command', () => {
  const ins = buildRereviewInstruction('Architect', 'architect', 'CHANGELOG.md', 2, null);
  assert.doesNotMatch(ins, /git diff/, 'a null base must not render `git diff null --`');
  assert.match(ins, /START HERE/, 'the re-review framing still ships');
});
