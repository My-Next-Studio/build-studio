'use strict';

/**
 * The lean execution preset: one orchestrating builder, one review, the same
 * gates. See docs/plans/lean-execution-trial.md for why it exists and how it is
 * compared with the full chain.
 *
 * A lean run is an ordinary execution run with `wf.preset = 'lean'`. It reuses
 * the execution machinery step for step and changes three things:
 *
 * - the sequence. No qa_tests, and no separate review steps after the merge.
 *   Planning stays in the list only because it is where the single-task plan is
 *   synthesised; no planner agent runs.
 * - the builder's prompt. It orchestrates: a test-writer subagent that sees the
 *   PRD and never the implementation replaces qa_tests, and implementer
 *   subagents are optional.
 * - qa_validation becomes the one review. It keeps every QA gate (the native
 *   suite run, the strict test-count gates) and its agent also reviews the
 *   diff, covering what the dropped review steps checked.
 *
 * Fix rounds skip the fix planner: the findings go straight to the builder's
 * role, which orchestrates the fix the same way, and the re-review reads only
 * the fix round's diff while the full suite still runs.
 *
 * Claude only, because the orchestration relies on Claude Code's Agent tool. A
 * lean run whose build steps resolve to another CLI is refused at start, never
 * quietly run as the full chain.
 *
 * Everything here is pure: no I/O, so the prompts and the routing can be tested
 * without a workflow.
 */

const LEAN_PRESET = 'lean';
const FULL_PRESET = 'full';
const EXECUTION_PRESETS = [FULL_PRESET, LEAN_PRESET];

const LEAN_EXECUTION_STEPS = [
  'planning', 'task_execution', 'merge_for_review', 'qa_validation', 'merge_to_main', 'capture_learnings',
];

/** The steps that write code, and so must run on Claude in a lean run. */
const LEAN_CLAUDE_STEPS = ['task_execution', 'fix_execution'];

function isLean(wf) {
  return !!wf && wf.type === 'execution' && wf.preset === LEAN_PRESET;
}

/**
 * Validate a `preset` on a start request. Returns { preset, defaulted } or
 * { error }. `preset` is null for the full chain.
 *
 * Lean is the default: an execution start without a preset is lean, with
 * `defaulted: true`, and `full` asks for the full chain. Only execution runs
 * have a choice.
 */
function validatePreset(type, preset) {
  if (preset === undefined || preset === null || preset === '') {
    return type === 'execution' ? { preset: LEAN_PRESET, defaulted: true } : { preset: null };
  }
  if (!EXECUTION_PRESETS.includes(preset)) {
    return { error: `preset must be one of: ${EXECUTION_PRESETS.join(', ')}` };
  }
  if (type !== 'execution') {
    return { error: `preset applies to execution runs only, not ${type}` };
  }
  return { preset: preset === FULL_PRESET ? null : preset };
}

/**
 * Why a lean run cannot start, or null. `cliFor(step)` returns the CLI that
 * step resolves to for this run.
 */
function leanStartRefusal(cliFor) {
  const offenders = LEAN_CLAUDE_STEPS
    .map((step) => ({ step, cli: cliFor(step) }))
    .filter((s) => s.cli !== 'claude');
  if (!offenders.length) return null;
  const list = offenders.map((s) => `${s.step} runs on ${s.cli}`).join(', ');
  return `A lean run needs Claude for the build steps, because the builder orchestrates subagents with Claude Code's Agent tool: ${list}. `
    + 'Set the Build group to Claude on the Model page, or start the full chain instead.';
}

/**
 * The chain a start request runs, from validatePreset's result and the lean
 * refusal (or null). A lean run the owner asked for by name is refused rather
 * than quietly run as the full chain; a defaulted one falls back to the full
 * chain, so a project whose build steps run on another CLI keeps starting runs.
 * Returns { preset } or { refusal }, plus `fallback` (the refusal text) when it
 * fell back.
 */
function resolveStartPreset(presetCheck, refusal) {
  if (presetCheck.preset !== LEAN_PRESET || !refusal) return { preset: presetCheck.preset };
  if (presetCheck.defaulted) return { preset: null, fallback: refusal };
  return { refusal };
}

/** The step a finished lean fix round returns to: the review that raised it. */
function leanFixReturnStep(wf) {
  return (wf && wf.fixSource) || 'qa_validation';
}

