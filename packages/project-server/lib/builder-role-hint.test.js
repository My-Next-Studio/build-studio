'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseBuilderRoleHint, suggestBuilderRole, cleanValue } = require('./builder-role-hint');

const PRD = (headerExtra = '', body = '## 1. Problem\n\nSomething.') => [
  '# PRD-046 — Android foundation: a project that builds',
  '',
  '**Backlog item:** `DR-104` — Android foundation',
  '**Status:** Draft',
  '**Owner:** PM',
  headerExtra,
  '',
  body,
].filter(Boolean).join('\n');

// ── reading the header ───────────────────────────────────────────────────────

test('a Role line in the header is read', () => {
  assert.equal(parseBuilderRoleHint(PRD('**Role:** Android Dev')), 'Android Dev');
});

test('the shapes a PM actually writes all resolve to the same value', () => {
  for (const line of [
    '**Role:** Android Dev',
    '**Builder role:** Android Dev',
    '**Builder:** Android Dev',
    'Role: Android Dev',
    '**Role:** `Android Dev`',
    '**Role:** Android Dev — the Phase 1.5 track',
    '**Role:**   Android Dev  ',
    '**role:** android dev',
  ]) {
    const got = parseBuilderRoleHint(PRD(line));
    assert.equal(got.toLowerCase(), 'android dev', `failed for: ${line}`);
  }
});

test('a skill or slash form is passed through for the caller to resolve', () => {
  // findRole matches name OR skill, so these are legitimate — this module must
  // not "helpfully" normalise them into something findRole no longer matches.
  assert.equal(parseBuilderRoleHint(PRD('**Role:** android_dev')), 'android_dev');
  assert.equal(parseBuilderRoleHint(PRD('**Role:** /android_dev')), '/android_dev');
});

test('no hint is null, not an empty string', () => {
  assert.equal(parseBuilderRoleHint(PRD()), null);
  assert.equal(parseBuilderRoleHint(''), null);
  assert.equal(parseBuilderRoleHint(null), null);
});

test('an empty Role value is null rather than a blank role', () => {
  assert.equal(parseBuilderRoleHint(PRD('**Role:**')), null);
  assert.equal(parseBuilderRoleHint(PRD('**Role:** ')), null);
});

// ── the header scope, which is the safety property ───────────────────────────

test('prose in the BODY cannot redirect a run', () => {
  // A PRD body routinely discusses roles. If a sentence could set the builder,
  // a document about iOS would silently retarget an Android run — the exact
  // class of failure this whole feature exists to remove.
  const prd = PRD('', [
    '## 3. Scope',
    '',
    'Role: iOS Dev owns the equivalent surface on the other platform.',
    '**Role:** iOS Dev',
  ].join('\n'));
  assert.equal(parseBuilderRoleHint(prd), null);
});

test('a header hint still wins when the body also mentions a role', () => {
  const prd = PRD('**Role:** Android Dev', '## 3. Scope\n\n**Role:** iOS Dev');
  assert.equal(parseBuilderRoleHint(prd), 'Android Dev');
});

test('a PRD with no sections is treated as all header', () => {
  assert.equal(parseBuilderRoleHint('# PRD-1\n\n**Role:** Frontend Dev\n'), 'Frontend Dev');
});

test('a mid-sentence role mention in the header is not matched', () => {
  // Anchored to the line start: "the Role: field" inside a sentence must not
  // count, or a note ABOUT the field would become the field.
  assert.equal(parseBuilderRoleHint(PRD('This PRD leaves the Role: field unset on purpose.')), null);
});

test('Owner is not mistaken for Role', () => {
  // `**Owner:** PM` sits directly above in every PRD; a sloppy key pattern
  // would read it and try to build under "PM".
  assert.equal(parseBuilderRoleHint(PRD()), null);
});

// ── precedence ───────────────────────────────────────────────────────────────

test('the PRD wins over the backlog item', () => {
  const r = suggestBuilderRole({ prdText: PRD('**Role:** Android Dev'), item: { role: 'iOS Dev' } });
  assert.deepEqual(r, { value: 'Android Dev', source: 'prd' });
});

test('the item is used when the PRD says nothing', () => {
  const r = suggestBuilderRole({ prdText: PRD(), item: { role: 'iOS Dev' } });
  assert.deepEqual(r, { value: 'iOS Dev', source: 'item' });
});

test('neither is null, so the caller keeps its default', () => {
  assert.equal(suggestBuilderRole({ prdText: PRD(), item: {} }), null);
  assert.equal(suggestBuilderRole({}), null);
});

test('an item role gets the same cleaning as a PRD one', () => {
  assert.equal(suggestBuilderRole({ item: { role: '`iOS Dev`' } }).value, 'iOS Dev');
});

// ── value cleaning ───────────────────────────────────────────────────────────

test('cleanValue keeps the role and drops the decoration', () => {
  assert.equal(cleanValue('`Android Dev`'), 'Android Dev');
  assert.equal(cleanValue('**Android Dev**'), 'Android Dev');
  assert.equal(cleanValue('Android Dev — Phase 1.5'), 'Android Dev');
  assert.equal(cleanValue('Android Dev.'), 'Android Dev');
  assert.equal(cleanValue('   '), null);
});

test('a hyphenated role name survives the em-dash split', () => {
  // The split targets " — explanation", not a hyphen inside a name.
  assert.equal(cleanValue('Front-end Dev'), 'Front-end Dev');
});
