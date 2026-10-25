'use strict';

/**
 * Which XCUITests a branch has to run under qa_validation.scope=new-uitests.
 *
 * The scope is "the UI tests this branch adds or modifies". It used to be
 * applied a whole class at a time, and one class can be most of an hour: fazon
 * FAZ-460 (2026-10-25) changed one copy string in a helper of
 * PRD192HelpFlowUITests, which only its two F01 tests call (3.5 minutes), and
 * the builder and then QA each ran all 24 of its tests (44 minutes each).
 *
 * So a MODIFIED file now runs only the tests that reach the changed code: the
 * changed lines are mapped to the functions holding them, and the tests that
 * call those functions, directly or through other helpers in the same file, are
 * selected. That is the scope's own reasoning applied one level down: a test
 * whose code did not change is left to the periodic regression run, exactly as
 * an unchanged test class already is.
 *
 * The whole class still runs whenever the mapping is not certain:
 *   - the file is new;
 *   - a change sits outside any function (a stored property, the class
 *     declaration, an attribute, a nested type);
 *   - a change is in setUp/tearDown, an init, an override, or a static or class
 *     function, all of which reach every test without being called by name;
 *   - a changed function is called by no test in the file (it may be used from
 *     elsewhere, so the conservative answer is the class);
 *   - the file does not scan (unbalanced braces).
 * The call graph matches names, so it over-selects (a helper named like
 * another, an overload), never under-selects within a file. Blank and
 * comment-only lines in the diff are ignored.
 *
 * The scanner and the selection are pure; computeUiTestScope at the bottom does
 * the git and file reading, for the QA server run and for the builder's command
 * (uitest-scope-cli.js), so the two always agree.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── Scanning Swift ──────────────────────────────────────────────────────────

/**
 * The source with comments and string literals blanked to spaces, newlines and
 * offsets kept, so braces and names can be read off it directly. String
 * interpolation stays: `"\(t("a", "b"))"` calls t, and the call graph must see
 * that.
 */
function maskSwift(src) {
  const out = src.split('');
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '; };
  let i = 0;

  function code(stopAtClose) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (c === '/' && n === '/') {
        const e = src.indexOf('\n', i);
        const end = e < 0 ? src.length : e;
        blank(i, end);
        i = end;
        continue;
      }
      if (c === '/' && n === '*') {
        let d = 1;
        let j = i + 2;
        while (j < src.length && d) {
          if (src[j] === '/' && src[j + 1] === '*') { d++; j += 2; } else if (src[j] === '*' && src[j + 1] === '/') { d--; j += 2; } else j++;
        }
        blank(i, j);
        i = j;
        continue;
      }
      if (c === '"' || (c === '#' && /^#+"/.test(src.slice(i, i + 12)))) { string(); continue; }
      if (stopAtClose) {
        if (c === '(') depth++;
        else if (c === ')') {
          if (depth === 0) { i++; return; }
          depth--;
        }
      }
      i++;
    }
  }

  function string() {
    const start = i;
    let hashes = 0;
    while (src[i] === '#') { hashes++; i++; }
    const multi = src.startsWith('"""', i);
    i += multi ? 3 : 1;
    const close = (multi ? '"""' : '"') + '#'.repeat(hashes);
    const interp = `\\${'#'.repeat(hashes)}(`;
    let seg = start;
    while (i < src.length) {
      if (src.startsWith(interp, i)) {
        blank(seg, i + interp.length);
        i += interp.length;
        code(true);
        seg = i - 1; // the interpolation's closing paren is blanked with the rest
        continue;
      }
      if (hashes === 0 && src[i] === '\\') { i += 2; continue; }
      if (src.startsWith(close, i)) { i += close.length; blank(seg, i); return; }
      if (!multi && src[i] === '\n') { blank(seg, i); return; } // unterminated: stop at the line end
      i++;
    }
    blank(seg, i);
  }

  code(false);
  return out.join('');
}

