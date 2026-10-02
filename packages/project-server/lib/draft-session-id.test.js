'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { findCodexSessionId, findOpencodeSessionId, draftMarker } = require('./draft-session-id');
const { draftPrompt } = require('./drafting');

const ROOT = '/projects/example';
const SINCE = '2026-10-02T08:00:00.000Z';

/** A fake ~/.codex with rollout files laid out the way codex writes them. */
function codexHome(sessions) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-sid-'));
  for (const s of sessions) {
    const d = new Date(s.at);
    const dir = path.join(home, '.codex', 'sessions', String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
    fs.mkdirSync(dir, { recursive: true });
    const meta = { timestamp: s.at, type: 'session_meta', payload: { id: s.id, timestamp: s.at, cwd: s.cwd } };
    const msg = { type: 'event_msg', payload: { type: 'user_message', message: s.prompt } };
    fs.writeFileSync(path.join(dir, `rollout-x-${s.id}.jsonl`), `${JSON.stringify(meta)}\n${JSON.stringify(msg)}\n`);
  }
  return home;
}

test('the opening draft prompt carries the marker the lookup matches on', () => {
  assert.ok(draftPrompt({ itemId: 'EX-7', title: 'T' }).includes(draftMarker('EX-7')));
});

test('codex: finds the draft session and ignores every decoy', () => {
  const draft = draftPrompt({ itemId: 'EX-7' });
  const home = codexHome([
    { id: 'other-project', at: '2026-10-02T08:00:02.000Z', cwd: '/projects/other', prompt: draft },
    { id: 'before-launch', at: '2026-10-02T07:50:00.000Z', cwd: ROOT, prompt: draft },
    { id: 'workflow-agent', at: '2026-10-02T08:00:01.000Z', cwd: ROOT, prompt: 'You are QA. Run the tests.' },
    { id: 'the-draft', at: '2026-10-02T08:00:03.000Z', cwd: ROOT, prompt: draft },
    { id: 'later-draft', at: '2026-10-02T09:00:00.000Z', cwd: ROOT, prompt: draft },
  ]);
  const now = Date.parse('2026-10-02T10:00:00.000Z');
  assert.equal(findCodexSessionId({ projectRoot: ROOT, since: SINCE, itemId: 'EX-7', home, now }), 'the-draft');
});

test('codex: no match, a bad launch time or no item gives null rather than a guess', () => {
  const home = codexHome([{ id: 'q', at: '2026-10-02T08:00:01.000Z', cwd: ROOT, prompt: 'You are QA.' }]);
  const now = Date.parse('2026-10-02T10:00:00.000Z');
  assert.equal(findCodexSessionId({ projectRoot: ROOT, since: SINCE, itemId: 'EX-7', home, now }), null);
  assert.equal(findCodexSessionId({ projectRoot: ROOT, since: 'nonsense', itemId: 'EX-7', home, now }), null);
  assert.equal(findCodexSessionId({ projectRoot: ROOT, since: SINCE, itemId: null, home, now }), null);
});

test('opencode: lists sessions, then confirms the prompt through export', () => {
  const created = Date.parse(SINCE);
  const calls = [];
  const exec = (bin, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'session') {
      return JSON.stringify([
        { id: 'ses_other', directory: '/projects/other', created: created + 1000 },
        { id: 'ses_agent', directory: ROOT, created: created + 500 },
        { id: 'ses_draft', directory: ROOT, created: created + 2000 },
        { id: 'ses_old', directory: ROOT, created: created - 600000 },
      ]);
    }
    if (args[1] === 'ses_agent') return '{"messages":[{"text":"You are QA."}]}';
    if (args[1] === 'ses_draft') return JSON.stringify({ messages: [{ text: draftPrompt({ itemId: 'EX-7' }) }] });
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  assert.equal(findOpencodeSessionId({ projectRoot: ROOT, since: SINCE, itemId: 'EX-7', exec }), 'ses_draft');
  assert.ok(!calls.some((c) => c.includes('ses_other') || c.includes('ses_old')), 'only plausible candidates are exported');
});

test('opencode: a failing CLI gives null', () => {
  const exec = () => { throw new Error('opencode not found'); };
  assert.equal(findOpencodeSessionId({ projectRoot: ROOT, since: SINCE, itemId: 'EX-7', exec }), null);
});
