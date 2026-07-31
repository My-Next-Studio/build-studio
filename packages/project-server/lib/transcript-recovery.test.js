'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  slugCandidates, findTranscript, extractFinalAssistantText, recoverAgentOutput,
} = require('./transcript-recovery');

/** Build a throwaway ~/.claude/projects tree. */
function fakeHome(entries) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-transcript-'));
  for (const [dir, file, contents] of entries) {
    const d = path.join(home, '.claude', 'projects', dir);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, file), contents);
  }
  return home;
}

const line = (o) => JSON.stringify(o) + '\n';
const assistantText = (t) => line({ type: 'assistant', message: { content: [{ type: 'text', text: t }] } });
const toolUse = () => line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } });

test('slug candidates cover both CLI encodings', () => {
  // This machine carries both spellings for the same project, from different
  // CLI versions — so a single derived name is not enough on its own.
  const c = slugCandidates('/Volumes/Extern/projects/sickla_tunneln');
  assert.ok(c.includes('-Volumes-Extern-projects-sickla_tunneln'));
  assert.ok(c.includes('-Volumes-Extern-projects-sickla-tunneln'));
});

test('a dot in a worktree path becomes a dash', () => {
  // /tmp/.worktrees/x encodes as tmp--worktrees-x — the slash and the dot each
  // contribute a dash.
  assert.ok(slugCandidates('/Volumes/Extern/projects/deskrhythm/tmp/.worktrees/qa-tests-DR-091')
    .includes('-Volumes-Extern-projects-deskrhythm-tmp--worktrees-qa-tests-DR-091'));
});

test('the final assistant text is the report, not the last line', () => {
  // Real transcripts end with `system` records written after the assistant's
  // closing message, so reading the tail returns nothing useful.
  const jsonl = assistantText('early') + toolUse() + assistantText('THE REPORT')
    + line({ type: 'system', message: {} }) + line({ type: 'system', message: {} });
  assert.equal(extractFinalAssistantText(jsonl), 'THE REPORT');
});

test('blank trailing text does not mask the real report', () => {
  const jsonl = assistantText('THE REPORT') + assistantText('   ');
  assert.equal(extractFinalAssistantText(jsonl), 'THE REPORT');
});

test('a truncated final line does not lose the rest', () => {
  // The CLI may be mid-write; a partial JSON line must be skipped, not fatal.
  const jsonl = assistantText('THE REPORT') + '{"type":"assist';
  assert.equal(extractFinalAssistantText(jsonl), 'THE REPORT');
});

test('a transcript with no prose yields null', () => {
  assert.equal(extractFinalAssistantText(toolUse()), null);
  assert.equal(extractFinalAssistantText(''), null);
  assert.equal(extractFinalAssistantText(null), null);
});

test('finds a transcript through the derived directory name', () => {
  const home = fakeHome([['-tmp-proj', 'abc-123.jsonl', assistantText('done')]]);
  assert.ok(findTranscript('abc-123', '/tmp/proj', { home }));
});

test('finds a transcript by session id when the directory name does not match', () => {
  // The version-proof half: a session id is a UUID, so a scan is unambiguous
  // and does not care how the CLI spelled the path.
  const home = fakeHome([['-some-entirely-other-name', 'abc-123.jsonl', assistantText('done')]]);
  assert.ok(findTranscript('abc-123', '/tmp/proj', { home }));
});

test('missing session id, missing file, and missing root all yield null', () => {
  const home = fakeHome([['-tmp-proj', 'abc-123.jsonl', assistantText('done')]]);
  assert.equal(findTranscript(null, '/tmp/proj', { home }), null);
  assert.equal(findTranscript('nope', '/tmp/proj', { home }), null);
  assert.equal(findTranscript('abc-123', '/tmp/proj', { home: path.join(home, 'absent') }), null);
});

test('recoverAgentOutput returns the report with its length', () => {
  const home = fakeHome([['-tmp-proj', 'abc-123.jsonl', assistantText('**All issues addressed:** yes')]]);
  const r = recoverAgentOutput({ cliSessionId: 'abc-123', agentCwd: '/tmp/proj' }, { home });
  assert.equal(r.text, '**All issues addressed:** yes');
  assert.equal(r.chars, r.text.length);
  assert.match(r.transcript, /abc-123\.jsonl$/);
});

test('an agent with no CLI session id is not recoverable', () => {
  // codex agents have no pinned session; recovery simply does not apply.
  assert.equal(recoverAgentOutput({ agentCwd: '/tmp/proj' }), null);
  assert.equal(recoverAgentOutput(null), null);
});

test('a transcript that exists but holds no report is not recoverable', () => {
  const home = fakeHome([['-tmp-proj', 'abc-123.jsonl', toolUse()]]);
  assert.equal(recoverAgentOutput({ cliSessionId: 'abc-123', agentCwd: '/tmp/proj' }, { home }), null);
});
