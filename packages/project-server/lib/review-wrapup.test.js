'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { wrapupActive, buildWrapupBlock } = require('./review-wrapup');

test('inactive at or under the cap — early rounds keep the fresh-lens contract', () => {
  assert.equal(wrapupActive(1, 4, {}), false);
  assert.equal(wrapupActive(4, 4, {}), false);
});

test('active on every round past the cap', () => {
  assert.equal(wrapupActive(5, 4, {}), true);
  assert.equal(wrapupActive(7, 4, {}), true);
  assert.equal(wrapupActive(3, 2, {}), true);
});

test('config opt-out disables it; absent/partial config does not', () => {
  assert.equal(wrapupActive(7, 4, { final_review: { wrapup_past_cap: false } }), false);
  assert.equal(wrapupActive(7, 4, { final_review: {} }), true);
  assert.equal(wrapupActive(7, 4, undefined), true);
  assert.equal(wrapupActive(7, 4, { final_review: { effort: 'high' } }), true);
});

test('garbage rounds never activate', () => {
  assert.equal(wrapupActive(undefined, 4, {}), false);
  assert.equal(wrapupActive(NaN, 4, {}), false);
  assert.equal(wrapupActive(5, undefined, {}), false);
});

test('block carries the contract: what blocks, what files as follow-ups, the mode line', () => {
  const block = buildWrapupBlock(7, 4);
  assert.match(block, /WRAP-UP MODE/);
  assert.match(block, /round 7, cap 4/);
  assert.match(block, /REGRESSION/);
  assert.match(block, /INCOMPLETE FIX/);
  assert.match(block, /Must NOT block/);
  assert.match(block, /follow-up material BY DEFINITION/);
  assert.match(block, /### Follow-up proposals \(file as backlog items\)/);
  assert.match(block, /\*\*Mode:\*\* wrap-up \(round 7, cap 4\)/);
  assert.match(block, /not a rubber stamp/);
});
