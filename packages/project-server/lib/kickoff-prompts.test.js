'use strict';

// What each kickoff step asks of its agents when the inputs defer decisions
// (lib/kickoff-prompts.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('./kickoff-prompts');

const GUIDE = '## How to read the inputs\n\n| File | Size | How to read it |';
const COMMIT = 'Commit on the current branch.';

test('the CEO no longer fills in every section, and carries the deferral rule and the guide', () => {
  const s = p.ceoSynthesisPrompt({ skill: 'ceo', inputsGuide: GUIDE, commitRule: COMMIT });
  assert.doesNotMatch(s, /Fill in all sections/);
  assert.doesNotMatch(s, /Read all files in docs\/inputs/);
  assert.match(s, /Fill in each section of the vision template that the inputs support/);
  assert.ok(s.includes(p.DEFERRED_DECISIONS_RULE));
  assert.ok(s.includes(GUIDE));
  assert.ok(s.endsWith(COMMIT));
});

test('the deferral rule covers every timing, and the interview\'s own format', () => {
  const r = p.DEFERRED_DECISIONS_RULE;
  assert.match(r, /Kickoff decisions/);
  assert.match(r, /\*\*Open question from the kickoff inputs \(<YYYY-MM-DD>\) → owner:\*\* <the question>\. Ask when drafting this story\./);
  assert.match(r, /Open Questions section of docs\/vision\.md, with the phase/);
  assert.match(r, /wait on an investigation or spike:\*\* do not select, not even provisionally/);
  assert.match(r, /Hypotheses stay hypotheses/);
  assert.match(r, /Where the inputs give no timing, decide as usual/);
});

test('the format matches what draft_prd picks up', () => {
  const fs = require('fs');
  const path = require('path');
  const skill = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'templates', 'default', '.claude', 'skills', 'draft_prd', 'SKILL.md'), 'utf8');
  assert.match(skill, /`Open question from … → owner`/);
  assert.match(p.DEFERRED_DECISIONS_RULE, /Open question from the kickoff inputs .* → owner:/);
});

test('the PM scopes around deferred decisions and plans the investigation', () => {
  const s = p.pmScopingPrompt({ skill: 'pm', inputsGuide: GUIDE, commitRule: COMMIT });
  assert.ok(s.includes(p.DEFERRED_DECISIONS_RULE));
  assert.match(s, /Move each feature-timed question that docs\/vision\.md lists under Open Questions onto the item/);
  assert.match(s, /investigation or spike before a decision, add it as a backlog item \(type Task\)/);
  assert.match(s, /The first PRD must not settle a decision the inputs defer/);
  // What it asked before is still there.
  assert.match(s, /PRD-004 per-item format/);
  assert.match(s, /visual design workflow/);
  assert.ok(s.includes(GUIDE));
});

function agentsFor(roles) {
  const findRole = (_c, name) => (roles.includes(name) ? { role: name, skill: name.toLowerCase() } : null);
  return p.companionSpecAgents({ findRole, config: {}, inputsGuide: GUIDE, commitRule: COMMIT });
}

test('the Architect writes a Pending ADR-001 instead of selecting, when the inputs defer the stack', () => {
  const [arch] = agentsFor(['Architect']);
  assert.equal(arch.role, 'Architect');
  const s = arch.instruction;
  assert.match(s, /do not select it, not even provisionally/);
  assert.match(s, /Write ADR-001 with `\*\*Status:\*\* Pending` near the top/);
  for (const part of ['the candidates', 'the evaluation criteria', 'the investigation', 'the decision gate', 'what is blocked until then']) {
    assert.ok(s.includes(part), part);
  }
  assert.match(s, /Scaffold run/);
  assert.match(s, /except where the inputs defer a decision: there, record the open decision precisely/);
  assert.ok(s.includes(GUIDE), 'the Architect reads the inputs');
});

test('DevOps writes only the stack-independent parts of ADR-002 while the stack is deferred', () => {
  const [devops] = agentsFor(['DevOps']);
  assert.match(devops.instruction, /write the parts of ADR-002 that do not depend on it/);
  assert.match(devops.instruction, /mark the stack-dependent parts as pending on ADR-001/);
  assert.match(devops.instruction, /Do not choose CI tooling or a deployment target that presupposes a stack/);
});

test('the other spec roles get the rule but not the inputs guide; missing roles are skipped', () => {
  const agents = agentsFor(['Brand', 'UX']);
  assert.deepEqual(agents.map((a) => a.role), ['Brand', 'UX']);
  for (const a of agents) {
    assert.ok(a.instruction.includes(p.DEFERRED_DECISIONS_RULE), a.role);
    assert.ok(!a.instruction.includes(GUIDE), a.role);
    assert.doesNotMatch(a.instruction, /ADR-001 with/);
  }
});

test('devops_init keeps its kickoff instruction, and follows an approved plan when given one', () => {
  const plain = p.devopsInitPrompt({ skill: 'devops', config: {}, commitRule: COMMIT });
  assert.match(plain, /Initialize the framework/);
  assert.doesNotMatch(plain, /The plan the owner approved/);
  const planned = p.devopsInitPrompt({ skill: 'devops', config: {}, commitRule: COMMIT, approvedPlan: '1. Scaffold: create-next-app' });
  assert.match(planned, /## The plan the owner approved/);
  assert.match(planned, /Creating, linking or provisioning anything it does not name needs the owner first/);
  assert.ok(planned.includes('1. Scaffold: create-next-app'));
});

test('the scaffold plan changes nothing and lists what would be provisioned', () => {
  const s = p.scaffoldPlanPrompt({ skill: 'devops', adrFile: 'docs/adrs/ADR-001-stack.md' });
  assert.match(s, /`docs\/adrs\/ADR-001-stack\.md`/);
  assert.match(s, /Change nothing in this step/);
  assert.match(s, /\*\*Provisioning:\*\*/);
  assert.match(s, /Write "None" when nothing is provisioned/);
  assert.match(s, /\*\*Needs the owner:\*\*/);
});

test('reviewers do not treat a deferred decision as a gap', () => {
  assert.match(p.DEFERRED_DECISIONS_REVIEW_RULE, /A decision the inputs defer is not a gap/);
  assert.match(p.DEFERRED_DECISIONS_REVIEW_RULE, /Do raise a deferred decision that was settled anyway/);
});
