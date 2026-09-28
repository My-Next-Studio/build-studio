'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

// The 45-minute task-overrun escalation is for fine-grained tasks. A monolithic
// run's single task is the whole build; the escalation's "Kill-and-skip" there
// would throw the build away (fazon FAZ-361, 2026-09-28).
test('task wall-clock overrun is not raised for a monolithic run', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, 'overseer.js'), 'utf8');
  const i = src.indexOf('function detectTaskWallclockOverrun(wf) {');
  assert.ok(i > 0);
  const body = src.slice(i, src.indexOf('\n  }\n', i));
  const guard = body.indexOf('if (wf.taskPlan && wf.taskPlan.monolithic) return candidates;');
  assert.ok(guard > 0, 'monolithic guard missing');
  assert.ok(guard < body.indexOf('for (const [idx, ts]'), 'guard must come before the task scan');
});