const FUNC_RE = /\bfunc\s+([A-Za-z_][A-Za-z0-9_]*)\s*(<[^>]*>)?\s*\(([^)]*)\)/g;
const TYPE_RE = /\b(class|struct|enum|extension|actor|protocol)\s+([A-Za-z_][A-Za-z0-9_.]*)/g;

const MODIFIER = /^(override|static|class|private|fileprivate|public|internal|open|final|mutating|nonisolated|@\w+(\([^)]*\))?)$/;

/**
 * The modifiers of one declaration, read backwards from its `func` keyword:
 * the words before it on its line, and the lines above that hold nothing but
 * attributes and modifiers. Reading the whole header instead picked up the
 * `static` of a property declared above, and a test taken for static is a test
 * dropped from the run.
 */
function declarationModifiers(before) {
  const words = before.split(/\s+/).filter(Boolean);
  const out = [];
  for (let k = words.length - 1; k >= 0 && MODIFIER.test(words[k]); k--) out.unshift(words[k]);
  return out;
}

function lastMatch(re, text) {
  re.lastIndex = 0;
  let m = null;
  for (let x = re.exec(text); x; x = re.exec(text)) m = x;
  return m;
}

/**
 * The functions of a Swift file and the types that hold them, from its braces.
 *
 * Each `{` is classified by the text since the previous brace or semicolon: a
 * `func` declaration, an `init`/`deinit`, a type, or anything else (a closure,
 * an `if`, a computed property). Only functions directly inside a type or at
 * file level become nodes; a local function or closure belongs to the function
 * around it.
 *
 * @returns {null | { funcs: Array<{name, owner, params, modifiers, startLine, endLine, body}>, lineOf: (offset) => number }}
 */
function scanSwift(src) {
  const masked = maskSwift(src);
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (off) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };

  const stack = [];
  const funcs = [];
  let boundary = 0;
  for (let k = 0; k < masked.length; k++) {
    const c = masked[k];
    if (c === ';') { boundary = k + 1; continue; }
    if (c === '{') {
      const header = masked.slice(boundary, k);
      const parent = stack.length ? stack[stack.length - 1] : null;
      const memberLevel = !parent || parent.kind === 'type';
      let scope = { kind: 'other', open: k };
      const fn = memberLevel && lastMatch(FUNC_RE, header);
      const type = lastMatch(TYPE_RE, header);
      if (fn) {
        const declAt = boundary + fn.index;
        const modifiers = declarationModifiers(header.slice(0, fn.index));
        scope = {
          kind: 'func', open: k, name: fn[1], params: fn[3].trim(), modifiers,
          owner: parent ? parent.name : null, declAt,
        };
      } else if (memberLevel && /\b(init|deinit)\b/.test(header) && !type) {
        scope = { kind: 'init', open: k, owner: parent ? parent.name : null, declAt: boundary };
      } else if (type && (!fn)) {
        // `extension Foo where …` and `class Foo: Bar` both name Foo; a nested
        // type is still a type, owning its own members.
        scope = { kind: 'type', open: k, name: type[1] === 'extension' ? type[2].split('.').pop() : type[2] };
      }
      stack.push(scope);
      boundary = k + 1;
      continue;
    }
    if (c === '}') {
      const scope = stack.pop();
      if (!scope) return null; // more closing than opening braces
      if (scope.kind === 'func' || scope.kind === 'init') {
        funcs.push({
          kind: scope.kind,
          name: scope.kind === 'init' ? 'init' : scope.name,
          owner: scope.owner,
          params: scope.params || '',
          modifiers: scope.modifiers || [],
          startLine: lineOf(scope.declAt),
          endLine: lineOf(k),
          body: masked.slice(scope.open + 1, k),
        });
      }
      boundary = k + 1;
    }
  }
  if (stack.length) return null;
  return { funcs, lineOf };
}

// ─── The diff ────────────────────────────────────────────────────────────────

const TRIVIAL_LINE = /^\s*(\/\/.*)?$/;

