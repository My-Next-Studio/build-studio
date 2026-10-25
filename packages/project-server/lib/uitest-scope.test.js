'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { maskSwift, scanSwift, parseDiffHunks, selectModifiedTests, uiTestScope, computeUiTestScope } = require('./uitest-scope');
const { testClassesIn } = require('./qa-suite-run');

// The shape of fazon's PRD192HelpFlowUITests: one-line tests calling flow
// helpers in extensions, which call smaller helpers (FAZ-460, 2026-10-25).
const HELP_FLOW = `import XCTest

final class HelpFlowUITests: XCTestCase {
    let app = XCUIApplication()

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testF01_SettingUp_EN() { runSettingUp("en") }
    func testF01_SettingUp_SV() { runSettingUp("sv") }
    func testF02_AppleHealth_EN() { runAppleHealth("en") }
    func testF03_LoggingFood_EN() { runLoggingFood("en") }
}

// MARK: - F-1

extension HelpFlowUITests {
    func runSettingUp(_ lang: String) {
        launch(["--reset"])
        setUpIntro()
        setUpUsageData()
    }

    private func setUpIntro() {
        check("Welcome {", "a brace in a string is not code")
    }

    private func setUpUsageData() {
        check(t("Usage data", "Användningsdata"), "step 5 title")
        check("\\(label(t("Share", "Dela")))", "interpolated call")
    }
}

// MARK: - F-2, F-3

extension HelpFlowUITests {
    func runAppleHealth(_ lang: String) {
        launch([])
        /* a comment with a } brace */
        check(t("Apple Health", "Apple Hälsa"), "title")
    }

    func runLoggingFood(_ lang: String) {
        launch([])
        check(t("Log food", "Logga mat"), "title")
    }

    func t(_ en: String, _ sv: String) -> String { en }
    func label(_ s: String) -> String { s }
    func check(_ s: String, _ why: String) {}
    func launch(_ args: [String]) { app.launch() }
}
`;

const lineOf = (src, needle) => src.split('\n').findIndex(l => l.includes(needle)) + 1;
const hunk = (line, removed, added) => `@@ -${line},${removed.length} +${line},${added.length} @@\n${removed.map(l => `-${l}`).join('\n')}${removed.length ? '\n' : ''}${added.map(l => `+${l}`).join('\n')}\n`;
const select = (diff) => selectModifiedTests({ src: HELP_FLOW, diff, target: 'AppUITests', testClasses: testClassesIn(HELP_FLOW) });