/** The single task a lean run builds, in place of the monolithic default's. */
function leanTaskDescription(prdPath) {
  return `Read the PRD in full at ${prdPath}. Implement every acceptance criterion and surface it specifies. `
    + 'There are no pre-implementation tests in this run: the test writer you start (below) writes them from the PRD. '
    + 'Commit per logical chunk; the dashboard shows each commit as a milestone. When every AC is implemented and the suites below pass, POST feedback summarising what was built, what is tested, and any residual concerns.';
}

const SUBAGENT_RULES = `### Subagents — the rules that keep them safe
- **Give every implementer an explicit boundary**: the files or module it owns. Two subagents never edit the same file. The harness refuses an edit to a file that changed since it was read, but it does not catch two valid edits that disagree.
- **Run a test suite only while no subagent is editing.** A run against someone's half-finished change fails for the wrong reason.
- **Pick the model per subagent**: a simpler model for routine, well-specified parts; the strongest for hard ones.
- **You stay responsible for the result.** Read what each subagent reports, check its work landed, and commit. A subagent's "done" is not evidence.`;

/**
 * The orchestration section appended to the lean builder's prompt.
 * `testClause` and `testGuidance` are builderTestRequirement(...)'s goalClause
 * and guidance: the same suites, and the same scope limits, as the
 * full chain's builder must pass.
 */
function leanBuilderSection({ prdPath, testClause, testGuidance }) {
  return `

## LEAN RUN — YOU ORCHESTRATE THIS BUILD

This run has no separate QA-tests step and no review panel. You plan the work, delegate where it pays, and deliver a tested, committed implementation. One independent review follows, on another session.

### 1. Plan
Read the PRD and the code it touches. Write a short plan: the parts of the work, and which of them are independent.

### 2. Tests from the spec — a separate subagent (required)
Before or while you implement, start ONE test-writer subagent with the Agent tool. Give it:
- the PRD path (${prdPath}) and the project's test conventions (where tests live, how they are named and run);
- the instruction to write tests for every acceptance criterion, from the PRD alone.
Do **not** give it your implementation, your plan's code details, or a diff, and tell it not to read the files you are changing. Tests shaped to the code cannot catch the code being wrong: that independence is the reason this subagent exists. It may read existing tests and test helpers to follow their conventions.
When it reports, run its tests against your implementation. A failing spec test is a finding about the code until shown otherwise; do not edit a spec test to make it pass without saying why in your feedback.

### 3. Implement — delegate where it pays
Do small stories yourself: every subagent re-reads the code it needs, so delegation costs time and tokens. Delegate parts that are independent and sizeable.

${SUBAGENT_RULES}

### 4. Review before you report
Start a review subagent on your diff (\`git diff\` against the default branch) with the PRD. Fix what it finds that is real. This is a first pass inside your own framing, not the independent review, so do not cite it as one.

### 5. Done means
Every AC implemented, the spec tests passing, ${testClause}, everything committed on the current branch, and the feedback POST sent. In the feedback, add a \`### Subagents\` section: one line per subagent (purpose, model, outcome).${testGuidance ? `

### Which tests to run
${testGuidance}` : ''}`;
}

/**
 * The prompt section for a lean fix round. The findings come straight from the
 * review; there is no fix planner.
 */
function leanFixSection({ prdPath, findings, notes }) {
  return `

## LEAN FIX ROUND — YOU ORCHESTRATE THE FIX

The review below found problems. There is no fix planner in a lean run: you get the findings and the PRD (${prdPath}), and you decide how to fix them.

### Findings from the review
${findings}
${notes ? `\n### Owner notes\n${notes}\n` : ''}
### How to work
- **Read the PRD for each finding**, not just the finding: a fix that satisfies the reviewer and breaks the spec is not a fix.
- **Delegate only where it pays.** A two-line fix is yours; delegation is for independent, sizeable fixes.
- **A test for each defect** that fails without the fix and passes with it, where the defect can be tested. If one cannot be, say why.
- **Commit per finding**, naming it in the message.
- **Do not run the UI test suites or any full end-to-end suite.** The review step re-runs the suite, with the project's scope, straight after this round; running it here too doubles the slowest part of every round.

${SUBAGENT_RULES}

### Done means
Every finding fixed, or answered with a reason it is not a defect; the tests for each fix, and the tests covering the code you changed, pass; everything committed on the current branch; and the feedback POST sent, listing each finding with its fix commit or the reason.`;
}

/**
 * The header for qa_validation in a lean run, replacing the test-runner-only
 * header the full chain uses. The QA sections that follow it (suite commands,
 * gates, visual smoke, cleanup) apply unchanged.
 */
function leanReviewHeader() {
  return `## YOU ARE THE REVIEWER FOR THIS RUN — TESTS AND CODE REVIEW IN ONE STEP — NOT A FIX AGENT

**This is a lean run: you are its only independent review.** You do two things: run the test suite and report what happened, then review the change against the PRD. You do NOT write code, fix bugs, or commit.

**FORBIDDEN FEEDBACK FORMAT** — your feedback will be REJECTED if you use any of these patterns (fix-report formats, used by developers in another step):
- \`**All issues addressed:** yes|no\` / \`**Committed:** <hash>\` / \`### Changes\` listing files you modified
- Any phrasing that implies you made code changes

**REQUIRED FEEDBACK FORMAT** — your feedback MUST contain:
- \`**Approved:** yes | no\`
- \`**Blocking:** N  |  **Medium:** N  |  **Low:** N\`
- test counts the approval gate can parse: \`**Tests passed:** N/M\`, or the runner's \`N passed\` / \`N failed\` lines, or \`Executed N tests, with M failures\`
- \`### Summary\`, \`### Findings\`, \`### AC Coverage\`, \`### Action Items\` sections

**IF YOU CANNOT RUN TESTS** (toolchain missing, environment broken, simulator unreachable): report the exact command and error on a \`**Gate could not run:**\` line (see below), not as a finding. Do the code review regardless, and say the tests did not run.

---

**Part 1 is the test run, exactly as described below. Part 2, the code review, is at the end of this prompt.**`;
}

