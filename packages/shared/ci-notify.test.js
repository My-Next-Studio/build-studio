'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diffCiStates, ciStatesFromStatuses, conclusionsOf } = require('./ci-notify');

test('a project seen for the first time is seeded silently', () => {
  // Otherwise every app launch greets you with alarms for failures that may be
  // a week old — the fastest way to train someone to ignore notifications.
  const events = diffCiStates({}, { launch: { conclusion: 'failure' } });
  assert.deepEqual(events, []);
});

test('green → red notifies', () => {
  const events = diffCiStates(
    { launch: 'success' },
    { launch: { conclusion: 'failure', title: 'fix: broken thing', url: 'u' } }
  );
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'failed');
  assert.match(events[0].title, /launch — CI failed/);
  assert.equal(events[0].body, 'fix: broken thing');
  assert.equal(events[0].url, 'u');
});

test('red → green notifies the recovery', () => {
  const events = diffCiStates({ p: 'failure' }, { p: { conclusion: 'success' } });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'recovered');
  assert.match(events[0].title, /recovered/);
});

test('an unchanged state notifies nothing, however often it is polled', () => {
  // The red pulse already represents the condition; notifications are only for
  // the moment it changes.
  assert.deepEqual(diffCiStates({ p: 'failure' }, { p: { conclusion: 'failure' } }), []);
  assert.deepEqual(diffCiStates({ p: 'success' }, { p: { conclusion: 'success' } }), []);
});

test('green from nothing is not a "recovery"', () => {
  // null → success happens when a repo gets its first run; nobody was waiting.
  assert.deepEqual(diffCiStates({ p: null }, { p: { conclusion: 'success' } }), []);
});

test('churn that is not a red/green transition stays quiet', () => {
  assert.deepEqual(diffCiStates({ p: 'success' }, { p: { conclusion: null } }), []);
  assert.deepEqual(diffCiStates({ p: 'failure' }, { p: { conclusion: 'cancelled' } }), []);
});

test('several projects transitioning in one tick each get an event', () => {
  const events = diffCiStates(
    { a: 'success', b: 'failure', c: 'success' },
    { a: { conclusion: 'failure' }, b: { conclusion: 'success' }, c: { conclusion: 'success' } }
  );
  assert.deepEqual(events.map((e) => [e.project, e.kind]), [['a', 'failed'], ['b', 'recovered']]);
});

test('a stopped project is omitted, so stopping it is not a state change', () => {
  const states = ciStatesFromStatuses([
    { name: 'up', running: true, ci: { conclusion: 'failure', title: 't', url: 'u' } },
    { name: 'down', running: false, ci: { conclusion: 'success' } },
    { name: 'noRepo', running: true, ci: null },
  ]);
  assert.deepEqual(Object.keys(states), ['up']);

  // And the consequence that matters: stopping a project then starting it again
  // must not read as a recovery.
  const prev = conclusionsOf(states);
  assert.deepEqual(diffCiStates(prev, ciStatesFromStatuses([{ name: 'up', running: false, ci: null }])), []);
});

test('conclusionsOf reduces to a storable baseline', () => {
  assert.deepEqual(
    conclusionsOf({ a: { conclusion: 'failure', title: 'x' }, b: { conclusion: null } }),
    { a: 'failure', b: null }
  );
});

test('a missing title degrades to a readable body rather than "undefined"', () => {
  const [e] = diffCiStates({ p: 'success' }, { p: { conclusion: 'failure' } });
  assert.equal(e.body, 'the latest push run failed');
  assert.equal(e.url, null);
});

test('a very long run title is truncated for the notification body', () => {
  const [e] = diffCiStates({ p: 'success' }, { p: { conclusion: 'failure', title: 'x'.repeat(400) } });
  assert.equal(e.body.length, 120);
});
