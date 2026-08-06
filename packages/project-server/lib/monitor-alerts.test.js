'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  latestPushRun, resolveWorkflowName, deriveScheduledAlerts, deriveDependabotAlerts,
  classifyAlertsError, notEnabledAlert, autofixDisabledAlert, sortAlerts, countBySeverity,
  isDependabotPr, parseBumpTitle, classifyBump, withFixReadiness, countReadyToMerge,
} = require('./monitor-alerts');

// Trimmed from a real `gh run list --json event,conclusion,status,workflowName,
// databaseId,createdAt,url` against a managed project (2026-08-04). Newest
// first, as gh returns it. This project is the live mis-attribution case: its
// three most recent runs are a FAILING nightly gate, while its push CI is green.
const RUNS = [
  { conclusion: 'failure', createdAt: '2026-08-04T05:22:31Z', databaseId: 30880489626, event: 'schedule', status: 'completed', url: 'https://github.com/o/r/actions/runs/30880489626', workflowName: 'Catalogue staleness gate' },
  { conclusion: 'failure', createdAt: '2026-08-03T05:28:08Z', databaseId: 30787246913, event: 'schedule', status: 'completed', url: 'https://github.com/o/r/actions/runs/30787246913', workflowName: 'Catalogue staleness gate' },
  { conclusion: 'failure', createdAt: '2026-08-02T05:26:06Z', databaseId: 30734117421, event: 'schedule', status: 'completed', url: 'https://github.com/o/r/actions/runs/30734117421', workflowName: 'Catalogue staleness gate' },
  { conclusion: 'success', createdAt: '2026-08-01T16:00:35Z', databaseId: 30707179845, event: 'push', status: 'completed', url: 'https://github.com/o/r/actions/runs/30707179845', workflowName: 'Docs CI' },
  { conclusion: 'success', createdAt: '2026-08-01T06:06:40Z', databaseId: 30687109916, event: 'dynamic', status: 'completed', url: 'https://github.com/o/r/actions/runs/30687109916', workflowName: 'Dependabot Updates' },
  { conclusion: 'success', createdAt: '2026-08-01T05:26:08Z', databaseId: 30685823785, event: 'schedule', status: 'completed', url: 'https://github.com/o/r/actions/runs/30685823785', workflowName: 'Catalogue staleness gate' },
  { conclusion: 'failure', createdAt: '2026-07-31T16:43:06Z', databaseId: 30648250266, event: 'dynamic', status: 'completed', url: 'https://github.com/o/r/actions/runs/30648250266', workflowName: 'Dependabot Updates' },
];

// Real shape of GET /repos/{o}/{r}/dependabot/alerts?state=open (2026-08-04).
const DEPENDABOT = [
  {
    number: 50, state: 'open', created_at: '2026-07-27T13:40:39Z',
    html_url: 'https://github.com/o/r/security/dependabot/50',
    dependency: { package: { ecosystem: 'npm', name: 'postcss' }, scope: 'runtime' },
    security_advisory: { ghsa_id: 'GHSA-r28c-9q8g-f849', severity: 'high', summary: 'PostCSS: Path Traversal in sourceMappingURL' },
  },
  {
    number: 49, state: 'open', created_at: '2026-07-27T13:40:39Z',
    html_url: 'https://github.com/o/r/security/dependabot/49',
    dependency: { package: { ecosystem: 'npm', name: 'postcss' }, scope: 'runtime' },
    security_advisory: { ghsa_id: 'GHSA-xxxx', severity: 'moderate', summary: 'PostCSS: Arbitrary file read' },
  },
];

test('the CI light tracks the latest PUSH run, not simply the latest run', () => {
  // The whole mis-attribution fix: the three newest runs are a failing cron.
  const run = latestPushRun(RUNS);
  assert.equal(run.workflowName, 'Docs CI');
  assert.equal(run.conclusion, 'success');
  assert.equal(run.event, 'push');
});

test('a manual re-run counts as a push run; Dependabot\'s own updater does not', () => {
  assert.equal(latestPushRun([{ event: 'workflow_dispatch', conclusion: 'failure' }]).conclusion, 'failure');
  // `dynamic` is Dependabot Updates — nobody pushed, and it is not CI.
  assert.equal(latestPushRun([{ event: 'dynamic', conclusion: 'failure' }]), null);
  assert.equal(latestPushRun([]), null);
  assert.equal(latestPushRun(null), null);
});