/**
 * The code-review half of the lean review. Round 1 reviews the whole change;
 * later rounds review only the fix round's diff (`fixBase..HEAD`), while the
 * test run above stays complete.
 */
function leanReviewSection({ prdPath, defaultBranch, round, fixBase, designFiles }) {
  const base = defaultBranch || 'main';
  const design = designFiles && designFiles.length
    ? `\n- **Design conformance.** An approved Pencil design exists (${designFiles.join(', ')}). Check colours, spacing, typography, layout and component structure against it; an unjustified deviation is BLOCKING.`
    : '';
  if (round > 1 && fixBase) {
    return `

## PART 2 — RE-REVIEW OF THE FIX (round ${round})

Review ONLY what the fix round changed: \`git diff ${fixBase}..HEAD\`. Do not re-audit code that an earlier round already reviewed. For each finding from the previous round, confirm it is resolved and say how. New findings can only come from the fix diff itself; anything else is out of scope this round.

The test run in Part 1 is still the full suite: a fix can break something outside its own diff, and the suite is what sees that.

Severity: BLOCKING for a defect or an unmet AC, MEDIUM for a real problem that should be fixed before merge, LOW for the rest. Be conservative with BLOCKING. Approve when the findings are resolved and the suite is green.`;
  }
  return `

## PART 2 — CODE REVIEW

Review the change in this branch: \`git diff ${base}...HEAD\`, against the PRD at ${prdPath}. Only the branch's changes: do not review pre-existing code, and respect the PRD's "Out of scope" section. This one review stands in for the separate review steps of the full chain, so cover each of these once:

- **Acceptance criteria.** Every AC has an implementation and a test. List each AC under \`### AC Coverage\` with where it is implemented and tested. An AC with no implementation is BLOCKING.
- **Correctness across variants.** Every entity or type variant the spec covers, both directions of every toggle, not only the path the implementation took.
- **Silent failure.** A call that returns success while quietly dropping an invalid input; removed or weakened prior behaviour; contract drift between files.
- **Test quality.** The spec tests were written from the PRD by a separate agent. Check they assert the PRD's behaviour, not the implementation's, and that no test was weakened to pass. Flag ACs that depend on external services but are only tested with mocks as "MOCK-ONLY — real integration unverified".
- **Security.** Secrets or tokens in code, logs or tests; injection; missing authorisation on a new surface; tests that would call a real paid API.
- **Hygiene.** Test scaffolding in production code (environment failure hooks, ungated test seams); a third copy of logic that will drift; dead error paths.${design}

Severity: BLOCKING for a defect or an unmet AC, MEDIUM for a real problem that should be fixed before merge, LOW for the rest. Be conservative with BLOCKING and do not invent concerns. If the change is correct and tested, approve.`;
}

module.exports = {
  LEAN_PRESET,
  FULL_PRESET,
  EXECUTION_PRESETS,
  LEAN_EXECUTION_STEPS,
  LEAN_CLAUDE_STEPS,
  isLean,
  validatePreset,
  leanStartRefusal,
  resolveStartPreset,
  leanFixReturnStep,
  leanTaskDescription,
  leanBuilderSection,
  leanFixSection,
  leanReviewHeader,
  leanReviewSection,
};