/**
 * The places a `git diff -U0` changes, on the new side of the file.
 *
 * One entry per hunk with a non-trivial line. `lines` are the new-side line
 * numbers of its non-trivial added lines; a hunk that only removes code (or
 * whose added lines are all blank or comments) is anchored at the lines around
 * the removal instead (`anchors`), since the removed code is not in the file
 * any more.
 */
function parseDiffHunks(diffText) {
  const hunks = [];
  let cur = null;
  for (const line of String(diffText || '').split('\n')) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (h) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      cur = { start, count, next: start, lines: [], removedReal: false };
      hunks.push(cur);
      continue;
    }
    if (!cur || /^(\+\+\+|---)/.test(line)) continue;
    if (line.startsWith('+')) {
      if (!TRIVIAL_LINE.test(line.slice(1))) cur.lines.push(cur.next);
      cur.next++;
    } else if (line.startsWith('-')) {
      if (!TRIVIAL_LINE.test(line.slice(1))) cur.removedReal = true;
    }
  }
  return hunks
    .filter(h => h.lines.length || h.removedReal)
    .map(h => ({
      lines: h.lines,
      // -U0 gives a pure removal as "+c,0": the removal sits after line c.
      anchors: h.lines.length ? [] : (h.count === 0 ? [h.start, h.start + 1] : Array.from({ length: h.count }, (_, k) => h.start + k)),
    }));
}

// ─── Selection ───────────────────────────────────────────────────────────────

const LIFECYCLE = /^(setUp|setUpWithError|tearDown|tearDownWithError|init|deinit)$/;

/**
 * The tests of one modified XCUITest file that reach its changed code.
 *
 * @param {{ src: string, diff: string, target: string, testClasses: string[] }} input
 * @returns {{ mode: 'methods', ids: string[], reason: string } | { mode: 'classes', reason: string }}
 */
