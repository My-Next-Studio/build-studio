'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  draftSessionName, draftWindowName, loadDraftState, recordSession,
  buildDraftCommand, draftPrompt, DRAFT_STEP, quoteFlagValues,
  ensureIgnored, IGNORE_RULE,
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

test('session names are reduced to what tmux can address', () => {
  assert.equal(draftSessionName('My Project!'), 'draft-My-Project');
});

// One window per PROJECT, not per item. The owner's boundary is per project, cut
// by hand when the subject changes, and the original request was continuity
// across drafts — a window per item would give every draft a fresh conversation
// that has to be told the same things again.
test('the drafting window is per project, so drafts share one conversation', () => {
  assert.equal(draftWindowName(), 'draft');
  assert.equal(draftWindowName('FAZ-294'), 'draft', 'the item does not name the window');
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
  assert.match(claude, /^claude --model 'opus' "\$\(cat '\/tmp\/p\.txt'\)"$/);

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

// The skill IS the method for this step, so the reference has to be the form the
// resolver can actually find. `.claude/skills/draft_prd/` is a SKILL; writing it
// as `/draft_prd` resolves against `.claude/commands/`, finds nothing, and
// inlines nothing — leaving a non-Claude agent to invent its own approach to the
// one step where that is least acceptable.
test('the skill is referenced in the form the resolver resolves', () => {
  const skills = require('./agent-skills');
  const refs = skills.referencedNames(draftPrompt({ itemId: 'IT-9' }));
  assert.deepEqual(refs.skills, ['draft_prd'], 'must be seen as a SKILL');
  assert.deepEqual(refs.commands, [], 'and not as a command');
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

// The pane's shell is zsh, and zsh GLOBS unquoted arguments. Model ids carry
// brackets, so `--model claude-opus-5[1m]` died with `no matches found` before
// the CLI started — the pane sat at a bare prompt and the button looked inert.
// Seen on the first real use (FAZ-318, 2026-09-17). bash passes an unmatched
// glob through literally, which is why the workflow launcher — which runs a
// script under bash — never hit it.
test('a bracketed model id survives the shell', () => {
  const cmd = buildDraftCommand({
    cli: 'claude', modelFlag: ' --model claude-opus-5[1m]', effortFlag: ' --effort medium',
    promptFile: '/tmp/p.txt',
  });
  assert.match(cmd, /--model 'claude-opus-5\[1m\]'/);
  assert.match(cmd, /--effort 'medium'/);
  // And prove it against the real shell rather than trusting the pattern.
  const { execFileSync } = require('node:child_process');
  const echoed = execFileSync('zsh', ['-c', `echo ${cmd.replace(/ "\$\(cat.*$/, '')}`]).toString();
  assert.match(echoed, /claude-opus-5\[1m\]/);
});

test('flag names are left alone and values with quotes are escaped', () => {
  assert.equal(quoteFlagValues(' --model a-b'), " --model 'a-b'");
  assert.equal(quoteFlagValues(''), '');
  assert.match(quoteFlagValues(" --model it's"), /--model 'it'/);
});

// Onboarding writes the ignore rule, but only at onboarding — a project that
// predates drafting never got it, and its first session left an untracked state
// file for the next sweep-all commit to pick up.
test('the state file is ignored before it is first written', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\n');
  assert.equal(ensureIgnored(dir), true, 'changed, so the caller knows to commit it');
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.match(gi, /^node_modules$/m, 'existing rules are kept');
  assert.ok(gi.split('\n').includes(IGNORE_RULE));
});

test('ensuring the rule twice adds it once and reports no change', () => {
  const dir = tmp();
  ensureIgnored(dir);
  assert.equal(ensureIgnored(dir), false);
  const gi = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
  assert.equal(gi.split('\n').filter((l) => l === IGNORE_RULE).length, 1);
});

test('a .gitignore with no trailing newline is not corrupted', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '.gitignore'), 'dist');
  ensureIgnored(dir);
  assert.deepEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n').filter(Boolean), ['dist', IGNORE_RULE]);
});

test('continuePrompt: the same unfinished item continues, a different item is next', () => {
  const { continuePrompt } = require('./drafting');
  const same = continuePrompt({ itemId: 'X-7', title: 'Thing', sameItem: true });
  assert.match(same, /^Continue drafting the PRD for backlog item X-7 — "Thing" where we left off\./);
  assert.doesNotMatch(same, /Next:/);
  assert.match(continuePrompt({ itemId: 'X-8' }), /^Next: draft a PRD for backlog item X-8\./);
});
