'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { archiveLearning, brokenLinks } = require('./learnings-archive');

/** A docs/ tree: A → B, B → C, the index → all, plus links from outside learnings/. */
function fixture() {
  const docs = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'learn-archive-')), 'docs');
  const L = path.join(docs, 'learnings');
  const w = (rel, text) => { const p = path.join(docs, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
  w('learnings/architecture/A.md', '# A\nSee [B](../qa/B.md#why) and [C](../frontend/C.md).\n');
  w('learnings/qa/B.md', '# B\nBuilds on [C](../frontend/C.md). Self: [here](B.md#top). Web: [x](https://example.com/qa/B.md).\n[ref]: ../frontend/C.md\n');
  w('learnings/frontend/C.md', '# C\nNo links.\n');
  w('learnings/MEMORY.md', '- [A](architecture/A.md)\n- [B](qa/B.md)\n- [C](frontend/C.md)\n');
  w('learnings/_archive/devops/OLD.md', '# Old\nRelated: [B](../../qa/B.md)\n');
  w('project-state.md', '# State\nKey learning: [B](learnings/qa/B.md)\n');
  return { docs, L, read: (rel) => fs.readFileSync(path.join(docs, rel), 'utf8') };
}

test('archiving B repoints every inbound link and adjusts B\'s own links for the extra depth', () => {
  const { docs, L, read } = fixture();
  const r = archiveLearning({ file: path.join(L, 'qa', 'B.md'), baseDir: L, domain: 'qa', scanRoot: docs });
  assert.equal(r.archived, true);
  assert.equal(fs.existsSync(path.join(L, 'qa', 'B.md')), false);

  // Inbound, from a sibling learning (anchor kept), the index, another archived
  // file, and a doc outside learnings/.
  assert.match(read('learnings/architecture/A.md'), /\[B\]\(\.\.\/_archive\/qa\/B\.md#why\)/);
  assert.match(read('learnings/architecture/A.md'), /\[C\]\(\.\.\/frontend\/C\.md\)/, 'unrelated links untouched');
  assert.match(read('learnings/MEMORY.md'), /\[B\]\(_archive\/qa\/B\.md\)/);
  assert.match(read('learnings/_archive/devops/OLD.md'), /\[B\]\(\.\.\/qa\/B\.md\)/);
  assert.match(read('project-state.md'), /\[B\]\(learnings\/_archive\/qa\/B\.md\)/);

  // B's own links, one level deeper now. A self-link follows the file; URLs and
  // reference definitions are handled too.
  const b = read('learnings/_archive/qa/B.md');
  assert.match(b, /\[C\]\(\.\.\/\.\.\/frontend\/C\.md\)/);
  assert.match(b, /\[here\]\(B\.md#top\)/);
  assert.match(b, /https:\/\/example\.com\/qa\/B\.md/);
  assert.match(b, /^\[ref\]: \.\.\/\.\.\/frontend\/C\.md$/m);

  // A link checker over the whole tree finds nothing missing.
  assert.deepEqual([...brokenLinks(docs)], []);
});

test('an entry with no inbound links archives with no edits anywhere', () => {
  const { docs, L, read } = fixture();
  fs.writeFileSync(path.join(L, 'frontend', 'lonely.md'), '# Lonely\nNothing links here.\n');
  const before = {
    a: read('learnings/architecture/A.md'), mem: read('learnings/MEMORY.md'), state: read('project-state.md'),
  };
  const r = archiveLearning({ file: path.join(L, 'frontend', 'lonely.md'), baseDir: L, domain: 'frontend', scanRoot: docs });
  assert.equal(r.archived, true);
  assert.deepEqual(r.rewritten, [], 'no spurious edits');
  assert.equal(read('learnings/_archive/frontend/lonely.md'), '# Lonely\nNothing links here.\n');
  assert.deepEqual({ a: read('learnings/architecture/A.md'), mem: read('learnings/MEMORY.md'), state: read('project-state.md') }, before);
});

test('two entries archived one after the other keep links between them working', () => {
  const { docs, L } = fixture();
  archiveLearning({ file: path.join(L, 'frontend', 'C.md'), baseDir: L, domain: 'frontend', scanRoot: docs });
  archiveLearning({ file: path.join(L, 'qa', 'B.md'), baseDir: L, domain: 'qa', scanRoot: docs });
  assert.match(fs.readFileSync(path.join(L, '_archive', 'qa', 'B.md'), 'utf8'), /\[C\]\(\.\.\/frontend\/C\.md\)/);
  assert.deepEqual([...brokenLinks(docs)], []);
});

test('a link that was already broken elsewhere does not block archiving', () => {
  const { docs, L } = fixture();
  fs.writeFileSync(path.join(L, 'frontend', 'C.md'), '# C\nStale: [gone](../nowhere.md)\n');
  const r = archiveLearning({ file: path.join(L, 'qa', 'B.md'), baseDir: L, domain: 'qa', scanRoot: docs });
  assert.equal(r.archived, true);
  assert.equal([...brokenLinks(docs)].length, 1, 'only the pre-existing broken link remains');
});

test('an entry already in the archive is not overwritten', () => {
  const { docs, L } = fixture();
  fs.mkdirSync(path.join(L, '_archive', 'qa'), { recursive: true });
  fs.writeFileSync(path.join(L, '_archive', 'qa', 'B.md'), '# older B\n');
  const r = archiveLearning({ file: path.join(L, 'qa', 'B.md'), baseDir: L, domain: 'qa', scanRoot: docs });
  assert.equal(r.archived, false);
  assert.match(r.reason, /already in the archive/);
  assert.ok(fs.existsSync(path.join(L, 'qa', 'B.md')), 'left where it was');
});