function selectModifiedTests({ src, diff, target, testClasses }) {
  if (!testClasses.length) return { mode: 'classes', reason: 'it declares no test class' };
  const scan = scanSwift(src);
  if (!scan) return { mode: 'classes', reason: 'it could not be scanned (unbalanced braces)' };
  const hunks = parseDiffHunks(diff);
  if (!hunks.length) return { mode: 'classes', reason: 'its diff has no code change to trace' };

  const holding = (line) => scan.funcs.filter(f => f.startLine <= line && line <= f.endLine);
  const changed = new Set();
  for (const h of hunks) {
    if (h.lines.length) {
      for (const line of h.lines) {
        const fs_ = holding(line);
        if (!fs_.length) return { mode: 'classes', reason: `line ${line} changes code outside any function` };
        for (const f of fs_) changed.add(f);
      }
    } else {
      const fs_ = h.anchors.flatMap(holding);
      if (!fs_.length) return { mode: 'classes', reason: `a removal near line ${h.anchors[0]} sits outside any function` };
      for (const f of fs_) changed.add(f);
    }
  }
  for (const f of changed) {
    if (f.kind === 'init' || LIFECYCLE.test(f.name) || f.modifiers.some(m => ['override', 'static', 'class'].includes(m))) {
      return { mode: 'classes', reason: `${f.name} changes, and it reaches every test without being called by name` };
    }
  }

  // Reverse reachability over a name-based call graph.
  const names = [...new Set(scan.funcs.map(f => f.name))];
  const mentions = (f, name) => new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`).test(f.body);
  const reaches = new Set([...changed].map(f => f.name));
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of scan.funcs) {
      if (reaches.has(f.name)) continue;
      if (names.some(n => reaches.has(n) && n !== f.name && mentions(f, n))) { reaches.add(f.name); grew = true; }
    }
  }
  const classSet = new Set(testClasses);
  const ids = [];
  for (const f of scan.funcs) {
    if (f.kind !== 'func' || !/^test/.test(f.name) || f.params !== '' || !classSet.has(f.owner)) continue;
    if (f.modifiers.some(m => ['static', 'class', 'private', 'fileprivate'].includes(m))) continue;
    if (!reaches.has(f.name)) continue;
    const id = `${target}/${f.owner}/${f.name}`;
    if (!ids.includes(id)) ids.push(id);
  }
  if (!ids.length) return { mode: 'classes', reason: 'no test in it calls the changed code, which may be used from elsewhere' };
  const changedNames = [...new Set([...changed].map(f => f.name))];
  return { mode: 'methods', ids, reason: `only ${ids.length} test(s) reach the changed ${changedNames.join(', ')}` };
}

/**
 * `-only-testing` identifiers for a branch's XCUITest changes.
 *
 * @param {{ changes: Array<{status: string, file: string}>, readFile: (f) => string, diffFor: (f) => string|null, testClassesIn: (src) => string[] }} input
 * @returns {{ ids: string[], files: Array<{file, mode, ids, reason}> }}
 */
function uiTestScope({ changes, readFile, diffFor, testClassesIn }) {
  const ids = [];
  const files = [];
  const add = (id) => { if (!ids.includes(id)) ids.push(id); };
  for (const { status, file } of changes || []) {
    if (!/\.swift$/.test(file) || !['A', 'M'].includes(status)) continue;
    const target = file.split('/').slice(0, -1).find(seg => /UITests$/.test(seg));
    if (!target) continue;
    let src = null;
    try { src = readFile(file); } catch (_) { src = null; }
    if (src === null) {
      // Unreadable: the class named after the file, as before. Dropping a real
      // test silently is the worse error.
      const id = `${target}/${path.basename(file, '.swift')}`;
      add(id);
      files.push({ file, mode: 'classes', ids: [id], reason: 'it could not be read' });
      continue;
    }
    const classes = testClassesIn(src).map(c => `${target}/${c}`);
    let picked = status === 'A' ? { mode: 'classes', reason: 'it is new' } : null;
    if (!picked) {
      let diff = null;
      try { diff = diffFor(file); } catch (_) { diff = null; }
      picked = diff === null
        ? { mode: 'classes', reason: 'its diff could not be read' }
        : selectModifiedTests({ src, diff, target, testClasses: testClassesIn(src) });
    }
    const fileIds = picked.mode === 'methods' ? picked.ids : classes;
    for (const id of fileIds) add(id);
    files.push({ file, mode: fileIds.length ? picked.mode : 'none', ids: fileIds, reason: fileIds.length ? picked.reason : 'it declares no test class' });
  }
  return { ids, files };
}

// ─── Reading it from git ─────────────────────────────────────────────────────

/**
 * The scope for the working tree at `cwd` against `base`: committed and
 * uncommitted changes, and new files not yet added, so the builder can run it
 * before its last commit and get the same answer QA gets after.
 */
function computeUiTestScope({ cwd, base = 'main', run = (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }) {
  const { testClassesIn } = require('./qa-suite-run');
  const mergeBase = run(['merge-base', base, 'HEAD']).trim();
  const changes = run(['diff', '--name-status', '--no-renames', mergeBase])
    .split('\n').map(l => l.trim()).filter(Boolean)
    .map(l => { const [status, ...rest] = l.split('\t'); return { status: status[0], file: rest.join('\t') }; });
  const known = new Set(changes.map(c => c.file));
  for (const f of run(['ls-files', '--others', '--exclude-standard']).split('\n').map(s => s.trim()).filter(Boolean)) {
    if (!known.has(f)) changes.push({ status: 'A', file: f });
  }
  return uiTestScope({
    changes,
    readFile: (f) => fs.readFileSync(path.join(cwd, f), 'utf8'),
    diffFor: (f) => run(['diff', '-U0', mergeBase, '--', f]),
    testClassesIn,
  });
}

module.exports = { maskSwift, scanSwift, parseDiffHunks, selectModifiedTests, uiTestScope, computeUiTestScope };
