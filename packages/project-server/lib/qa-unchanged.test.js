'use strict';

// A QA round after a fix round that changed nothing carries the last round's
// counts forward and re-runs only the checks behind its open findings.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { headOf, unchangedSinceLastQa, unchangedRoundSection, REPORT_MAX_CHARS } = require('./qa-unchanged');

const REPORT = '**Approved:** no\n**Blocking:** 1\n**Tests passed:** 5655/5685\n\n### Findings\n1. BLOCKING: `node scripts/gates/go-live dist` exits 1.';

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-unchanged-'));
  const g = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 1;\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  return { root, g, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('nothing committed or changed since the last round: its record comes back', () => {
  const { root, clean } = repo();
  try {
    const last = { round: 4, head: headOf(root), feedback: REPORT };
    // QA's own evidence is untracked and does not count as a change.
    fs.writeFileSync(path.join(root, 'evidence.png'), 'x');
    assert.deepEqual(unchangedSinceLastQa(root, last), last);
  } finally { clean(); }
});

test('a commit since the last round means a full re-validation', () => {
  const { root, g, clean } = repo();
  try {
    const last = { round: 4, head: headOf(root), feedback: REPORT };
    fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 2;\n');
    g('commit', '-q', '-am', 'fix');
    assert.equal(unchangedSinceLastQa(root, last), null);
  } finally { clean(); }
});

test('an uncommitted change to a tracked file means a full re-validation', () => {
  const { root, clean } = repo();
  try {
    const last = { round: 4, head: headOf(root), feedback: REPORT };
    fs.writeFileSync(path.join(root, 'app.js'), 'module.exports = 3;\n');
    assert.equal(unchangedSinceLastQa(root, last), null);
  } finally { clean(); }
});

test('no record, no head, no report, or an unknown commit: a full re-validation', () => {
  const { root, clean } = repo();
  try {
    const head = headOf(root);
    assert.equal(unchangedSinceLastQa(root, undefined), null);
    assert.equal(unchangedSinceLastQa(root, { round: 4, head: null, feedback: REPORT }), null);
    assert.equal(unchangedSinceLastQa(root, { round: 4, head, feedback: '  ' }), null);
    assert.equal(unchangedSinceLastQa(root, { round: 4, head: 'f'.repeat(40), feedback: REPORT }), null);
  } finally { clean(); }
});

test('the section carries the counts forward and targets the open findings', () => {
  const head = 'b9efed0e65b3270ba3e6161587a868ab0f5c85cb';
  const s = unchangedRoundSection({ round: 5, last: { round: 4, head, feedback: REPORT }, fixFeedback: 'No new commit this round.' });
  assert.match(s, /RE-VALIDATION \(Round 5\) — NOTHING HAS CHANGED SINCE ROUND 4/);
  assert.match(s, /does NOT re-run the full suite/);
  assert.match(s, /carried from round 4 at b9efed0e; no code change since/);
  assert.match(s, /Awaiting owner:/);
  assert.ok(s.includes(`git diff --stat ${head} HEAD`));
  assert.ok(s.includes(REPORT), 'the last report is included for the counts and findings');
  assert.match(s, /Round 4 fix report \(context only\):\nNo new commit this round\./);
});

test('a long report is truncated', () => {
  const long = REPORT + 'x'.repeat(REPORT_MAX_CHARS);
  const s = unchangedRoundSection({ round: 3, last: { round: 2, head: 'a'.repeat(40), feedback: long }, fixFeedback: '' });
  assert.match(s, /\[… report truncated\]/);
  assert.doesNotMatch(s, /fix report/);
});
