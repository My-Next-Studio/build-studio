'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { referencedNames, resolveReferences, inlineReferencedDefinitions } = require('./agent-skills');

// A fake project tree, so the resolution rules are testable without a checkout.
const ROOT = '/proj';
const FILES = {
  [path.join(ROOT, '.claude/commands/qa.md')]: '# QA role\n\nRun the suite. Visual smoke via playwright-cli.',
  [path.join(ROOT, '.claude/commands/ios_dev.md')]: '# iOS Dev role',
  [path.join(ROOT, '.claude/skills/qa-browser-testing/SKILL.md')]: '# Browser testing\n\nplaywright-cli open <url>',
};
const fakeFs = {
  existsSync: (p) => Object.prototype.hasOwnProperty.call(FILES, p),
  readFileSync: (p) => {
    if (!Object.prototype.hasOwnProperty.call(FILES, p)) throw new Error(`ENOENT ${p}`);
    return FILES[p];
  },
};

const QA_PROMPT = 'You are QA. Use the /qa skill. Use the `qa-browser-testing` skill for any browser-based verification.';

test('it finds the command and skill names a prompt refers to', () => {
  const { commands, skills } = referencedNames(QA_PROMPT);
  assert.deepEqual(commands, ['qa']);
  assert.deepEqual(skills, ['qa-browser-testing']);
});

test('path segments are not mistaken for command references', () => {
  // The common false positive, and an expensive one: `docs/qa/QA-105.md` would
  // otherwise inline the whole QA role into a prompt that never asked for it.
  const { commands } = referencedNames(
    'Read docs/qa/QA-105.md and e2e/support/expected-dataset.js, then run npx/vitest.');
  assert.deepEqual(commands, []);
});

test('a reference resolves only when the file actually exists', () => {
  // `/code-review` is a Claude Code built-in, not a project role file — there is
  // nothing on disk to inline, and inventing one would be worse than silence.
  const refs = resolveReferences('Use the /qa skill and the /code-review skill.', { roots: [ROOT], fs: fakeFs });
  assert.deepEqual(refs.map((r) => r.name), ['qa']);
});

test('claude gets nothing appended — it loads .claude itself', () => {
  assert.equal(inlineReferencedDefinitions(QA_PROMPT, { cli: 'claude', roots: [ROOT], fs: fakeFs }), '');
});

