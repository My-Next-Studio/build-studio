'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parsePorcelain, sourceLeftovers, commitNote } = require('./uncommitted-work');

test('porcelain keeps the first path character even with a leading status space', () => {
  assert.deepEqual(parsePorcelain(' M ios/Fazon/Export.swift\n'), [{ status: ' M', path: 'ios/Fazon/Export.swift' }]);
});

test('modified, added, untracked and renamed source files are leftovers; docs are not', () => {
  const raw = [
    ' M ios/Fazon/Features/Export/ExportPeriod.swift',
    'A  ios/FazonTests/WeekStartTests.swift',
    '?? ios/FazonTests/New.swift',
    'R  old/name.js -> src/name.js',
    ' M docs/backlog/FAZ-470.md',
    '?? docs/qa/evidence/shot.png',
    '',
  ].join('\n');
  assert.deepEqual(sourceLeftovers(raw), [
    'ios/Fazon/Features/Export/ExportPeriod.swift',
    'ios/FazonTests/WeekStartTests.swift',
    'ios/FazonTests/New.swift',
    'src/name.js',
  ]);
});

test('a clean tree, or docs-only changes, leave nothing', () => {
  assert.deepEqual(sourceLeftovers(''), []);
  assert.deepEqual(sourceLeftovers(' M docs/backlog-index.md\n'), []);
});

test('the note names the files and the branch, and asks for a commit, not a redo', () => {
  const note = commitNote(['ios/A.swift', 'ios/B.swift'], 'fix/faz-470');
  assert.match(note, /- ios\/A\.swift\n- ios\/B\.swift/);
  assert.match(note, /`fix\/faz-470`/);
  assert.match(note, /Do not redo the task/);
});

test('a long list is cut at twenty with a count', () => {
  const paths = Array.from({ length: 25 }, (_, i) => `src/f${i}.js`);
  assert.match(commitNote(paths), /… and 5 more/);
});
