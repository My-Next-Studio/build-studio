'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const decide = require('./decide');
const { shadowGateBlocked, shadowAgentPane, shadowReportFinal, shadowBuilderRole, paneTail, resetAskedForTests } = require('./decision-points');
const { existingPaneState } = require('./agent-stalled');

const ON = { decisions: { enabled: true } };

/** A fetch that records calls and answers like OpenRouter's decisions endpoint. */
function fakeFetch(answers, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => 'nope',
      json: async () => ({ model: 'typesafe/jev-1.13-20260917', answers, usage: { input_tokens: 400, output_tokens: 20, cost: 0.00002 } }),
    };
  };
  fn.calls = calls;
  return fn;
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'decide-test-'));
const readLog = (dir) => fs.readFileSync(path.join(dir, decide.SHADOW_LOG), 'utf8').trim().split('\n').map(JSON.parse);

beforeEach(() => { decide.resetWarningsForTests(); resetAskedForTests(); });

// ── config: off unless configured, project can opt out ──────────────────────

test('decisions are off with no config, or without enabled: true', () => {
  assert.equal(decide.resolveDecisionsConfig(null, {}), null);
  assert.equal(decide.resolveDecisionsConfig({}, {}), null);
  assert.equal(decide.resolveDecisionsConfig({ decisions: {} }, {}), null);
  assert.equal(decide.resolveDecisionsConfig({ decisions: { enabled: 'yes' } }, {}), null);
});

test('enabled globally covers a project unless it opts out', () => {
  assert.ok(decide.resolveDecisionsConfig(ON, { name: 'p' }));
  assert.equal(decide.resolveDecisionsConfig(ON, { decisions: { enabled: false } }), null);
});

test('the model is pinned by default, not an alias', () => {
  const c = decide.resolveDecisionsConfig(ON, {});
  assert.equal(c.model, 'typesafe/jev-1.13');
  assert.equal(c.provider, 'openrouter');
  assert.doesNotMatch(c.model, /latest/);
});

test('an unknown provider disables decisions instead of guessing', () => {
  assert.equal(decide.resolveDecisionsConfig({ decisions: { enabled: true, provider: 'acme' } }, {}), null);
});

// ── the provider call ───────────────────────────────────────────────────────

test('decide sends Jev\'s request shape to OpenRouter and normalizes the answers', async () => {
  const fetchImpl = fakeFetch({
    a: { type: 'noul', noul: 0.12 },
    b: { type: 'choice', choice: 'x', confidence: 0.6, probabilities: { x: 0.8, y: 0.2 } },
  });
  const config = decide.resolveDecisionsConfig(ON, {});
  const r = await decide.decide({ state: 'text', questions: { a: {}, b: {} } }, { config, key: 'k', fetchImpl });
  assert.equal(fetchImpl.calls[0].url, decide.OPENROUTER_DECISIONS_URL);
  assert.equal(fetchImpl.calls[0].opts.headers.Authorization, 'Bearer k');
  assert.deepEqual(Object.keys(fetchImpl.calls[0].body).sort(), ['model', 'questions', 'state']);
  assert.equal(fetchImpl.calls[0].body.model, 'typesafe/jev-1.13');
  assert.deepEqual(r.answers.a, { type: 'noul', value: 0.12, p: 0.12 });
  assert.equal(r.answers.b.value, 'x');
  assert.equal(r.answers.b.probabilities.y, 0.2);
  assert.equal(r.model, 'typesafe/jev-1.13-20260917');
});

test('a failing provider returns null and warns once per kind of failure', async () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const config = decide.resolveDecisionsConfig(ON, {});
    const fetchImpl = fakeFetch({}, { status: 503 });
    for (let i = 0; i < 3; i++) {
      assert.equal(await decide.decide({ state: 's', questions: {} }, { config, key: 'k', fetchImpl }), null);
    }
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /HTTP 503/);
  } finally {
    console.warn = orig;
  }
});

test('a provider that never answers times out to null', async () => {
  const orig = console.warn;
  console.warn = () => {};
  try {
    const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    const config = { ...decide.resolveDecisionsConfig(ON, {}), timeoutMs: 20 };
    assert.equal(await decide.decide({ state: 's', questions: {} }, { config, key: 'k', fetchImpl: hang }), null);
  } finally {
    console.warn = orig;
  }
});

