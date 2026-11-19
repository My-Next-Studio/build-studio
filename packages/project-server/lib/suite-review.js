'use strict';

/**
 * The review behind Operations → Tests: one agent reads the suite for overlap
 * and writes proposals; the server files them as a backlog Task, as the CI
 * maintenance pass does (lib/ci-maintenance.js, docs/plans/test-suite-drift.md).
 * It comes due every `review_every` stories, or is started from a growth
 * notice. Design: docs/plans/local-suite-watch.md.
 */

const { fmtValue } = require('./suite-watch');

const METRIC_NAME = { seconds: 'time', tests: 'tests', lines: 'lines' };

function seriesTable(evaluated) {
  const rows = [];
  for (const s of evaluated) {
    for (const m of Object.values(s.metrics)) {
      const parts = [`${s.label} (${s.key}) ${METRIC_NAME[m.metric]}: ${fmtValue(m.metric, m.latest && m.latest.value)}`];
      if (m.median != null) parts.push(`median ${fmtValue(m.metric, m.median)}`);
      if (m.flag) parts.push(`${m.flag.overPct}% over its baseline of ${fmtValue(m.metric, m.flag.baseline)} since ${String(m.flag.since.createdAt).slice(0, 10)}`);
      if (m.cap != null) parts.push(`cap ${fmtValue(m.metric, m.cap)}${m.overCap ? ' — OVER' : ''}`);
      rows.push(`- ${parts.join(', ')}`);
    }
  }
  return rows.join('\n') || '- (nothing measured yet)';
}

/**
 * @param {object} o
 * @param {'due'|'growth'} o.reason
 * @param {Array} o.evaluated    suite-watch evaluateSeries()
 * @param {Array} o.flaky        suite-watch recurringFlaky()
 * @param {Array} o.stories      the stories since the last review
 * @param {object} o.where       { testPaths, gateHistory, nightlyDir } relative to the project
 * @param {string} o.resultFile
 */
function composeReviewPrompt({ reason, focus, evaluated, flaky, stories, where, resultFile }) {
  const storyList = stories.length
    ? stories.map((s) => `- ${s.item || s.id} (merged ${s.at.slice(0, 10)})`).join('\n')
    : '- (none recorded)';
  const flakyList = flaky.length
    ? flaky.map((f) => `- ${f.test}: ${f.flaky} flaky, ${f.failed} red, of the last ${f.of} nightly runs`).join('\n')
    : '- (none recurring)';
  return [
    '== Test-suite review ==',
    'Every workflow step is scoped to one story, so tests only get added. Each story writes its own files with',
    'copied helpers, QA writes a test per acceptance-criterion combination with no ceiling, and nobody checks',
    'whether a later story made an older test redundant. Find what can be merged, cut, scoped down, or moved',
    'off the merge path, without losing coverage.',
    '',
    'ANALYSIS ONLY. Do not edit, create, delete, commit or push anything except the result file below. Do not',
    'run the full suites; you may time a single test file when a number is missing. The owner and the PM turn',
    'your proposals into a PRD, which goes through the normal review, build and QA.',
    '',
    reason === 'growth'
      ? `Why now: the owner started this from a growth notice${focus ? ` on ${focus}` : ''}.`
      : `Why now: ${stories.length} stories have merged since the last review.`,
    '',
    'Measured on this machine (latest, median, baseline, cap):',
    seriesTable(evaluated),
    '',
    'Tests that keep flaking in the nightly run:',
    flakyList,
    '',
    'Stories merged since the last review (their tests are the likeliest overlap with older ones):',
    storyList,
    '',
    'Where things are:',
    `- Test code: ${where.testPaths.length ? where.testPaths.join(', ') : '(no test_paths configured; find the suites from package.json and the gate script)'}`,
    where.gateHistory ? `- Merge-gate timings per step: ${where.gateHistory} (one JSON line per run)` : null,
    where.nightlyDir ? `- Nightly runs: ${where.nightlyDir}/runs/*/summary.json, and report.json there for per-test durations` : null,
    '',
    'Look for, per suite:',
    '1. Tests a later story generalised: the same rule tested in an older story\'s file and again in a newer one.',
    '   `git log --diff-filter=A --format=\'%h %ad %s\' --date=short -- <file>` names the story that added a file.',
    '2. Copied helpers and fixtures that should be one shared helper.',
    '3. Matrices that run every combination (viewport × language × mode …) where one or two cases would prove it.',
    '4. Tests that assert copy or text against a document instead of behaviour, and tests that read source as text.',
    '5. Fixed waits and sleeps, and the slowest tests per file (from the timings and the nightly report).',
    '6. Tests that pass vacuously: an assertion left empty after a migration, a check that cannot fail.',
    '7. For each recurring flaky test above: the likely cause, and whether the test or the app should change.',
    '',
    'For every test a proposal removes or narrows, name the test that still covers that acceptance criterion.',
    'A proposal that loses the last test of a criterion is not a saving: leave it out, or say what replaces it.',
    'Estimate what each proposal saves (seconds per run, tests, lines). Say what you looked at and left alone.',
    '',
    `Write your result as JSON to ${resultFile}:`,
    '{',
    '  "title": "<backlog item title, under 80 characters, starting with \'Test suite:\'>",',
    '  "summary": "<2-3 sentences: where the weight is and what the proposals save in total>",',
    '  "body": "<markdown: ## Why (the numbers), ## Proposals (a table: change | suite | kind | saves |',
    '           coverage kept by), ## Flaky tests, ## Left alone, ## Acceptance (no criterion loses its last',
    '           test; each suite\'s time, tests and lines back within budget)>"',
    '}',
  ].filter((l) => l !== null).join('\n');
}

module.exports = { composeReviewPrompt };
