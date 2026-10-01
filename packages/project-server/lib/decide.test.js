'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const decide = require('./decide');
const { shadowGateBlocked } = require('./decision-points');

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

beforeEach(() => decide.resetWarningsForTests());

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
