'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  draftSessionName, draftWindowName, loadDraftState, recordSession,
  buildDraftCommand, draftPrompt, DRAFT_STEP,
} = require('./drafting');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'drafting-test-'));

// The constraint the whole design rests on: a drafting session must not occupy
// the workflow slot, because the owner drafts WITH review and execution rounds
// in between. Sharing the workflow's tmux session would also tie a
// conversation's lifetime to a run's — reaping a finished run takes its windows.
test('the drafting session is never the workflow session', () => {
  assert.equal(draftSessionName('my-project'), 'draft-my-project');
  assert.notEqual(draftSessionName('my-project'), 'my-project');
});

test('names are reduced to what tmux can address', () => {
  assert.equal(draftSessionName('My Project!'), 'draft-My-Project');
  assert.equal(draftWindowName('FAZ-294'), 'draft-FAZ-294');
  assert.equal(draftWindowName('a/b c'), 'draft-a-b-c');
  assert.ok(draftWindowName('x'.repeat(60)).length <= 24, 'window names stay addressable');
});

test('an empty or missing state file reads as empty, never throws', () => {
  const dir = tmp();
  assert.deepEqual(loadDraftState(dir), { sessions: {} });
  fs.writeFileSync(path.join(dir, 'draft-state.json'), '{not json');
  assert.deepEqual(loadDraftState(dir), { sessions: {} });
});

// Keyed by item so a second Draft click reattaches rather than opening a second
// pane against the same document.
test('recording twice for one item updates rather than duplicates', () => {
  const dir = tmp();
  recordSession(dir, 'draft-p', 'IT-1', { window: 'draft-IT-1', cli: 'claude' });
  recordSession(dir, 'draft-p', 'IT-1', { window: 'draft-IT-1', cli: 'codex' });
  const state = loadDraftState(dir);
  assert.equal(Object.keys(state.sessions).length, 1);
  assert.equal(state.sessions['IT-1'].cli, 'codex');
  assert.equal(state.sessionName, 'draft-p');
});

// Building the launch against one CLI's spellings and retrofitting the others is
// the mistake the plan calls out: the button looks CLI-agnostic in config while
// being Claude-only in practice.
test('the launch line is built per CLI, not hard-coded to claude', () => {
  const claude = buildDraftCommand({ cli: 'claude', modelFlag: ' --model opus', promptFile: '/tmp/p.txt' });
  assert.match(claude, /^claude --model opus "\$\(cat '\/tmp\/p\.txt'\)"$/);

  const codex = buildDraftCommand({ cli: 'codex', modelFlag: ' --model gpt', promptFile: '/tmp/p.txt' });
  assert.ok(codex.startsWith('codex '), 'codex takes the prompt as an argument too');

  // OpenCode reads from stdin — the only CLI that does.
  const oc = buildDraftCommand({ cli: 'opencode', dangerFlag: ' --auto', promptFile: '/tmp/p.txt' });
  assert.match(oc, /opencode run --auto < '\/tmp\/p\.txt'$/);
});

test('a launch with no CLI or no prompt file is refused rather than half-built', () => {
  assert.throws(() => buildDraftCommand({ promptFile: '/tmp/p.txt' }), /cli is required/);
  assert.throws(() => buildDraftCommand({ cli: 'claude' }), /promptFile is required/);
});

// An agent that assumes it is unattended writes the document instead of asking
// about it — the one failure drafting cannot tolerate, since this step is where
// the owner shapes the product.
test('the opening prompt says a human is present and names the item', () => {
  const p = draftPrompt({ itemId: 'IT-9', title: 'A thing' });
  assert.match(p, /IT-9/);
  assert.match(p, /A thing/);
  assert.match(p, /INTERACTIVE/);
  assert.match(p, /ask rather than assume/);
  assert.match(p, /draft_prd/);
});

test('the prompt survives an item with no title', () => {
  const p = draftPrompt({ itemId: 'IT-9' });
  assert.match(p, /IT-9/);
  assert.doesNotMatch(p, /undefined/);
});

test('drafting resolves its CLI through a real group key', () => {
  const { DEFAULT_STEP_GROUPS } = require('@build-studio/shared/step-groups');
  const group = DEFAULT_STEP_GROUPS.find(g => g.steps.includes(DRAFT_STEP));
  assert.ok(group, 'draft_prd must belong to a step group or it gets no model');
  assert.equal(group.key, 'plan');
});
