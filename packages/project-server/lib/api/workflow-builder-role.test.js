'use strict';

// Which execution role builds a monolithic PRD run.
//
// Before the picker, the monolithic planning shortcut read
// `config.roles.execution[0]` inline (with a literal `'iOS Dev'` fallback), so
// the choice was made by ARRAY POSITION and nothing about the PRD participated.
// A project with more than one implementation track had to reorder its config
// before each run and put it back afterwards; forgetting produced no error,
// because a role will build another track's story perfectly happily under the
// wrong domain rules. That happened live: an Android foundation story (Gradle,
// Compose, Kotlin) built under an iOS role carrying 239 lines of SwiftUI,
// SwiftData and Xcode guidance, and nothing anywhere reported a problem.
//
// `validateBuilderRole` is the strict half — an explicit choice that cannot be
// resolved is refused, never defaulted.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { resolveBuilderRole, validateBuilderRole } = require('./workflow');

const CONFIG = {
  roles: {
    review: [
      { role: 'Security', skill: 'security', command: 'security.md' },
      { role: 'QA', skill: 'qa_review', command: 'qa_review.md' },
    ],
    execution: [
      { role: 'Android Dev', skill: 'android_dev', command: 'android_dev.md' },
      { role: 'iOS Dev', skill: 'ios_dev', command: 'ios_dev.md' },
      { role: 'Frontend Dev', skill: 'frontend_dev', command: 'frontend_dev.md' },
    ],
    standalone: [{ role: 'QA', skill: 'qa', command: 'qa.md' }],
  },
};

// ── accepting a real choice ──────────────────────────────────────────────────

test('a role is accepted by its display name', () => {
  assert.equal(validateBuilderRole(CONFIG, 'iOS Dev').role.role, 'iOS Dev');
});

test('a role is accepted by skill, slug and slash form', () => {
  // These are the shapes that actually arrive — a picker sends the name, a
  // hand-written request or a PRD field may send any of the others.
  assert.equal(validateBuilderRole(CONFIG, 'android_dev').role.role, 'Android Dev');
  assert.equal(validateBuilderRole(CONFIG, 'frontend dev').role.role, 'Frontend Dev');
  assert.equal(validateBuilderRole(CONFIG, '/ios_dev').role.role, 'iOS Dev');
});

test('matching is case-insensitive', () => {
  assert.equal(validateBuilderRole(CONFIG, 'ANDROID DEV').role.role, 'Android Dev');
});

// ── refusing, rather than quietly defaulting ─────────────────────────────────

test('an unknown role is an error, not a fallback to execution[0]', () => {
  // The whole point. Falling back here would build under a role the owner did
  // not choose while the UI said otherwise — the exact silent failure the
  // picker exists to remove.
  const r = validateBuilderRole(CONFIG, 'Backend Dev');
  assert.ok(r.error, 'expected a refusal');
  assert.equal(r.role, undefined);
  assert.match(r.error, /Android Dev, iOS Dev, Frontend Dev/, 'the error must name the real options');
});

test('a review-only role cannot be selected as the builder', () => {
  // findRole treats a category as a PREFERENCE, not a filter, so 'Security'
  // resolves against the review list and comes back a valid role object. The
  // membership check is what stops it being launched as a builder.
  const r = validateBuilderRole(CONFIG, 'Security');
  assert.ok(r.error, 'a review role must not be buildable');
});

test('a name that exists in two categories resolves to the execution one or is refused', () => {
  // 'QA' is in both review and standalone here, and neither is an execution
  // role — so it must be refused rather than silently resolving elsewhere.
  assert.ok(validateBuilderRole(CONFIG, 'QA').error);
});

test('an empty or missing name is refused', () => {
  assert.ok(validateBuilderRole(CONFIG, '').error);
  assert.ok(validateBuilderRole(CONFIG, null).error);
  assert.ok(validateBuilderRole(CONFIG, undefined).error);
});

test('a project with no execution roles says so, rather than naming an empty list', () => {
  const r = validateBuilderRole({ roles: { review: [] } }, 'iOS Dev');
  assert.match(r.error, /no roles\.execution configured/);
});

// ── the two halves compose ───────────────────────────────────────────────────

test('a validated name resolves through the same path a bugfix role does', () => {
  // The monolithic shortcut calls resolveBuilderRole({ role: wf.builderRole }).
  // This is the seam: a name that validated at start must resolve at launch.
  for (const name of ['Android Dev', 'ios_dev', 'Frontend Dev']) {
    const picked = validateBuilderRole(CONFIG, name);
    assert.ok(picked.role, `${name} should validate`);
    assert.equal(resolveBuilderRole(CONFIG, { role: picked.role.role }).role, picked.role.role);
  }
});

test('no builderRole keeps the previous behaviour — execution[0]', () => {
  // Absent selection must be exactly today's default, or this change would
  // alter every existing project's runs rather than adding an option.
  assert.equal(resolveBuilderRole(CONFIG, { role: undefined }).role, 'Android Dev');
  assert.equal(resolveBuilderRole(CONFIG, {}).role, 'Android Dev');
});

test('the resolved role carries the fields the launcher needs', () => {
  // The launcher reads .command for the role file and .role for the display
  // name; a bare string would launch an agent with no command file.
  const r = validateBuilderRole(CONFIG, 'Android Dev').role;
  assert.equal(r.command, 'android_dev.md');
  assert.equal(r.skill, 'android_dev');
});
