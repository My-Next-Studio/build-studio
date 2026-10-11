'use strict';

// The work queue's model: which phase an item takes next, when a started
// phase counts as finished, the current entry's state, and the link from a
// started run back to its entry.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const wq = require('./work-queue');

const story = (status, extra = {}) => ({ id: 'EX-001', type: 'Feature', status, ...extra });

test('the next phase follows the item: no PRD → draft, Drafted → review, Reviewed → execute, a bug → bugfix', () => {
  assert.deepEqual(wq.nextAction(story('Backlog')), { action: 'draft' });
  assert.deepEqual(wq.nextAction(story('Drafted', { prd: 'docs/prds/PRD-1.md' })), { action: 'review' });
  assert.deepEqual(wq.nextAction(story('Reviewed', { prd: 'docs/prds/PRD-1.md' })), { action: 'execute' });
  assert.deepEqual(wq.nextAction({ id: 'EX-002', type: 'Bug', status: 'Backlog' }), { action: 'bugfix' });
});

test('a named phase wins, and an item with nothing left says why', () => {
  assert.deepEqual(wq.nextAction(story('Backlog'), 'review'), { action: 'review' });
  assert.match(wq.nextAction(story('Implemented', { prd: 'x' })).reason, /"Implemented": nothing left/);
  assert.match(wq.nextAction(null).reason, /no longer exists/);
  assert.match(wq.nextAction({ id: 'EX-002', type: 'Bug', status: 'Fixing' }).reason, /starts from Backlog or Blocked/);
});

test('a phase is finished only by the item state it produces', () => {
  assert.equal(wq.phaseFinished('draft', story('Drafted', { prd: 'x' })), true);
  assert.equal(wq.phaseFinished('draft', story('Backlog')), false);
  assert.equal(wq.phaseFinished('review', story('Reviewed')), true);
  assert.equal(wq.phaseFinished('review', story('Drafted')), false);
  assert.equal(wq.phaseFinished('execute', story('Implemented')), true);
  assert.equal(wq.phaseFinished('execute', story('Reviewed')), false);
  assert.equal(wq.phaseFinished('bugfix', { status: 'Done' }), true);
  assert.equal(wq.phaseFinished('bugfix', { status: 'Fixing' }), false);
});

test('the current entry reads its run: running, waiting, ready to merge, finished, stopped', () => {
  const current = { id: 'e1', item: 'EX-001', action: 'execute', run: { kind: 'workflow', id: 'wf-1' } };
  const wf = (step) => ({ id: 'wf-1', currentStep: step });
  assert.equal(wq.currentState(current, { wf: wf('task_execution'), item: story('Reviewed') }).state, 'running');
  assert.equal(wq.currentState(current, { wf: wf('qa_validation'), item: story('Reviewed'), needsAttention: { title: 'held' } }).state, 'waiting_for_owner');
  assert.equal(wq.currentState(current, { wf: wf('merge_to_main'), item: story('Reviewed') }).state, 'ready_to_merge');
  assert.equal(wq.currentState(current, { wf: wf('completed'), item: story('Implemented') }).state, 'finished');
  // The run is gone: its phase decides.
  assert.equal(wq.currentState(current, { wf: null, item: story('Implemented') }).state, 'finished');
  assert.equal(wq.currentState(current, { wf: null, item: story('Reviewed') }).state, 'stopped');
});

test('a draft entry: running while its agent runs, finished once the item has a PRD', () => {
  const current = { id: 'e1', item: 'EX-001', action: 'draft', run: { kind: 'draft', itemId: 'EX-001' } };
  assert.equal(wq.currentState(current, { draft: { agentRunning: true }, item: story('Backlog') }).state, 'running');
  assert.equal(wq.currentState(current, { draft: { agentRunning: false, session: { endedAt: 'x' } }, item: story('Drafted', { prd: 'p' }) }).state, 'finished');
  assert.equal(wq.currentState(current, { draft: { agentRunning: false, session: { endedAt: 'x' } }, item: story('Backlog') }).state, 'stopped');
});

test('moving and inserting keep every entry exactly once', () => {
  const list = ['a', 'b', 'c'].map((id) => ({ id }));
  assert.deepEqual(wq.moveTo(list, 'c', 0).map((e) => e.id), ['c', 'a', 'b']);
  assert.deepEqual(wq.moveTo(list, 'a', 99).map((e) => e.id), ['b', 'c', 'a']);
  assert.equal(wq.moveTo(list, 'zz', 0), null);
  assert.deepEqual(wq.insertAt(list, { id: 'x' }, 1).map((e) => e.id), ['a', 'x', 'b', 'c']);
  assert.deepEqual(wq.insertAt(list, { id: 'x' }).map((e) => e.id), ['a', 'b', 'c', 'x']);
});

test('a started run takes its entry: the named one, else the first pending for the item', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-queue-'));
  try {
    const a = wq.newEntry({ item: 'EX-001' });
    const b = wq.newEntry({ item: 'EX-002' });
    const c = wq.newEntry({ item: 'EX-001', action: 'execute' });
    wq.saveQueue(dir, { v: 1, current: null, pending: [a, b, c] });

    const linked = wq.linkStartedRun(dir, { itemId: 'EX-001', action: 'review', run: { kind: 'workflow', id: 'wf-1' } });
    assert.equal(linked.id, a.id);
    let q = wq.loadQueue(dir);
    assert.equal(q.current.id, a.id);
    assert.equal(q.current.action, 'review');
    assert.deepEqual(q.pending.map((e) => e.id), [b.id, c.id]);

    // The next start replaces the current entry: no history is kept.
    wq.linkStartedRun(dir, { itemId: 'EX-001', entryId: c.id, action: 'execute', run: { kind: 'workflow', id: 'wf-2' } });
    q = wq.loadQueue(dir);
    assert.equal(q.current.id, c.id);
    assert.deepEqual(q.pending.map((e) => e.id), [b.id]);

    assert.equal(wq.linkStartedRun(dir, { itemId: 'EX-404', action: 'review', run: {} }), null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable queue file reads as an empty queue', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'work-queue-'));
  try {
    fs.writeFileSync(path.join(dir, 'work-queue.json'), '{ not json');
    assert.deepEqual(wq.loadQueue(dir), { v: 1, current: null, pending: [] });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