test('masking blanks strings and comments but keeps interpolated calls', () => {
  const m = maskSwift('let a = "x { \\(f("y"))" // }\n/* } */ g()');
  assert.equal(m.length, 'let a = "x { \\(f("y"))" // }\n/* } */ g()'.length);
  assert.doesNotMatch(m, /[{}]/);
  assert.match(m, /f\(/);
  assert.match(m, /g\(\)/);
  assert.equal(maskSwift('"""\nline }\n"""').replace(/\s/g, ''), '');
  assert.equal(maskSwift('#"raw " } "#').trim(), '');
});

test('the scanner finds every function with its owner and lines', () => {
  const s = scanSwift(HELP_FLOW);
  assert.ok(s);
  const byName = Object.fromEntries(s.funcs.map(f => [f.name, f]));
  assert.equal(byName.testF01_SettingUp_EN.owner, 'HelpFlowUITests');
  assert.equal(byName.runSettingUp.owner, 'HelpFlowUITests', 'an extension owns its functions for the class it extends');
  assert.deepEqual(byName.setUpIntro.modifiers, ['private']);
  assert.deepEqual(byName.setUpWithError.modifiers, ['override']);
  assert.equal(byName.setUpUsageData.startLine, lineOf(HELP_FLOW, 'func setUpUsageData'));
  assert.equal(byName.setUpUsageData.endLine, lineOf(HELP_FLOW, 'func setUpUsageData') + 3);
  assert.equal(scanSwift('func a() {'), null, 'unbalanced braces do not scan');
});

// The FAZ-460 case: a copy change in a helper only F01 reaches.
test('a changed helper selects only the tests that reach it', () => {
  const line = lineOf(HELP_FLOW, 'step 5 title');
  const r = select(hunk(line, ['        check(t("Sharing", "Delning"), "step 5 title")'], ['        check(t("Usage data", "Användningsdata"), "step 5 title")']));
  assert.equal(r.mode, 'methods');
  assert.deepEqual(r.ids, ['AppUITests/HelpFlowUITests/testF01_SettingUp_EN', 'AppUITests/HelpFlowUITests/testF01_SettingUp_SV']);
  assert.match(r.reason, /setUpUsageData/);
});

test('a changed test method selects itself', () => {
  const line = lineOf(HELP_FLOW, 'func testF03_LoggingFood_EN');
  assert.deepEqual(select(hunk(line, ['x'], ['    func testF03_LoggingFood_EN() { runLoggingFood("en") }'])).ids, ['AppUITests/HelpFlowUITests/testF03_LoggingFood_EN']);
});

test('a helper every flow uses selects every test that uses it', () => {
  const line = lineOf(HELP_FLOW, 'func launch(');
  const r = select(hunk(line, ['x'], ['    func launch(_ args: [String]) { app.launch() }']));
  assert.equal(r.mode, 'methods');
  assert.equal(r.ids.length, 4);
});

test('changes the mapping cannot be sure of run the whole class', () => {
  const at = (needle, text) => select(hunk(lineOf(HELP_FLOW, needle), ['x'], [text])).mode;
  assert.equal(at('let app =', '    let app = XCUIApplication()'), 'classes', 'a stored property');
  assert.equal(at('continueAfterFailure', '        continueAfterFailure = true'), 'classes', 'setUp reaches every test');
  assert.equal(at('final class HelpFlowUITests', 'final class HelpFlowUITests: XCTestCase {'), 'classes', 'the class declaration');
  assert.equal(at('import XCTest', 'import XCTest'), 'classes', 'outside any type');
});

test('blank and comment-only lines are not changes', () => {
  const line = lineOf(HELP_FLOW, '// MARK: - F-1');
  assert.equal(select(hunk(line, ['// MARK: F-1'], ['// MARK: - F-1'])).mode, 'classes', 'nothing to trace means the class, not nothing');
  const helper = lineOf(HELP_FLOW, 'step 5 title');
  const r = select(`${hunk(line, ['// MARK: F-1'], ['// MARK: - F-1'])}${hunk(helper, ['x'], ['        check(t("Usage data", "Användningsdata"), "step 5 title")'])}`);
  assert.equal(r.mode, 'methods', 'a comment hunk beside a real change does not widen it');
  assert.equal(r.ids.length, 2);
});

test('a removal is placed by the lines around it', () => {
  const line = lineOf(HELP_FLOW, 'launch(["--reset"])');
  const r = select(`@@ -${line + 1},1 +${line},0 @@\n-        removedCall()\n`);
  assert.equal(r.mode, 'methods');
  assert.equal(r.ids.length, 2, 'inside runSettingUp: the F01 tests');
});

test('the diff parser keeps new-side line numbers', () => {
  const hunks = parseDiffHunks('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,2 +3,3 @@\n-a\n-b\n+a\n+\n+c\n@@ -10 +11,0 @@\n-gone\n@@ -20 +21 @@\n-// old\n+// new\n');
  assert.deepEqual(hunks, [{ lines: [3, 5], anchors: [] }, { lines: [], anchors: [11, 12] }]);
});

test('a code change no test reaches runs the class', () => {
  const src = HELP_FLOW.replace('    func launch(', '    func unused() { app.terminate() }\n    func launch(');
  const line = lineOf(src, 'func unused');
  assert.equal(selectModifiedTests({ src, diff: hunk(line, [], ['    func unused() { app.terminate() }']), target: 'T', testClasses: testClassesIn(src) }).mode, 'classes');
});

test('the branch scope: new files in full, modified ones narrowed, other files ignored', () => {
  const files = {
    'ios/AppUITests/HelpFlowUITests.swift': HELP_FLOW,
    'ios/AppUITests/NewUITests.swift': 'final class NewUITests: XCTestCase {\n    func testA() {}\n}\n',
    'ios/AppTests/UnitTests.swift': 'final class UnitTests: XCTestCase {}\n',
  };
  const line = lineOf(HELP_FLOW, 'step 5 title');
  const r = uiTestScope({
    changes: [
      { status: 'M', file: 'ios/AppUITests/HelpFlowUITests.swift' },
      { status: 'A', file: 'ios/AppUITests/NewUITests.swift' },
      { status: 'M', file: 'ios/AppTests/UnitTests.swift' },
      { status: 'D', file: 'ios/AppUITests/OldUITests.swift' },
    ],
    readFile: (f) => files[f],
    diffFor: () => hunk(line, ['x'], ['        check(t("Usage data", "Användningsdata"), "step 5 title")']),
    testClassesIn,
  });
  assert.deepEqual(r.ids, [
    'AppUITests/HelpFlowUITests/testF01_SettingUp_EN',
    'AppUITests/HelpFlowUITests/testF01_SettingUp_SV',
    'AppUITests/NewUITests',
  ]);
  assert.deepEqual(r.files.map(f => f.mode), ['methods', 'classes']);
});

test('an unreadable diff or file falls back to the class, never to nothing', () => {
  const base = { changes: [{ status: 'M', file: 'ios/AppUITests/HelpFlowUITests.swift' }], testClassesIn };
  assert.deepEqual(uiTestScope({ ...base, readFile: () => HELP_FLOW, diffFor: () => { throw new Error('no'); } }).ids, ['AppUITests/HelpFlowUITests']);
  assert.deepEqual(uiTestScope({ ...base, readFile: () => { throw new Error('no'); }, diffFor: () => '' }).ids, ['AppUITests/HelpFlowUITests']);
});

test('from git: committed, uncommitted and untracked changes all count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uitest-scope-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t');
    git('config', 'user.name', 't');
    fs.mkdirSync(path.join(dir, 'ios/AppUITests'), { recursive: true });
    const file = path.join(dir, 'ios/AppUITests/HelpFlowUITests.swift');
    fs.writeFileSync(file, HELP_FLOW);
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(file, HELP_FLOW.replace('"Usage data", "Användningsdata"', '"Sharing", "Delning"'));
    git('commit', '-q', '-am', 'copy');
    fs.writeFileSync(file, HELP_FLOW.replace('"Usage data", "Användningsdata"', '"Sharing", "Delning"').replace('"Log food", "Logga mat"', '"Log a meal", "Logga en måltid"'));
    fs.writeFileSync(path.join(dir, 'ios/AppUITests/NewUITests.swift'), 'final class NewUITests: XCTestCase {\n    func testA() {}\n}\n');
    const r = computeUiTestScope({ cwd: dir, base: 'main' });
    assert.deepEqual(r.ids, [
      'AppUITests/HelpFlowUITests/testF01_SettingUp_EN',
      'AppUITests/HelpFlowUITests/testF01_SettingUp_SV',
      'AppUITests/HelpFlowUITests/testF03_LoggingFood_EN',
      'AppUITests/NewUITests',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