test('a ci_workflow FILENAME resolves to the display name runs are tagged with', () => {
  // The real shape: config says `deploy-pages.yml`, gh reports `Deploy Pages`.
  // Comparing the configured string to workflowName matches nothing, which
  // blanks the CI light — the regression this function exists to prevent.
  const workflows = [
    { name: 'CI', path: '.github/workflows/ci.yml', id: 1 },
    { name: 'Deploy Pages', path: '.github/workflows/deploy-pages.yml', id: 2 },
  ];
  assert.equal(resolveWorkflowName('deploy-pages.yml', workflows), 'Deploy Pages');
  assert.equal(resolveWorkflowName('.github/workflows/deploy-pages.yml', workflows), 'Deploy Pages');
  // A display name is the other legal spelling and must keep working.
  assert.equal(resolveWorkflowName('Deploy Pages', workflows), 'Deploy Pages');
});

test('an unresolvable workflow yields null rather than a wrong guess', () => {
  // Deriving a name from a filename would be wrong: "Deploy to Pages" can live
  // in deploy-pages.yml. Better to fall back than to invent a match.
  assert.equal(resolveWorkflowName('nope.yml', [{ name: 'CI', path: 'ci.yml' }]), null);
  assert.equal(resolveWorkflowName('x.yml', []), null);
  assert.equal(resolveWorkflowName('', [{ name: 'CI', path: 'ci.yml' }]), null);
  assert.equal(resolveWorkflowName('x.yml', null), null);
});

test('a failing nightly gate raises one alert, not one per failed night', () => {
  const alerts = deriveScheduledAlerts(RUNS, 'fazon');
  assert.equal(alerts.length, 1, 'three consecutive failures are ONE thing wrong');
  assert.equal(alerts[0].title, 'Catalogue staleness gate');
  assert.equal(alerts[0].project, 'fazon');
  assert.equal(alerts[0].id, 'schedule:Catalogue staleness gate');
});

test('the streak drives severity and reads in the detail line', () => {
  const [a] = deriveScheduledAlerts(RUNS, 'p');
  assert.equal(a.severity, 'high');
  assert.match(a.detail, /3 consecutive/);

  const oneFailure = [
    { event: 'schedule', status: 'completed', conclusion: 'failure', workflowName: 'nightly', createdAt: 'x' },
    { event: 'schedule', status: 'completed', conclusion: 'success', workflowName: 'nightly', createdAt: 'y' },
  ];
  const [b] = deriveScheduledAlerts(oneFailure, 'p');
  // Reported, not suppressed — the next data point is 24 hours away.
  assert.equal(b.severity, 'moderate');
  assert.match(b.detail, /last scheduled run failed/);
});

test('a scheduled workflow whose latest run passed raises nothing', () => {
  const recovered = [
    { event: 'schedule', status: 'completed', conclusion: 'success', workflowName: 'nightly', createdAt: 'z' },
    { event: 'schedule', status: 'completed', conclusion: 'failure', workflowName: 'nightly', createdAt: 'y' },
  ];
  // This IS the auto-clear: nothing to reconcile, the alert just stops existing.
  assert.deepEqual(deriveScheduledAlerts(recovered, 'p'), []);
});

test('a scheduled run still in progress has not failed yet', () => {
  const running = [
    { event: 'schedule', status: 'in_progress', conclusion: null, workflowName: 'nightly', createdAt: 'z' },
    { event: 'schedule', status: 'completed', conclusion: 'failure', workflowName: 'nightly', createdAt: 'y' },
  ];
  const [a] = deriveScheduledAlerts(running, 'p');
  assert.ok(a, 'the last COMPLETED run still failed, so the condition holds');
  assert.match(a.detail, /last scheduled run failed/);
});

test('a failing Dependabot Updates run is not a scheduled alert', () => {
  // It is `event: dynamic`, and RUNS contains a failed one.
  const alerts = deriveScheduledAlerts(RUNS, 'p');
  assert.ok(!alerts.some((a) => a.title === 'Dependabot Updates'));
});