test('no key or no config means no call at all', async () => {
  const fetchImpl = fakeFetch({});
  const config = decide.resolveDecisionsConfig(ON, {});
  assert.equal(await decide.decide({ state: 's', questions: {} }, { config, key: null, fetchImpl }), null);
  assert.equal(await decide.decide({ state: 's', questions: {} }, { config: null, key: 'k', fetchImpl }), null);
  assert.equal(fetchImpl.calls.length, 0);
});

// ── language ────────────────────────────────────────────────────────────────

test('language is detected well enough to split the log', () => {
  assert.equal(decide.detectLanguage('Testerna kördes och det gick inte att starta simulatorn, så vi kan inte se resultatet för appen.'), 'sv');
  assert.equal(decide.detectLanguage('The tests ran and the simulator was not available, so this check is not complete for the app.'), 'en');
  assert.equal(decide.detectLanguage('8157/8157'), 'unknown');
});

// ── decision point 1: gate blocked, in shadow mode ──────────────────────────

const RUN = { id: 'run-1', currentStep: 'qa_validation', round: 2 };

test('the gate-blocked point records both answers, the state and the language', async () => {
  const logDir = tmpDir();
  const fetchImpl = fakeFetch({ could_not_run: { type: 'noul', noul: 0.03 } });
  const feedback = '**Tests passed:** 7/7\n**Blocking:** 1\n**Gate could not run:** N/A — suite executed fully; the report covers the run and the result for the app.';
  const rec = await shadowGateBlocked({ projectConfig: { name: 'p' }, wf: RUN, role: 'QA', feedback },
    { hub: ON, key: 'k', logDir, fetchImpl });
  assert.ok(rec);
  // The incident case: the regex now says false too (explicit negative), so both agree.
  assert.deepEqual(rec.existing, { could_not_run: false });
  assert.equal(rec.answers.could_not_run.p, 0.03);
  assert.equal(rec.point, 'gate_blocked');
  assert.equal(rec.project, 'p');
  assert.equal(rec.step, 'qa_validation');
  assert.equal(rec.lang, 'en');
  assert.equal(rec.state, feedback, 'the state is kept so the answer can be reproduced offline');
  assert.deepEqual(readLog(logDir).map((r) => r.runId), ['run-1']);
});

