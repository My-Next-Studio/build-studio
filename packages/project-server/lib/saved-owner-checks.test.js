'use strict';

// Owner checks saved for later: one entry per backlog item, its checks added
// to by a later run for the same item, removed whole when done or skipped.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSaved, saveForLater, removeSaved } = require('./saved-owner-checks');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'saved-checks-'));

test('a run saves its checks; a later run for the same item adds only new ones', () => {
  const dir = tmp();
  try {
    assert.deepEqual(loadSaved(dir), []);
    const first = saveForLater(dir, { id: 'run-1', itemId: 'EX-1', type: 'execution', prdPath: 'docs/prds/PRD-1.md' },
      [{ text: 'Look at the list', step: 'qa_validation' }]);
    assert.equal(first.item, 'EX-1');
    saveForLater(dir, { id: 'run-2', itemId: 'EX-1', type: 'bugfix' },
      [{ text: 'Look at the list', step: 'qa_validation' }, { text: 'Try it on a device', step: 'final_review' }]);
    saveForLater(dir, { id: 'run-3', itemId: 'EX-2', type: 'execution' }, [{ text: 'Read the copy' }]);
    const all = loadSaved(dir);
    assert.deepEqual(all.map((e) => e.item), ['EX-1', 'EX-2']);
    assert.deepEqual(all[0].checks.map((c) => c.text), ['Look at the list', 'Try it on a device']);
    assert.deepEqual(all[0].runIds, ['run-1', 'run-2']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('nothing to save saves nothing; removing takes the whole entry', () => {
  const dir = tmp();
  try {
    assert.equal(saveForLater(dir, { id: 'r', itemId: 'EX-1' }, []), null);
    assert.equal(saveForLater(dir, { id: 'r', itemId: 'EX-1' }, null), null);
    assert.deepEqual(loadSaved(dir), []);
    const e = saveForLater(dir, { id: 'r', itemId: 'EX-1' }, [{ text: 'a' }]);
    assert.equal(removeSaved(dir, 'missing'), null);
    assert.equal(removeSaved(dir, e.id).id, e.id);
    assert.deepEqual(loadSaved(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable file reads as nothing saved', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'saved-owner-checks.json'), '{not json');
    assert.deepEqual(loadSaved(dir), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