test('advisories key on the alert number, so a second advisory for one package survives', () => {
  const alerts = deriveDependabotAlerts(DEPENDABOT, 'build-studio');
  assert.equal(alerts.length, 2, 'two postcss advisories must not collapse into one');
  assert.deepEqual(alerts.map((a) => a.id), ['dependabot:50', 'dependabot:49']);
  assert.deepEqual(alerts.map((a) => a.severity), ['high', 'moderate']);
});

test('an advisory carries scope and GHSA id, since runtime-vs-build is the first triage question', () => {
  const [a] = deriveDependabotAlerts(DEPENDABOT, 'p');
  assert.match(a.title, /postcss/);
  assert.match(a.detail, /runtime dependency/);
  assert.match(a.detail, /GHSA-r28c-9q8g-f849/);
  assert.equal(a.url, 'https://github.com/o/r/security/dependabot/50');
});

test('closed alerts are excluded, and a junk severity degrades rather than throws', () => {
  const mixed = [
    { number: 1, state: 'fixed', security_advisory: { severity: 'high' }, dependency: {} },
    { number: 2, state: 'open', security_advisory: { severity: 'WEIRD' }, dependency: {} },
    { number: 3, state: 'open', dependency: {} },
  ];
  const alerts = deriveDependabotAlerts(mixed, 'p');
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].severity, 'moderate');
  assert.match(alerts[0].title, /unknown package/);
});

test('a 403 for a disabled feature is classified from the body, not from gh\'s scope hint', () => {
  // gh appends "This API operation needs the admin:repo_hook scope" to this
  // 403. It is wrong — the same token reads alerts fine where the feature is
  // on. Classifying on that hint sends you refreshing scopes for nothing.
  const real = 'gh: Dependabot alerts are disabled for this repository. (HTTP 403)\n'
    + 'gh: This API operation needs the "admin:repo_hook" scope.';
  assert.equal(classifyAlertsError(real), 'disabled');

  assert.equal(classifyAlertsError('gh: Not Found (HTTP 404)'), 'no-repo');
  assert.equal(classifyAlertsError('gh: Bad credentials (HTTP 401)'), 'no-auth');
  assert.equal(classifyAlertsError('socket hang up'), 'error');
});

test('not-enabled is information with a link to fix it, not a failure', () => {
  const a = notEnabledAlert('deskrhythm', 'Lars-Bruce/deskrhythm');
  assert.equal(a.severity, 'info');
  assert.equal(a.kind, 'not-enabled');
  assert.match(a.url, /settings\/security_analysis/);
  assert.equal(notEnabledAlert('p', null).url, null);
});

// Real Dependabot PR shapes: branch `dependabot/<eco>/<pkg>-<version>`, title
// "Bump <pkg> from X to Y".
const PRS = [
  { number: 12, title: 'Bump postcss from 8.5.11 to 8.5.12', url: 'p12', headRefName: 'dependabot/npm_and_yarn/postcss-8.5.12', author: { login: 'app/dependabot' } },
  { number: 13, title: 'Bump vite from 5.4.0 to 6.0.0', url: 'p13', headRefName: 'dependabot/npm_and_yarn/vite-6.0.0', author: { login: 'app/dependabot' } },
  { number: 14, title: 'feat: something a human wrote', url: 'p14', headRefName: 'feat/thing', author: { login: 'lars' } },
];

test('a bump with an open PR is merge-ready; a major one is not', () => {
  const alerts = [
    { pkg: 'postcss', hasPatch: true },
    { pkg: 'vite', hasPatch: true },
  ];
  const [postcss, vite] = withFixReadiness(alerts, PRS);

  // The whole point: these two look identical on the alert payload, and need
  // completely different amounts of a human.
  assert.equal(postcss.fix, 'ready');
  assert.equal(postcss.prNumber, 12);
  assert.equal(vite.fix, 'major', 'green CI does not justify merging a major');
  assert.equal(vite.prUrl, 'p13');
});

test('a patch with no PR, and no way to read the lockfile, stays blocked', () => {
  // Without reachability analysis all we know is "a fix exists and nothing
  // opened a PR". That is worth saying, and worth NOT dressing up as either of
  // the sharper verdicts below.
  const [a] = withFixReadiness([{ pkg: 'lodash', hasPatch: true }], PRS);
  assert.equal(a.fix, 'blocked');
  assert.equal(a.prNumber, null);
  assert.equal(a.command, null);
});

