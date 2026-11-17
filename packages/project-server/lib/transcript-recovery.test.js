'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  slugCandidates, findTranscript, extractFinalAssistantText, extractCodexFinalMessage,
  recoverAgentOutput, readFinalAssistantText, looksLikeReport,
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

test('readFinalAssistantText returns the last words even when they are not a report', () => {
  // The shadow layer is asked about exactly these: a progress note the
  // pattern rightly refuses to offer for Recover.
  const home = fakeHome([['-tmp-proj', 'abc-123.jsonl', assistantText('Still running; waiting for the notification.')]]);
  const agent = { cliSessionId: 'abc-123', agentCwd: '/tmp/proj' };
  assert.equal(recoverAgentOutput(agent, { home }), null);
  const r = readFinalAssistantText(agent, { home });
  assert.equal(r.text, 'Still running; waiting for the notification.');
  assert.match(r.transcript, /abc-123\.jsonl$/);
  assert.equal(readFinalAssistantText(null), null);
});

test('an agent with no CLI session id is not recoverable', () => {
  assert.equal(recoverAgentOutput({ agentCwd: '/tmp/proj' }), null);
  assert.equal(recoverAgentOutput(null), null);
});

// ── codex rollouts ──────────────────────────────────────────────────────────
// phoclub PHO-014, 2026-11-17: a codex UX reviewer printed a complete approval
// and exited without the curl. The report sat in its rollout; Recover read only
// Claude transcripts, so the agent was failed instead.

const codexRow = (type, payload) => line({ timestamp: '2026-11-17T19:06:59.000Z', type, payload });
const codexMessage = (t) => codexRow('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] });
const codexComplete = (t) => codexRow('event_msg', { type: 'task_complete', last_agent_message: t });
const UX_REPORT = '## Review: UX\n\n**Approved:** yes\n**Blocking:** 0 | **Medium:** 0 | **Low:** 0\n\n### Findings\nNone.';

function fakeCodexHome(sessionId, contents) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-codex-'));
  const dir = path.join(home, '.codex', 'sessions', '2026', '11', '17');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-11-17T20-06-30-${sessionId}.jsonl`);
  fs.writeFileSync(file, contents);
  return { home, file };
}

test('codex: task_complete is the report, over an earlier assistant message', () => {
  const jsonl = codexMessage('Reading the diff first.') + codexComplete(UX_REPORT)
    + codexRow('event_msg', { type: 'token_count', info: {} });
  assert.equal(extractCodexFinalMessage(jsonl), UX_REPORT);
});

test('codex: a rollout cut off before task_complete falls back to the last message', () => {
  const jsonl = codexMessage('early') + codexMessage(UX_REPORT) + '{"type":"event_m';
  assert.equal(extractCodexFinalMessage(jsonl), UX_REPORT);
  assert.equal(extractCodexFinalMessage(codexRow('event_msg', { type: 'token_count' })), null);
});

test('codex: the report is recovered from the rollout the watchdog recorded', () => {
  const { file } = fakeCodexHome('01a1eae7', codexMessage('Reading.') + codexComplete(UX_REPORT));
  const r = recoverAgentOutput({ cli: 'codex', codexRolloutPath: file, agentCwd: '/tmp/proj' });
  assert.equal(r.text, UX_REPORT);
  assert.equal(r.transcript, file);
});

test('codex: without a recorded path, the rollout is found by session id', () => {
  const { home, file } = fakeCodexHome('01a1eae7-4fc5', codexComplete(UX_REPORT));
  const r = recoverAgentOutput({ cli: 'codex', cliSessionId: '01a1eae7-4fc5' }, { home });
  assert.equal(r.transcript, file);
});

test('codex: a progress note is not offered as a report', () => {
  const { file } = fakeCodexHome('01a1eae7', codexComplete('Still running; waiting for the suite.'));
  assert.equal(recoverAgentOutput({ cli: 'codex', codexRolloutPath: file }), null);
  assert.equal(readFinalAssistantText({ cli: 'codex', codexRolloutPath: file }).text, 'Still running; waiting for the suite.');
});

test('codex: no rollout means nothing to recover', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-codex-empty-'));
  assert.equal(recoverAgentOutput({ cli: 'codex' }, { home }), null);
  assert.equal(recoverAgentOutput({ cli: 'codex', codexRolloutPath: path.join(home, 'missing.jsonl') }, { home }), null);
});

test('a transcript that exists but holds no report is not recoverable', () => {
  const home = fakeHome([['-tmp-proj', 'abc-123.jsonl', toolUse()]]);
  assert.equal(recoverAgentOutput({ cliSessionId: 'abc-123', agentCwd: '/tmp/proj' }, { home }), null);
});

test('a one-line status message is not a report (fazon FAZ-376)', () => {
  const status = 'Still running; waiting for the notification.';
  assert.equal(looksLikeReport(status), false);
  const home = fakeHome([['-tmp-proj', 'abc-123.jsonl', assistantText(status)]]);
  assert.equal(recoverAgentOutput({ cliSessionId: 'abc-123', agentCwd: '/tmp/proj' }, { home }), null);
});

test('report shapes: step markers, report headings, a tasks block, or substantial prose', () => {
  assert.ok(looksLikeReport('**Approved:** no\n**Blocking:**\n- broken link'));
  assert.ok(looksLikeReport('**Committed:** a1b2c3d'));
  assert.ok(looksLikeReport('**Gate could not run:** dev server would not start'));
  assert.ok(looksLikeReport('## Summary\nDid the thing.'));
  assert.ok(looksLikeReport('```json\n{ "tasks": [] }\n```'));
  assert.ok(looksLikeReport('word '.repeat(200)));
  assert.equal(looksLikeReport('Done — tests pass.'), false);
});