test('codex gets the full text of everything its prompt names', () => {
  const out = inlineReferencedDefinitions(QA_PROMPT, { cli: 'codex', roots: [ROOT], fs: fakeFs });
  assert.match(out, /ROLE DEFINITIONS AND SKILLS REFERRED TO ABOVE/);
  assert.match(out, /### \/qa \(command\)/);
  assert.match(out, /Run the suite\. Visual smoke via playwright-cli\./);
  assert.match(out, /### `qa-browser-testing` \(skill\)/);
  assert.match(out, /playwright-cli open <url>/);
});

test('it forbids substituting a similar-sounding capability', () => {
  // The actual failure mode: told the skill was "absent", the agent used its own
  // in-app browser runtime instead and reported the resulting error as a defect.
  const out = inlineReferencedDefinitions(QA_PROMPT, { cli: 'codex', roots: [ROOT], fs: fakeFs });
  assert.match(out, /do not substitute a similar-sounding capability of your own/);
  assert.match(out, /This is the definitive version/);
});

test('opencode is treated like codex, not like claude', () => {
  assert.notEqual(inlineReferencedDefinitions(QA_PROMPT, { cli: 'opencode', roots: [ROOT], fs: fakeFs }), '');
});

test('nothing referenced, nothing appended', () => {
  assert.equal(inlineReferencedDefinitions('Run the tests and report.', { cli: 'codex', roots: [ROOT], fs: fakeFs }), '');
});

test('roots are tried in order, so a worktree copy wins over the project root', () => {
  const wtFile = path.join('/wt', '.claude/commands/qa.md');
  const fs2 = {
    existsSync: (p) => p === wtFile || fakeFs.existsSync(p),
    readFileSync: (p) => (p === wtFile ? '# QA role (branch-local)' : fakeFs.readFileSync(p)),
  };
  const out = inlineReferencedDefinitions(QA_PROMPT, { cli: 'codex', roots: ['/wt', ROOT], fs: fs2 });
  assert.match(out, /branch-local/);
  // …and a worktree without .claude still resolves against the project root,
  // rather than silently finding nothing.
  const out2 = inlineReferencedDefinitions(QA_PROMPT, { cli: 'codex', roots: ['/empty', ROOT], fs: fakeFs });
  assert.match(out2, /Run the suite/);
});

test('an oversized file is skipped and SAID to be skipped', () => {
  // Silent truncation would read as "this is the whole role definition".
  const big = { ...FILES };
  big[path.join(ROOT, '.claude/commands/qa.md')] = 'x'.repeat(5000);
  const fs3 = { existsSync: fakeFs.existsSync, readFileSync: (p) => big[p] ?? fakeFs.readFileSync(p) };
  const out = inlineReferencedDefinitions(QA_PROMPT, { cli: 'codex', roots: [ROOT], fs: fs3, maxBytes: 1000 });
  assert.match(out, /Not inlined \(too large for the prompt budget\): qa/);
  assert.match(out, /qa-browser-testing/); // the small one still made it
});

test('a missing or unreadable tree degrades to appending nothing', () => {
  const throwing = { existsSync: () => { throw new Error('boom'); }, readFileSync: () => { throw new Error('boom'); } };
  assert.equal(inlineReferencedDefinitions(QA_PROMPT, { cli: 'codex', roots: [ROOT], fs: throwing }), '');
});

// ── Claude-only capabilities: translated, not inlined ────────────────────────
const { translateClaudeOnlyCapabilities } = require('./agent-skills');

const REVIEW_PROMPT = 'You are a Code Reviewer.\n'
  + 'Use the /code-review skill at high effort — a multi-angle, recall-biased pass: surface every plausible issue then verify.\n'
  + 'Review all changes.';

test('claude keeps the reference — it can actually run the harness', () => {
  const r = translateClaudeOnlyCapabilities(REVIEW_PROMPT, 'claude');
  assert.equal(r.text, REVIEW_PROMPT);
  assert.deepEqual(r.translated, []);
});

test('codex gets the method spelled out instead of a name it cannot invoke', () => {
  const r = translateClaudeOnlyCapabilities(REVIEW_PROMPT, 'codex');
  assert.deepEqual(r.translated, ['/code-review']);
  assert.doesNotMatch(r.text, /Use the \/code-review skill/);
  assert.match(r.text, /Pass 1 — FIND/);
  assert.match(r.text, /Pass 2 — VERIFY/);
  assert.match(r.text, /at high depth/);
  assert.match(r.text, /Review all changes\./);
});

test('a "do NOT use it" instruction is never inverted into "do the method"', () => {
  const negative = 'Do NOT use the /code-review skill and do NOT launch parallel sub-agents. Do a single-pass focused review.';
  const r = translateClaudeOnlyCapabilities(negative, 'codex');
  assert.equal(r.text, negative);
  assert.deepEqual(r.translated, []);
});

test('a prompt naming no claude-only capability is untouched', () => {
  const plain = 'You are QA. Run the test suite and report counts.';
  assert.equal(translateClaudeOnlyCapabilities(plain, 'codex').text, plain);
});

test('the regex is not left stateful across calls', () => {
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(translateClaudeOnlyCapabilities(REVIEW_PROMPT, 'codex').translated, ['/code-review'], `call ${i}`);
  }
});

// A skill directory name may contain an underscore, and a real one does
// (`draft_prd`, scaffolded into every project). The skill pattern excluded
// underscores, so such a skill could never be matched however it was written:
// backticked it failed this pattern, and as `/draft_prd` it matched the COMMAND
// pattern and resolved against `.claude/commands/`, where a skill does not live.
// The reference inlined nothing, silently, and a non-Claude agent invented a
// substitute — the exact failure this module exists to prevent.
test('a skill name containing an underscore is recognised as a skill', () => {
  const refs = referencedNames('Use the `draft_prd` skill to draft a PRD.');
  assert.deepEqual(refs.skills, ['draft_prd']);
  assert.deepEqual(refs.commands, []);
});

test('hyphenated skill names still work, and commands still win over skills', () => {
  const refs = referencedNames('Use the `qa-browser-testing` skill. Also /qa.');
  assert.deepEqual(refs.skills, ['qa-browser-testing']);
  assert.deepEqual(refs.commands, ['qa']);
});