test('reachability splits blocked into refresh and upstream', () => {
  const alerts = [
    { pkg: 'cryptography', hasPatch: true, ecosystem: 'pip', manifestPath: 'tools/x/uv.lock' },
    { pkg: 'esbuild', hasPatch: true, ecosystem: 'npm', manifestPath: 'package-lock.json' },
  ];
  const verdicts = { cryptography: 'refresh', esbuild: 'upstream' };
  const [crypto, esbuild] = withFixReadiness(alerts, [], {
    reachability: (a) => verdicts[a.pkg] || null,
  });
  assert.equal(crypto.fix, 'refresh');
  assert.equal(crypto.command, 'cd tools/x && uv lock --upgrade-package cryptography',
    'a refresh row carries the command that clears it');
  assert.equal(esbuild.fix, 'upstream');
  assert.equal(esbuild.command, null, 'nothing to run is the whole point of upstream');
});

test('a null verdict falls back to blocked rather than guessing', () => {
  const [a] = withFixReadiness(
    [{ pkg: 'lodash', hasPatch: true, ecosystem: 'npm' }], [],
    { reachability: () => null });
  assert.equal(a.fix, 'blocked');
});

test('a reachability probe that throws cannot take the poll down with it', () => {
  const [a] = withFixReadiness(
    [{ pkg: 'lodash', hasPatch: true, ecosystem: 'npm' }], [],
    { reachability: () => { throw new Error('unreadable lockfile'); } });
  assert.equal(a.fix, 'blocked');
});

test('security updates off still wins over reachability', () => {
  // Reachability answers "could this be installed", not "is anything trying".
  // With updates off we have not earned either sharp verdict.
  const [a] = withFixReadiness(
    [{ pkg: 'lodash', hasPatch: true, ecosystem: 'npm' }], [],
    { autofixEnabled: false, reachability: () => 'refresh' });
  assert.equal(a.fix, 'inactive');
});

test('with security updates off, a missing PR is not a diagnosis', () => {
  // Nothing is opening PRs, so "no PR" says nothing about whether the fix is
  // takeable. Calling it 'blocked' would assert pinning we have not observed —
  // and on a repo with updates off, that would be EVERY advisory.
  const [a] = withFixReadiness([{ pkg: 'postcss', hasPatch: true }], [], { autofixEnabled: false });
  assert.equal(a.fix, 'inactive');
  assert.equal(a.prNumber, null);
});

test('no patched version at all is its own state', () => {
  const [a] = withFixReadiness([{ pkg: 'lodash', hasPatch: false }], []);
  assert.equal(a.fix, 'none');
});

test('a human PR is not mistaken for a Dependabot fix', () => {
  assert.equal(isDependabotPr(PRS[0]), true);
  assert.equal(isDependabotPr(PRS[2]), false);
  // Matching on the branch prefix keeps working after a human takes the PR over
  // to resolve conflicts, which is when the author login stops being dependabot.
  assert.equal(isDependabotPr({ headRefName: 'dependabot/npm_and_yarn/x-1.0', author: { login: 'lars' } }), true);
});

test('bump titles are parsed, and unreadable ones do not claim safety', () => {
  assert.deepEqual(parseBumpTitle('Bump vite from 5.4.0 to 6.0.0'), { from: '5.4.0', to: '6.0.0' });
  assert.deepEqual(parseBumpTitle('chore(deps): bump sharp from v0.34.5 to v0.35.0'), { from: '0.34.5', to: '0.35.0' });
  assert.equal(parseBumpTitle('Update dependencies'), null);
  // Unreadable versions return null rather than 'minor' — implying a bump is
  // safe when we cannot tell is the one wrong answer here.
  assert.equal(classifyBump('weird', '1.0.0'), null);
});

test('under 1.0 a minor is a major, which is the sharp case exactly', () => {
  assert.equal(classifyBump('5.4.0', '6.0.0'), 'major');
  assert.equal(classifyBump('8.5.11', '8.5.12'), 'minor');
  assert.equal(classifyBump('0.34.5', '0.35.0'), 'major');
  assert.equal(classifyBump('0.34.5', '0.34.6'), 'minor');
});

