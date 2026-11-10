'use strict';

// A kickoff whose inputs defer decisions: devops_init waits for ADR-001, a
// Scaffold run does the work later, and the review cap stops instead of
// skipping companion_specs. Source-text tests like the other kickoff routing
// tests: what is pinned is routing between handlers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, 'workflow.js'), 'utf8');
const region = (start, end) => {
  const i = SRC.indexOf(start);
  assert.ok(i > 0, `not found: ${start}`);
  const j = end ? SRC.indexOf(end, i) : i + 4000;
  assert.ok(j > i, `end not found: ${end}`);
  return SRC.slice(i, j);
};
const kickoff = () => region('function handleKickoffAdvance(wf, action, notes, res) {', '  // --- Scaffold workflow ---');

test('no kickoff prompt tells agents to read every input file blindly', () => {
  assert.doesNotMatch(SRC, /Read all files in docs\/inputs\//);
  const k = kickoff();
  assert.match(k, /kickoffPrompts\.ceoSynthesisPrompt\(\{ skill, inputsGuide: guide\(\)/);
  assert.match(k, /kickoffPrompts\.pmScopingPrompt\(\{ skill, inputsGuide: guide\(\)/);
  assert.match(k, /kickoffPrompts\.companionSpecAgents\(\{ findRole, config, inputsGuide: guide\(\)/);
  assert.match(k, /const guide = \(\) => inputsGuide\(path\.join\(docsPath, 'inputs'\)\);/);
});

test('team review and PM revision carry the deferral rule', () => {
  const k = kickoff();
  assert.match(k, /6\. \$\{kickoffPrompts\.DEFERRED_DECISIONS_REVIEW_RULE\}/);
  assert.match(k, /\$\{kickoffPrompts\.DEFERRED_DECISIONS_RULE\}\\n\\nA reviewer may ask you to settle a decision the inputs defer/);
  // The orchestrator review mode gets it too, for kickoff runs only.
  assert.match(SRC, /\$\{wf\.type === 'kickoff' \? `\\n\\n\$\{kickoffPrompts\.DEFERRED_DECISIONS_REVIEW_RULE\}` : ''\}/);
});

test('devops_init checks ADR-001 before it launches, and skips with a note while it is Pending', () => {
  const d = region("    if (wf.currentStep === 'devops_init' && wf.steps.devops_init.status === 'pending') {", "    if (wf.currentStep === 'devops_init' && (action === 'approve' || action === 'skip')) {");
  const check = d.indexOf('const stack = stackDecision(docsPath);');
  const launch = d.indexOf('launchWorkflowAgents(');
  assert.ok(check > 0 && launch > check, 'the check comes before any launch');
  assert.match(d, /if \(stack\.exists && stack\.pending\) \{/);
  assert.match(d, /deferred: \{ reason: 'stack_pending', adr: stack\.file \}/);
  assert.match(d, /start a Scaffold run under Project/);
  assert.match(d, /return advanceKickoff\('devops_init', 'completed'\);/);
});

test('devops_init moves on by the sequence, not to a hard-coded end', () => {
  const k = kickoff();
  const tail = k.slice(k.indexOf("    // --- DevOps Init step ---"));
  assert.doesNotMatch(tail.slice(0, tail.indexOf("action === 'request_changes'")), /wf\.currentStep = 'completed';/);
  assert.match(tail, /if \(wf\.currentStep === 'devops_init' && \(action === 'approve' \|\| action === 'skip'\)\) \{\n\s+wf\.steps\.devops_init\.status = action === 'skip' \? 'skipped' : 'completed';\n\s+return advanceKickoff\('devops_init', 'completed'\);/);
});

test('the review cap no longer jumps to devops_init: it refuses before changing anything', () => {
  const r = region("    if (wf.currentStep === 'pm_revision' && action === 'request_changes') {", "    return res.status(400).json({ error: `no valid transition");
  assert.doesNotMatch(r, /currentStep = 'devops_init'/);
  const guard = r.indexOf('if (capExceeded({ ...wf, round: (wf.round || 1) + 1 })) {');
  const mutate = r.indexOf('wf.round++');
  assert.ok(guard > 0 && mutate > guard, 'checks the cap before bumping the round');
  assert.match(r, /res\.status\(409\)/);
  assert.match(r, /Approve PM Revision to move on/);
});

test('auto-iterate records where it stopped at the cap, for needs-attention', () => {
  const a = region('  function autoAdvanceWorkflow(wf) {');
  assert.match(a, /wf\.autoIterateCapped = \{ round: wf\.round, step: wf\.currentStep, maxRounds: MAX_REVIEW_ROUNDS \};/);
});

test('a Scaffold run is a workflow type with its own two-step sequence', () => {
  assert.match(SRC, /const SCAFFOLD_STEPS = \['scaffold_plan', 'devops_init'\];/);
  assert.match(SRC, /if \(wf && wf\.type === 'scaffold'\) return SCAFFOLD_STEPS\.slice\(\);/);
  assert.match(SRC, /\['review', 'execution', 'kickoff', 'onboarding', 'bugfix', 'reconcile', 'scaffold'\]\.includes\(type\)/);
  assert.match(SRC, /if \(wf\.type === 'scaffold'\) \{\n\s+return handleScaffoldAdvance\(wf, effectiveAction, res\);/);
});

test('a Scaffold run starts only once ADR-001 exists and is decided, and needs DevOps', () => {
  const s = region("    } else if (type === 'scaffold') {", "    } else if (type === 'onboarding') {");
  assert.match(s, /if \(!stack\.exists\) \{\n\s+return reply\(400/);
  assert.match(s, /if \(stack\.pending\) \{\n\s+return reply\(409/);
  assert.match(s, /findRole\(config, 'DevOps'\)/);
  assert.match(s, /currentStep = SCAFFOLD_STEPS\[0\];/);
});

test('kickoff and scaffold need no input; review and execution still do', () => {
  assert.match(SRC, /if \(!\['onboarding', 'kickoff', 'scaffold'\]\.includes\(type\) && !input\) return reply\(400, \{ error: 'input required' \}\);/);
  assert.match(SRC, /type, input: input \|\| '', prdPath,/);
});

test('the scaffold plan is approved only with a report, and devops_init gets the approved plan', () => {
  const h = region('  function handleScaffoldAdvance(wf, action, res) {', '  // --- Onboarding workflow (PRD-001) ---');
  assert.match(h, /if \(!plan\) \{\n\s+return res\.status\(409\)/);
  assert.match(h, /wf\.approvedScaffoldPlan = plan;/);
  assert.match(h, /approvedPlan: wf\.approvedScaffoldPlan \|\| null/);
  // ADR-001 is re-checked when the plan step launches.
  const launch = h.indexOf("return launch('scaffold_plan'");
  assert.ok(h.lastIndexOf('stackDecision(docsPath)', launch) > 0);
  // Skipping the plan ends the run with nothing built.
  assert.match(h, /if \(action === 'skip'\) \{\n\s+step\.status = 'skipped';\n\s+wf\.steps\.devops_init = \{ \.\.\.\(wf\.steps\.devops_init \|\| \{\}\), status: 'skipped', agents: \[\] \};/);
});

test('neither auto-advance approves the scaffold plan', () => {
  const tick = region('  function serverSideAutoAdvanceTick() {');
  assert.match(tick, /if \(wf\.currentStep === 'scaffold_plan' && !isPending\) return;/);
  const hub = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'hub', 'components', 'workflow-view.tsx'), 'utf8');
  assert.match(hub, /if \(wf\.currentStep === 'scaffold_plan' && !isPending\) return/);
});

test('the kickoff\'s preset sequences still end at devops_init, which removing still drops', () => {
  const { PRESETS } = require('../presets');
  const { sequenceNextStep } = require('./workflow');
  const seq = PRESETS['web-app'].workflow.kickoff.filter((s) => s !== 'devops_init');
  assert.equal(sequenceNextStep(seq, 'companion_specs', 'devops_init'), 'completed');
});
