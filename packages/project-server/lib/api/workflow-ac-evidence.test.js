'use strict';

// Tests for collectMissingAcArtifacts — the AC-verification evidence gate.
// Regression focus: verifiers cite multiple artifacts as a comma-separated
// list, and a path regex that swallows the separator stats `foo.txt,` and
// reports a committed file as missing. Observed on finance-studio PRD-004:
// all four AC-1 artifacts were committed, only the last one (no trailing
// comma) resolved, and the gate blocked approval on three phantom paths
// while auto-advance silently re-tried and stalled.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { collectMissingAcArtifacts } = require('./workflow');

const ROOT = '/proj';
// Stub filesystem — only these paths "exist".
const PRESENT = new Set([
  '/proj/docs/pr-evidence/PRD-004/build/README.md',
  '/proj/docs/pr-evidence/PRD-004/build/build-log.txt',
  '/proj/docs/pr-evidence/PRD-004/build/dist-listing.txt',
  '/proj/docs/pr-evidence/PRD-004/build/unpacked-listing.txt',
]);
const opts = (over = {}) => ({ projectRoot: ROOT, exists: p => PRESENT.has(p), ...over });

const row = (id, status, type, evidence) => `| ${id} | some description | ${status} | ${type} | ${evidence} |`;

test('MANUAL row citing a comma-separated list of existing artifacts is not flagged', () => {
  const fb = row('AC-1', 'MET', 'MANUAL', [
    'docs/pr-evidence/PRD-004/build/README.md',
    'docs/pr-evidence/PRD-004/build/build-log.txt',
    'docs/pr-evidence/PRD-004/build/dist-listing.txt',
    'docs/pr-evidence/PRD-004/build/unpacked-listing.txt',
  ].join(', '));
  assert.deepEqual(collectMissingAcArtifacts(fb, opts()), []);
});

test('absolute paths resolve against the project root', () => {
  const fb = row('AC-1', 'MET', 'MANUAL',
    '/Volumes/x/proj/docs/pr-evidence/PRD-004/build/README.md, /Volumes/x/proj/docs/pr-evidence/PRD-004/build/build-log.txt');
  assert.deepEqual(collectMissingAcArtifacts(fb, opts()), []);
});

test('a path ending a sentence keeps its extension, drops the period', () => {
  const fb = row('AC-1', 'MET', 'MANUAL', 'see docs/pr-evidence/PRD-004/build/README.md.');
  assert.deepEqual(collectMissingAcArtifacts(fb, opts()), []);
});

test('genuinely missing artifacts are still flagged', () => {
  const fb = row('AC-2', 'MET', 'MANUAL',
    'docs/pr-evidence/PRD-004/build/README.md, docs/pr-evidence/PRD-004/build/nope.txt');
  assert.deepEqual(collectMissingAcArtifacts(fb, opts()),
    [{ ac: 'AC-2', path: 'docs/pr-evidence/PRD-004/build/nope.txt' }]);
});

test('MANUAL + MET citing no path at all is flagged', () => {
  const fb = row('AC-3', 'MET', 'MANUAL', 'side-by-side screenshot in the PR description');
  assert.deepEqual(collectMissingAcArtifacts(fb, opts()), [{ ac: 'AC-3', path: '(no path cited)' }]);
});

test('non-MET rows are never gated, whatever they cite', () => {
  const fb = [
    row('AC-4', 'UNMET', 'MANUAL', 'docs/pr-evidence/PRD-004/build/nope.txt'),
    row('AC-5', 'PARTIAL', 'MANUAL', 'nothing at all'),
  ].join('\n');
  assert.deepEqual(collectMissingAcArtifacts(fb, opts()), []);
});

test('AUTOMATED+MANUAL hybrid is exempt from the path requirement', () => {
  const fb = row('AC-6', 'MET', 'AUTOMATED + MANUAL', 'covered by PackagingSuite.testBuild plus a manual pass');
  assert.deepEqual(collectMissingAcArtifacts(fb, opts()), []);
});

test('strict mode flags an AUTOMATED row citing neither a test name nor a path', () => {
  const fb = row('AC-7', 'MET', 'AUTOMATED', 'all tests are green');
  const out = collectMissingAcArtifacts(fb, opts({ strict: true }));
  assert.equal(out.length, 1);
  assert.equal(out[0].ac, 'AC-7');
  assert.match(out[0].path, /strict mode/);
  // …and is silent when a test name is cited.
  assert.deepEqual(
    collectMissingAcArtifacts(row('AC-8', 'MET', 'AUTOMATED', 'PackagingSuite.testBuildsClean'), opts({ strict: true })),
    []);
});

test('strict mode scans every AUTOMATED row (sticky regex state is reset)', () => {
  const fb = [
    row('AC-9', 'MET', 'AUTOMATED', 'docs/pr-evidence/PRD-004/build/README.md'),
    row('AC-10', 'MET', 'AUTOMATED', 'it works'),
  ].join('\n');
  const out = collectMissingAcArtifacts(fb, opts({ strict: true }));
  assert.equal(out.length, 1);
  assert.equal(out[0].ac, 'AC-10');
});
