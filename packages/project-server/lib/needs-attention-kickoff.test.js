'use strict';

// needs-attention for the deferred-decision kickoff: the auto-iterate cap stop,
// the scaffold plan waiting for the owner, and a kickoff that ended without a
// scaffold on purpose.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deriveNeedsAttention } = require('./needs-attention');

const done = (role, feedback = 'report') => ({ role, status: 'done', feedback });

test('auto-iterate stopping at the cap is reported while the run sits where it stopped', () => {
  const wf = {
    type: 'kickoff', currentStep: 'team_review', round: 5,
    autoIterateCapped: { round: 5, step: 'team_review', maxRounds: 5 },
    steps: { team_review: { status: 'running', agents: [done('UX'), done('Architect')] } },
  };
  const n = deriveNeedsAttention(wf);
  assert.equal(n.reason, 'auto_iterate_capped');
  assert.match(n.detail, /ran 5 round\(s\), the cap set by max_review_rounds \(5\)/);
  assert.match(n.action, /approve team_review to continue by hand/);
});

test('the cap signal goes away once the run moves on', () => {
  const moved = {
    type: 'kickoff', currentStep: 'pm_revision', round: 5,
    autoIterateCapped: { round: 5, step: 'team_review', maxRounds: 5 },
    steps: { team_review: { status: 'completed', agents: [done('UX')] }, pm_revision: { status: 'running', agents: [{ role: 'PM', status: 'running' }] } },
  };
  assert.equal(deriveNeedsAttention(moved), null);
});

test('not while the capped step\'s agents are still running', () => {
  const wf = {
    type: 'kickoff', currentStep: 'team_review', round: 5,
    autoIterateCapped: { round: 5, step: 'team_review', maxRounds: 5 },
    steps: { team_review: { status: 'running', agents: [done('UX'), { role: 'QA', status: 'running' }] } },
  };
  assert.equal(deriveNeedsAttention(wf), null);
});

test('the scaffold plan waits for the owner once DevOps has reported it', () => {
  const running = { type: 'scaffold', currentStep: 'scaffold_plan', round: 1, steps: { scaffold_plan: { status: 'running', agents: [{ role: 'DevOps', status: 'running' }] } } };
  assert.equal(deriveNeedsAttention(running), null, 'not while DevOps is still working');
  const reported = { ...running, steps: { scaffold_plan: { status: 'running', agents: [done('DevOps', '1. Scaffold …')] } } };
  const n = deriveNeedsAttention(reported);
  assert.equal(n.reason, 'human_gate');
  assert.equal(n.title, 'The scaffold plan is waiting for you');
  assert.match(n.action, /Approve to carry it out, or Skip/);
});

test('a kickoff that deferred its scaffold says so when it finishes', () => {
  const wf = {
    type: 'kickoff', currentStep: 'completed', input: '',
    steps: { devops_init: { status: 'skipped', deferred: { reason: 'stack_pending', adr: 'docs/adrs/ADR-001-stack.md' } } },
  };
  const n = deriveNeedsAttention(wf);
  assert.equal(n.reason, 'completed_not_finished');
  assert.match(n.detail, /The kickoff run completed\./);
  assert.match(n.detail, /Nothing was scaffolded or provisioned: docs\/adrs\/ADR-001-stack\.md is Pending/);
  assert.match(n.detail, /start a Scaffold run under Project/);
});
