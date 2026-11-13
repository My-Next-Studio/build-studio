'use strict';

// A device suite runs only when the branch touches its paths. An Android-only
// story had its builder run the iOS suite too, in parallel with the Android
// gate (deskrhythm DR-180, 2026-11-13).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const suiteScope = require('./suite-scope');

const ANDROID = { name: 'Android tier-1', command: 'android/scripts/run-deskrhythm-tests.sh', paths: ['android/'] };
const PBX = 'path = "../docs/ux/probe"; path = ../shared/Tokens.swift;';

test('an iOS project gets its unit target, watching what QA watches', () => {
  const config = {
    simulator: { destination: 'id=X', scheme: 'DeskRhythm' },
    xcode_project_path: 'ios/DeskRhythm.xcodeproj',
    qa_validation: { unit_test_target: 'DeskRhythmTests', native_suite_paths: ['Shared/'], path_suites: [ANDROID] },
  };
  const suites = suiteScope.deviceSuites(config, '/p', { readFile: () => PBX });
  assert.deepEqual(suites.map((s) => s.name), ['iOS unit tests (DeskRhythmTests)', 'Android tier-1']);
  assert.deepEqual(suites[0].paths, ['ios/', 'docs/ux/probe', 'shared/Tokens.swift', 'Shared/']);
  assert.deepEqual(suites[1], ANDROID);
});

test('a project without a simulator or path suites has none', () => {
  assert.deepEqual(suiteScope.deviceSuites({}, '/p'), []);
  assert.deepEqual(suiteScope.deviceSuites({ qa_validation: { path_suites: [{ paths: ['x/'] }, null] } }, '/p'), []);
});

test('run or skip by the branch diff', () => {
  const ios = { name: 'iOS', command: null, paths: ['ios/', 'shared/Tokens.swift'] };
  const always = { name: 'Anywhere', command: null, paths: [] };
  const by = (changed) => Object.fromEntries(suiteScope.classifySuites([ios, ANDROID, always], changed).map((r) => [r.name, r.run]));
  assert.deepEqual(by(['android/app/src/Main.kt', 'docs/x.md']), { iOS: false, 'Android tier-1': true, Anywhere: true });
  assert.deepEqual(by(['shared/Tokens.swift']), { iOS: true, 'Android tier-1': false, Anywhere: true });
  assert.deepEqual(by(['shared/Tokens.swift.bak', 'androidx/notes.md']), { iOS: false, 'Android tier-1': false, Anywhere: true }, 'a prefix of a name is not a match');
  assert.deepEqual(by(null), { iOS: true, 'Android tier-1': true, Anywhere: true }, 'an unknown diff runs everything');
});

test('QA lists each suite with its command and the reason', () => {
  const text = suiteScope.qaSection(suiteScope.classifySuites([ANDROID], ['ios/App.swift']));
  assert.match(text, /SKIP {2}Android tier-1 — `android\/scripts\/run-deskrhythm-tests\.sh`: the branch changes nothing under android\//);
  assert.match(text, /Do NOT run a SKIP suite/);
  assert.equal(suiteScope.qaSection([]), '');
});

test('the start-script lines survive a quote in a name and are empty with no suites', () => {
  assert.equal(suiteScope.envLines([], '/x/cli.js'), '');
  const lines = suiteScope.envLines([{ name: "Owner's suite", command: null, paths: ['a/'] }], '/x/cli.js');
  const r = spawnSync('bash', ['-c', `${lines}printf %s "$BUILD_STUDIO_SUITE_SPEC"`], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(r.stdout), [{ name: "Owner's suite", command: null, paths: ['a/'] }]);
});

test('the command reads committed, uncommitted and untracked changes of a real branch', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-scope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'android'));
  fs.mkdirSync(path.join(dir, 'ios'));
  fs.writeFileSync(path.join(dir, 'README.md'), 'x');
  git('add', '.');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  const spec = JSON.stringify([{ name: 'iOS', command: null, paths: ['ios/'] }, ANDROID]);
  const run = () => spawnSync(process.execPath, [suiteScope.CLI_PATH, 'main'], { cwd: dir, encoding: 'utf8', env: { ...process.env, BUILD_STUDIO_SUITE_SPEC: spec } }).stdout;

  assert.match(run(), /^SKIP {2}iOS.*\nSKIP {2}Android/);
  fs.writeFileSync(path.join(dir, 'android', 'New.kt'), 'x');            // untracked
  assert.match(run(), /SKIP {2}iOS[^\n]*\nRUN {3}Android tier-1 — `android\/scripts\/run-deskrhythm-tests\.sh`: the branch changes android\/New\.kt/);
  git('add', '.');
  git('commit', '-qm', 'android');
  fs.writeFileSync(path.join(dir, 'README.md'), 'changed');              // uncommitted, outside both
  assert.match(run(), /SKIP {2}iOS[^\n]*\nRUN {3}Android/);
});
