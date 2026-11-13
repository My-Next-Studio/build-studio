'use strict';

// Which device test suites a branch has to run.
//
// A project with more than one app (deskrhythm: web, iOS, Android) used to have
// every builder run every suite. On an Android-only story (DR-180,
// 2026-11-13) the builder read "every unit test (DeskRhythmTests)" as an order
// to run the iOS suite as well. It ran it in parallel with the Android gate,
// and the simulator plus the emulator pushed a 16 GB machine into 10 GB of swap.
// CI already routes by path (ios/ → the iOS workflow, android/ → the Android
// one). This applies the same routing to the builder and QA.
//
// A device suite runs when the branch changes a file under one of its paths:
//   - the iOS unit-test target, for a project with `simulator.destination`. It
//     watches what nativeSuiteRelevance (qa-suite-run.js) watches, which is the
//     same rule QA already uses to skip its own iOS run;
//   - each entry of `qa_validation.path_suites`: { name, paths, command }.
// A suite with no paths it can be routed by always runs. Suites that are not
// listed (the web suite, repo guards) are not affected: they always run.

const path = require('path');
const { execFileSync } = require('child_process');
const { nativeSuiteRelevance } = require('./qa-suite-run');

/** True when `file` (repo-relative) is under `watched` (a dir ending in / or a path). */
function isUnder(file, watched) {
  return watched.endsWith('/') ? file.startsWith(watched) : file === watched || file.startsWith(`${watched}/`);
}

/**
 * The device suites this project routes by path.
 * @returns {{ name: string, command: string|null, paths: string[] }[]}
 */
function deviceSuites(config, projectRoot, { readFile } = {}) {
  const suites = [];
  const qa = (config && config.qa_validation) || {};
  if (config && config.simulator && config.simulator.destination) {
    const projectPath = config.simulator.project || config.xcode_project_path || null;
    const scheme = config.simulator.scheme || config.xcode_scheme || null;
    const target = qa.unit_test_target || (scheme ? `${scheme}Tests` : 'the unit-test target');
    const { watched } = nativeSuiteRelevance({
      projectRoot: projectRoot || '.', projectPath, changedFiles: [],
      extraPaths: qa.native_suite_paths || [],
      ...(readFile ? { readFile } : {}),
    });
    suites.push({ name: `iOS unit tests (${target})`, command: null, paths: watched });
  }
  for (const s of Array.isArray(qa.path_suites) ? qa.path_suites : []) {
    if (!s || typeof s.name !== 'string' || !s.name.trim()) continue;
    const paths = (Array.isArray(s.paths) ? s.paths : [])
      .filter((p) => typeof p === 'string' && p.trim())
      .map((p) => p.trim().replace(/^\.\//, ''));
    suites.push({ name: s.name.trim(), command: typeof s.command === 'string' && s.command.trim() ? s.command.trim() : null, paths });
  }
  return suites;
}

/**
 * Run or skip, per suite. An unknown diff (null) runs everything.
 * @returns {{ name, command, paths, run: boolean, reason: string }[]}
 */
function classifySuites(suites, changedFiles) {
  return suites.map((s) => {
    if (!Array.isArray(changedFiles)) return { ...s, run: true, reason: 'the branch diff is unknown' };
    if (!s.paths.length) return { ...s, run: true, reason: 'it has no paths to route by' };
    const hit = changedFiles.find((f) => s.paths.some((w) => isUnder(f, w)));
    return hit
      ? { ...s, run: true, reason: `the branch changes ${hit}` }
      : { ...s, run: false, reason: `the branch changes nothing under ${s.paths.join(', ')}` };
  });
}

/** Files the branch changes against `base`: committed, uncommitted and untracked. */
function changedFilesSince({ cwd, base = 'main', run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }) {
  const mergeBase = run(['merge-base', base, 'HEAD']).trim();
  const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
  return [...new Set([...lines(run(['diff', '--name-only', mergeBase])), ...lines(run(['ls-files', '--others', '--exclude-standard']))])];
}

function formatLine(r) {
  const label = r.command ? `${r.name} — \`${r.command}\`` : r.name;
  return `${r.run ? 'RUN ' : 'SKIP'}  ${label}: ${r.reason}`;
}

/** The builder's instructions, or '' for a project with no device suites. */
function builderGuidance(suites, baseBranch = 'main') {
  if (!suites.length) return '';
  return `\n- Device suites run only when the branch touches their paths (CI routes them the same way): ${suites.map((s) => s.name).join('; ')}. `
    + `After your last change, run \`node "$BUILD_STUDIO_SUITE_SCOPE" ${baseBranch}\`: it prints RUN or SKIP per suite, with the reason. Run every suite it marks RUN in full. One it marks SKIP is not required, and QA skips it too. `
    + 'Run device suites one at a time, never in parallel (not as background shells, not one per subagent): a simulator and an emulator together exhaust the machine.';
}

/** The exception the builder's goal makes, or '' for a project with no device suites. */
function goalException(suites, baseBranch = 'main') {
  if (!suites.length) return '';
  return `, except the device suites that \`node "$BUILD_STUDIO_SUITE_SCOPE" ${baseBranch}\` marks SKIP for this branch`;
}

/** QA's section for the configured path suites, or '' when there are none. */
function qaSection(results) {
  if (!results.length) return '';
  return `\n\n## DEVICE SUITES FOR THIS BRANCH (qa_validation.path_suites)\n\nA device suite runs only when the branch touches its paths, the same routing CI uses:\n${results.map((r) => `- ${formatLine(r)}`).join('\n')}\n\nRun each RUN suite in full, one at a time, never in parallel with another device suite. Do NOT run a SKIP suite: nothing it tests has changed. Report it as skipped, not as missing.`;
}

/** The start-script lines that give the agent the scope command, or '' when there is nothing to scope. */
function envLines(suites, cliPath) {
  if (!suites.length) return '';
  const spec = JSON.stringify(suites.map(({ name, command, paths }) => ({ name, command, paths })));
  return `export BUILD_STUDIO_SUITE_SCOPE=${JSON.stringify(cliPath)}\n`
    + `export BUILD_STUDIO_SUITE_SPEC='${spec.replace(/'/g, "'\\''")}'\n`;
}

const CLI_PATH = path.join(__dirname, 'suite-scope-cli.js');

module.exports = {
  CLI_PATH, deviceSuites, classifySuites, changedFilesSince, formatLine,
  builderGuidance, goalException, qaSection, envLines,
};
