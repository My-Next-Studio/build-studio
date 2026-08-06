const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePorcelain } = require('./git');

// Real `git status --porcelain` output. The leading space on an unstaged line
// is DATA, not padding — which is what made this incompatible with trimming.
const MIXED = ' M docs/a.md\n M e2e/b.ts\nM  src/c.ts\n?? new.txt\n';

test('an unstaged file keeps its whole name and stays out of the staged box', () => {
  // The reported bug: "docs" displayed as "ocs", "e2e" as "2e", and the file
  // sitting in the staged box while being unstaged.
  const r = parsePorcelain(MIXED);
  assert.deepEqual(r.unstagedFiles, ['docs/a.md', 'e2e/b.ts']);
  assert.deepEqual(r.stagedFiles, ['src/c.ts']);
  assert.deepEqual(r.untrackedFiles, ['new.txt']);
});

test('the first line is not special — it was, and that was the bug', () => {
  // Trimming the whole output stripped the leading space from line one only,
  // so exactly one file per listing was misparsed. Whichever order, all four
  // must classify identically.
  const reordered = 'M  src/c.ts\n M docs/a.md\n?? new.txt\n M e2e/b.ts\n';
  const a = parsePorcelain(MIXED);
  const b = parsePorcelain(reordered);
  assert.deepEqual([...a.unstagedFiles].sort(), [...b.unstagedFiles].sort());
  assert.deepEqual(a.stagedFiles, b.stagedFiles);
  assert.equal(a.staged, b.staged);
});

test('counts agree with the lists', () => {
  const r = parsePorcelain(MIXED);
  assert.equal(r.staged, r.stagedFiles.length);
  assert.equal(r.unstaged, r.unstagedFiles.length);
  assert.equal(r.untracked, r.untrackedFiles.length);
});

test('a trailing newline does not become a phantom staged file', () => {
  // An empty line has l[0] === undefined, and `undefined !== ' '` is true — so
  // an unfiltered blank would be counted as staged with an empty path.
  const r = parsePorcelain('M  src/c.ts\n');
  assert.equal(r.staged, 1);
  assert.deepEqual(r.stagedFiles, ['src/c.ts']);
});

test('a clean tree is null, not an empty listing', () => {
  assert.equal(parsePorcelain(''), null);
  assert.equal(parsePorcelain('\n'), null);
  assert.equal(parsePorcelain(null), null);
  assert.equal(parsePorcelain(undefined), null);
});

test('a staged-and-then-modified file appears in both', () => {
  // 'MM' is genuinely both: staged content plus further unstaged edits.
  const r = parsePorcelain('MM src/c.ts\n');
  assert.deepEqual(r.stagedFiles, ['src/c.ts']);
  assert.deepEqual(r.unstagedFiles, ['src/c.ts']);
});

test('a rename reports the new path', () => {
  const r = parsePorcelain('R  old/name.ts -> new/name.ts\n');
  assert.deepEqual(r.stagedFiles, ['new/name.ts']);
});

test('a deletion is reported, staged or not', () => {
  const r = parsePorcelain('D  gone.ts\n D also-gone.ts\n');
  assert.deepEqual(r.stagedFiles, ['gone.ts']);
  assert.deepEqual(r.unstagedFiles, ['also-gone.ts']);
});

test('paths with spaces survive', () => {
  const r = parsePorcelain(' M docs/my notes.md\n');
  assert.deepEqual(r.unstagedFiles, ['docs/my notes.md']);
});