test('the gate-blocked point asks nothing for a non-verification step or with decisions off', async () => {
  const fetchImpl = fakeFetch({});
  const feedback = '**Gate could not run:** no browser is available';
  assert.equal(await shadowGateBlocked({ projectConfig: {}, wf: { ...RUN, currentStep: 'task_execution' }, role: 'Dev', feedback }, { hub: ON, key: 'k', logDir: tmpDir(), fetchImpl }), null);
  assert.equal(await shadowGateBlocked({ projectConfig: {}, wf: RUN, role: 'QA', feedback }, { hub: {}, key: 'k', logDir: tmpDir(), fetchImpl }), null);
  assert.equal(await shadowGateBlocked({ projectConfig: { decisions: { enabled: false } }, wf: RUN, role: 'QA', feedback }, { hub: ON, key: 'k', logDir: tmpDir(), fetchImpl }), null);
  assert.equal(await shadowGateBlocked({ projectConfig: {}, wf: RUN, role: 'QA', feedback }, { hub: ON, key: null, logDir: tmpDir(), fetchImpl }), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('a provider outage leaves no record and does not throw', async () => {
  const orig = console.warn;
  console.warn = () => {};
  try {
    const logDir = tmpDir();
    const rec = await shadowGateBlocked({ projectConfig: {}, wf: RUN, role: 'QA', feedback: '**Gate could not run:** x' },
      { hub: ON, key: 'k', logDir, fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
    assert.equal(rec, null);
    assert.equal(fs.existsSync(path.join(logDir, decide.SHADOW_LOG)), false);
  } finally {
    console.warn = orig;
  }
});

// ── decision points 2–4: what the agent's terminal shows ────────────────────

const AGENT = { role: 'QA', window: 'qa', cli: 'claude', startedAt: '2026-10-25T08:00:00.000Z' };
const LIMIT_PANE = [
  '⏺ Running the suite…',
  '',
  "You've hit your session limit · resets 10am (Europe/Stockholm)",
  '',
  '❯ ',
  '',
  '',
].join('\n');

test('the agent-pane point asks one Choice about the screen and records the pattern verdict beside it', async () => {
  const logDir = tmpDir();
  const fetchImpl = fakeFetch({ pane_state: { type: 'choice', choice: 'usage_limit', confidence: 0.9, probabilities: { usage_limit: 0.95, idle_at_prompt: 0.05 } } });
  const rec = await shadowAgentPane({ projectConfig: { name: 'p' }, wf: RUN, agent: AGENT, trigger: 'limit_detected', pane: LIMIT_PANE, limit: true },
    { hub: ON, key: 'k', logDir, fetchImpl });
  assert.equal(rec.point, 'agent_pane');
  assert.equal(rec.trigger, 'limit_detected');
  assert.deepEqual(rec.existing, { pane_state: 'usage_limit', limit: true, exited: false, stalled_reason: null });
  assert.equal(rec.answers.pane_state.value, 'usage_limit');
  const q = fetchImpl.calls[0].body.questions.pane_state;
  assert.equal(q.type, 'choice');
  assert.deepEqual(Object.keys(q.criteria).sort(), ['exited_to_shell', 'idle_at_prompt', 'login_blocked', 'usage_limit', 'waiting_for_answer', 'working']);
  assert.equal(rec.state, LIMIT_PANE.replace(/\s+$/, ''), 'trailing blank rows are not sent');
});

test('the agent-pane point asks each event once, however often the watchdog passes it', async () => {
  const fetchImpl = fakeFetch({ pane_state: { type: 'choice', choice: 'working', confidence: 1, probabilities: { working: 1 } } });
  const deps = { hub: ON, key: 'k', logDir: tmpDir(), fetchImpl };
  const ask = (over = {}) => shadowAgentPane({ projectConfig: {}, wf: RUN, agent: AGENT, trigger: 'idle_timeout', pane: 'x', ...over }, deps);
  assert.ok(await ask());
  assert.equal(await ask(), null, 'the same event again');
  assert.ok(await ask({ trigger: 'process_dead' }), 'a different event');
  assert.ok(await ask({ agent: { ...AGENT, startedAt: '2026-10-25T09:00:00.000Z' } }), 'a relaunched agent');
  assert.equal(fetchImpl.calls.length, 3);
});

test('a blank pane, or decisions off, asks nothing', async () => {
  const fetchImpl = fakeFetch({});
  assert.equal(await shadowAgentPane({ projectConfig: {}, wf: RUN, agent: AGENT, trigger: 'idle_timeout', pane: '\n\n  \n' }, { hub: ON, key: 'k', logDir: tmpDir(), fetchImpl }), null);
  assert.equal(await shadowAgentPane({ projectConfig: {}, wf: RUN, agent: AGENT, trigger: 'idle_timeout', pane: 'x' }, { hub: {}, key: 'k', logDir: tmpDir(), fetchImpl }), null);
  assert.equal(fetchImpl.calls.length, 0);
});

test('the pattern verdicts map onto pane_state, and silence-only verdicts have none', () => {
  assert.equal(existingPaneState({ limit: true, stalledReason: 'awaiting_decision' }), 'usage_limit');
  assert.equal(existingPaneState({ exited: true }), 'exited_to_shell');
  assert.equal(existingPaneState({ stalledReason: 'awaiting_decision' }), 'waiting_for_answer');
  assert.equal(existingPaneState({ stalledReason: 'auth_blocked' }), 'login_blocked');
  assert.equal(existingPaneState({ stalledReason: 'finished_not_reported' }), 'idle_at_prompt');
  assert.equal(existingPaneState({ stalledReason: 'model_stalled' }), null);
  assert.equal(existingPaneState({}), null);
});

test('paneTail keeps the last lines and drops trailing blank ones', () => {
  const pane = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n') + '\n\n\n';
  const tail = paneTail(pane, 40);
  assert.equal(tail.split('\n').length, 40);
  assert.ok(tail.endsWith('line 59'));
});

test('a shadow call cannot throw into the watchdog, even synchronously', () => {
  const hub = Object.defineProperty({}, 'decisions', { get() { throw new Error('config exploded'); } });
  let result;
  assert.doesNotThrow(() => { result = shadowAgentPane({ projectConfig: {}, wf: RUN, agent: AGENT, trigger: 'idle_timeout', pane: 'x' }, { hub, key: 'k', logDir: tmpDir(), fetchImpl: fakeFetch({}) }); });
  assert.ok(result instanceof Promise);
});

// ── decision point 5: final report, or a progress note ──────────────────────

test('the report point records the progress note the pattern refuses, beside the model\'s answer', async () => {
  const logDir = tmpDir();
  const fetchImpl = fakeFetch({ final_report: { type: 'noul', noul: 0.04 } });
  const text = 'Still running; waiting for the notification.';
  const rec = await shadowReportFinal({ projectConfig: { name: 'p' }, wf: RUN, agent: AGENT, trigger: 'idle_timeout', text },
    { hub: ON, key: 'k', logDir, fetchImpl });
  assert.equal(rec.point, 'report_final');
  assert.deepEqual(rec.existing, { final_report: false });
  assert.equal(rec.answers.final_report.p, 0.04);
  assert.equal(rec.state, text);
  assert.equal(await shadowReportFinal({ projectConfig: {}, wf: RUN, agent: AGENT, trigger: 'idle_timeout', text }, { hub: ON, key: 'k', logDir, fetchImpl }), null, 'asked once');
});

// ── decision point 6: the PRD header's builder role ─────────────────────────

const ROLES = [{ role: 'iOS Dev', skill: 'ios_dev' }, { role: 'Android Dev' }];

test('the builder-role point sends only the header, and offers the project\'s roles plus none', async () => {
  const fetchImpl = fakeFetch({ builder_role: { type: 'choice', choice: 'Android Dev', confidence: 0.8, probabilities: { 'Android Dev': 0.9, none: 0.1 } } });
  const prdText = '# PRD-046 — Android foundation\n\n**Status:** Draft\n**Role:** `Android Dev` — the Phase 1.5 track\n\n## Scope\n\nThe iOS Dev role owns the shared parts.\n';
  const rec = await shadowBuilderRole({ projectConfig: { name: 'p' }, wf: { ...RUN, currentStep: 'planning', prdPath: 'docs/prds/PRD-046.md' }, prdText, executionRoles: ROLES, resolvedRole: 'Android Dev' },
    { hub: ON, key: 'k', logDir: tmpDir(), fetchImpl });
  assert.equal(rec.point, 'builder_role');
  assert.ok(!rec.state.includes('owns the shared parts'), 'the body cannot steer the answer');
  assert.deepEqual(rec.existing, { builder_role: 'Android Dev', raw: 'Android Dev', resolves: true });
  assert.deepEqual(Object.keys(fetchImpl.calls[0].body.questions.builder_role.criteria), ['iOS Dev', 'Android Dev', 'none']);
});

test('a header that names an unknown role keeps its raw value; one that names none says none', async () => {
  const deps = () => ({ hub: ON, key: 'k', logDir: tmpDir(), fetchImpl: fakeFetch({ builder_role: { type: 'choice', choice: 'none', confidence: 1, probabilities: { none: 1 } } }) });
  const wf = { ...RUN, prdPath: 'docs/prds/x.md' };
  const unknown = await shadowBuilderRole({ projectConfig: {}, wf, prdText: '# X\n**Role:** Web Dev\n', executionRoles: ROLES }, deps());
  assert.deepEqual(unknown.existing, { builder_role: 'Web Dev', raw: 'Web Dev', resolves: false });
  const none = await shadowBuilderRole({ projectConfig: {}, wf, prdText: '# X\n**Status:** Draft\n', executionRoles: ROLES }, deps());
  assert.deepEqual(none.existing, { builder_role: 'none', raw: null, resolves: true });
  assert.equal(await shadowBuilderRole({ projectConfig: {}, wf, prdText: '# X\n', executionRoles: [] }, deps()), null, 'no roles, no question');
});