test('rows needing a decision sort above rows you can just merge', () => {
  const sorted = sortAlerts([
    { severity: 'high', fix: 'ready', project: 'a', title: 'r' },
    { severity: 'high', fix: 'blocked', project: 'a', title: 'b' },
    { severity: 'high', fix: 'major', project: 'a', title: 'm' },
    { severity: 'high', fix: 'none', project: 'a', title: 'n' },
  ])
  // Otherwise the handful that need thought are buried under the bulk that
  // does not, and the list stops being triageable at a glance.
  assert.deepEqual(sorted.map((a) => a.fix), ['major', 'blocked', 'none', 'ready']);
});

test('upstream sinks to the bottom, refresh sits with the clearable work', () => {
  const sorted = sortAlerts([
    { severity: 'high', fix: 'upstream', project: 'a', title: 'u' },
    { severity: 'high', fix: 'ready', project: 'a', title: 'r' },
    { severity: 'high', fix: 'refresh', project: 'a', title: 'f' },
    { severity: 'high', fix: 'major', project: 'a', title: 'm' },
  ]);
  // 'upstream' is the one row re-reading cannot change — unlike 'none', which
  // becomes actionable the day a patch ships. It belongs last.
  assert.deepEqual(sorted.map((a) => a.fix), ['major', 'refresh', 'ready', 'upstream']);
});

test('the ready-to-merge count drives the "you can clear these" summary', () => {
  assert.equal(countReadyToMerge([{ fix: 'ready' }, { fix: 'ready' }, { fix: 'major' }, {}]), 2);
  assert.equal(countReadyToMerge([]), 0);
});

test('alerts-on-but-updates-off is reported as its own condition', () => {
  // Distinct from "not enabled", and worse: the repo can see advisories and
  // has no way to act, so they pile up silently.
  const a = autofixDisabledAlert('deskrhythm', 'o/r', 13);
  assert.equal(a.kind, 'autofix-disabled');
  assert.equal(a.severity, 'info');
  assert.match(a.detail, /13 open advisories/);
  assert.match(autofixDisabledAlert('p', 'o/r', 0).detail, /nothing will open a fix PR/);
  assert.match(autofixDisabledAlert('p', 'o/r', 1).detail, /1 open advisory\b/);
});

test('sorting is worst-first and stable across equal severities', () => {
  const sorted = sortAlerts([
    { severity: 'info', project: 'b', title: 'i' },
    { severity: 'critical', project: 'z', title: 'c' },
    { severity: 'high', project: 'b', title: 'h2' },
    { severity: 'high', project: 'a', title: 'h1' },
  ]);
  assert.deepEqual(sorted.map((a) => a.severity), ['critical', 'high', 'high', 'info']);
  assert.deepEqual(sorted.slice(1, 3).map((a) => a.project), ['a', 'b']);
});

test('the badge count excludes info, so an unconfigured project is not alarming', () => {
  const counts = countBySeverity([
    { severity: 'high' }, { severity: 'high' }, { severity: 'moderate' }, { severity: 'info' },
  ]);
  assert.equal(counts.high, 2);
  assert.equal(counts.total, 4);
  assert.equal(counts.actionable, 3);
  assert.equal(countBySeverity([]).actionable, 0);
});

test('a verdict may explain why it has no answer', () => {
  // A broken probe degrading silently to "could not tell" is what made an inert
  // feature look like a working one with unlucky data. The reason travels.
  const [a] = withFixReadiness(
    [{ pkg: 'undici', hasPatch: true, ecosystem: 'npm' }], [],
    { reachability: () => ({ verdict: null, note: 'npm could not resolve this tree: ERESOLVE' }) });
  assert.equal(a.fix, 'blocked');
  assert.match(a.note, /ERESOLVE/);
});

test('a plain verdict carries no note', () => {
  const [a] = withFixReadiness(
    [{ pkg: 'undici', hasPatch: true, ecosystem: 'npm' }], [],
    { reachability: () => 'upstream' });
  assert.equal(a.fix, 'upstream');
  assert.equal(a.note, null);
});
