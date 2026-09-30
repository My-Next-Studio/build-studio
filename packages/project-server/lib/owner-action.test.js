'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { extractOwnerAction } = require('./owner-action');

test('the heading form: everything up to the next heading or fence', () => {
  const fb = [
    '## Fix plan', '', '0 tasks.', '',
    '### Owner action required', '',
    '1. Run QA-172 §6 on a physical device.', '2. Fill in the evidence record.', '',
    '### Notes', 'unrelated', '', '```json', '{ "tasks": [] }', '```',
  ].join('\n');
  assert.equal(extractOwnerAction(fb), '1. Run QA-172 §6 on a physical device.\n2. Fill in the evidence record.');
});

// fazon FAZ-272, 2026-09-30: written before the heading was asked for.
test('the bold lead-in form a planner wrote before the heading existed', () => {
  const fb = [
    '**0 agent tasks.** One finding: AC-7 is unverified.', '',
    '**Owner action (not dispatched):** Run QA-172 §6 on a physical device. Record:', '',
    '- the build number', '- the screenshots', '', 'After that, re-run code_review.', '',
    '```json', '{ "tasks": [] }', '```',
  ].join('\n');
  const out = extractOwnerAction(fb);
  assert.match(out, /^Run QA-172 §6 on a physical device\. Record:/);
  assert.match(out, /- the screenshots/);
  assert.match(out, /re-run code_review\.$/);
  assert.doesNotMatch(out, /tasks/);
});

test('a normal plan, or an empty section, has no owner action', () => {
  assert.equal(extractOwnerAction('## Fix plan\n\nTwo tasks.\n\n```json\n{"tasks":[{"id":1}]}\n```'), null);
  assert.equal(extractOwnerAction('### Owner action required\n\n### Notes\nx'), null);
  assert.equal(extractOwnerAction(''), null);
});

test('the gate and the planner prompt use the owner-action section', () => {
  const src = fs.readFileSync(path.join(__dirname, 'api', 'workflow.js'), 'utf8');
  assert.match(src, /const ownerAction = hasFindings && !body\.override \? extractOwnerAction\(plannerFeedback\) : null;/);
  assert.match(src, /Waiting on you: owner action required/);
  assert.match(src, /under a heading exactly \\`### Owner action required\\`/);
});
