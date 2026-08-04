'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createMonitor } = require('./monitor');

const RUNS = [
  { conclusion: 'failure', createdAt: '2026-08-04T05:22:31Z', updatedAt: '2026-08-04T05:30:00Z', databaseId: 1, event: 'schedule', status: 'completed', workflowName: 'nightly gate', url: 'u1' },
  { conclusion: 'failure', createdAt: '2026-08-03T05:28:08Z', updatedAt: '2026-08-03T05:30:00Z', databaseId: 2, event: 'schedule', status: 'completed', workflowName: 'nightly gate', url: 'u2' },
  { conclusion: 'success', createdAt: '2026-08-01T16:00:35Z', updatedAt: '2026-08-01T16:05:00Z', databaseId: 3, event: 'push', status: 'completed', displayTitle: 'fix: thing', workflowName: 'CI', url: 'u3' },
];

const ALERTS = [{
  number: 7, state: 'open', created_at: '2026-07-27T13:40:39Z', html_url: 'h7',
  dependency: { package: { name: 'lodash' }, scope: 'runtime' },
  security_advisory: { ghsa_id: 'GHSA-1', severity: 'high', summary: 'prototype pollution' },
}];

/** Records every gh invocation so call COUNT — the whole point — is assertable. */
function fakeGh({ runs = RUNS, alerts = ALERTS, alertsError = null, jobsError = false } = {}) {
  const calls = [];
  const exec = async (bin, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'run' && args[1] === 'list') return { stdout: JSON.stringify(runs) };
    if (args[0] === 'run' && args[1] === 'view') {
      if (jobsError) throw new Error('jobs unavailable');
      return { stdout: JSON.stringify({ jobs: [{ name: 'build', status: 'completed', conclusion: 'success' }] }) };
    }
    if (args[0] === 'api') {
      if (alertsError) { const e = new Error('gh failed'); e.stderr = alertsError; throw e; }
      return { stdout: JSON.stringify(alerts) };
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { exec, calls };
}

const CONFIG = { name: 'fazon', deployment: { repo: 'o/r' } };

test('a project without deployment.repo makes no GitHub calls at all', async () => {
  const { exec, calls } = fakeGh();
  const m = createMonitor({ name: 'p' }, { execFileAsync: exec });
  m.prime();
  m.getCi(); m.getAlerts(); m.getSummary();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, [], 'nothing to ask GitHub about — do not ask');
  assert.equal(m.getCi().configured, false);
  assert.equal(m.getAlerts().alerts.length, 0);
});

test('one run list serves both the CI light and the scheduled alerts', async () => {
  const { exec, calls } = fakeGh();
  const m = createMonitor(CONFIG, { execFileAsync: exec });
  m.prime();
  await new Promise((r) => setTimeout(r, 10));

  const ci = m.getCi();
  assert.equal(ci.run.conclusion, 'success', 'CI tracks the push run, not the failing cron');
  assert.equal(ci.run.event, 'push');

  const al = m.getAlerts();
  assert.equal(al.alerts.length, 2, 'the nightly failure + the lodash advisory');
  assert.ok(al.alerts.some((a) => a.source === 'schedule'));

  const runLists = calls.filter((c) => c.startsWith('run list'));
  assert.equal(runLists.length, 1, 'asking twice would double the API cost for the same data');
});

test('repeated reads are served from cache, not from gh', async () => {
  const { exec, calls } = fakeGh();
  const m = createMonitor(CONFIG, { execFileAsync: exec });
  m.prime();
  await new Promise((r) => setTimeout(r, 10));
  const before = calls.length;

  // Simulates the hub's 6-second poll hitting this repeatedly.
  for (let i = 0; i < 30; i++) { m.getSummary(); }
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.length, before, '30 polls must cost zero additional gh invocations');
});

test('a configured ci_workflow narrows the light but not the alert list', async () => {
  const { exec } = fakeGh();
  const m = createMonitor(
    { name: 'p', deployment: { repo: 'o/r', ci_workflow: 'CI' } },
    { execFileAsync: exec }
  );
  m.prime();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(m.getCi().run.workflowName, 'CI');
  // The scheduled gate lives in a different workflow and must still be seen.
  assert.ok(m.getAlerts().alerts.some((a) => a.title === 'nightly gate'));
});

test('disabled dependency alerts surface as an info row, not as an error', async () => {
  const { exec } = fakeGh({
    alertsError: 'gh: Dependabot alerts are disabled for this repository. (HTTP 403)\ngh: needs the "admin:repo_hook" scope',
  });
  const m = createMonitor(CONFIG, { execFileAsync: exec });
  m.prime();
  await new Promise((r) => setTimeout(r, 10));

  const al = m.getAlerts();
  assert.equal(al.error, null, 'an expected answer is not a fault');
  const notEnabled = al.alerts.find((a) => a.kind === 'not-enabled');
  assert.ok(notEnabled);
  assert.equal(notEnabled.severity, 'info');
  assert.equal(al.counts.actionable, 1, 'only the nightly gate counts as actionable');
});

test('a genuine alerts failure is reported without losing the scheduled alerts', async () => {
  const { exec } = fakeGh({ alertsError: 'gh: Bad credentials (HTTP 401)' });
  const m = createMonitor(CONFIG, { execFileAsync: exec });
  m.prime();
  await new Promise((r) => setTimeout(r, 10));

  const al = m.getAlerts();
  assert.match(al.error, /no-auth/);
  assert.ok(al.alerts.some((a) => a.source === 'schedule'), 'one source failing must not blank the other');
});

test('losing the per-job detail keeps the run itself', async () => {
  const { exec } = fakeGh({ jobsError: true });
  const m = createMonitor(CONFIG, { execFileAsync: exec });
  m.prime();
  await new Promise((r) => setTimeout(r, 10));
  const ci = m.getCi();
  assert.ok(ci.run, 'the light matters more than the breakdown under it');
  assert.deepEqual(ci.jobs, []);
});

test('the summary is the compact shape the cross-project poll folds in', async () => {
  const { exec } = fakeGh();
  const m = createMonitor(CONFIG, { execFileAsync: exec });
  m.prime();
  await new Promise((r) => setTimeout(r, 10));
  const s = m.getSummary();
  assert.equal(s.configured, true);
  assert.equal(s.ci.conclusion, 'success');
  assert.equal(s.counts.actionable, 2);
});

test('no runs at all yields a null light rather than a crash', async () => {
  const { exec } = fakeGh({ runs: [] });
  const m = createMonitor(CONFIG, { execFileAsync: exec });
  m.prime();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(m.getCi().run, null);
  assert.equal(m.getCi().configured, true);
});
