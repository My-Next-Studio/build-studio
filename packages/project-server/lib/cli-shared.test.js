'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveCliForRole,
  resolveModelForRole,
  isModelCompatibleWithCli,
  resolveEffortForRole,
  resolveEffectiveCliConfig,
  resolveAgentLaunchSettings,
  buildCliFlags,
  resolveStepModelForCli,
  resolveStepEffortForCli,
  isValidEffortToken,
  normalizeCliBlock,
  hasGlobalCliDefaults,
  mergeGlobalCli,
  resolveAutoReviewerCli,
  VALID_CLIS,
  MODEL_IDS,
  providersFromCliConfig,
} = require('@build-studio/shared/cli');

// ─── resolveCliForRole ──────────────────────────────────────────────────────

test('resolver: developer role follows legacy wf.developerCli (in-flight runs)', () => {
  for (const cli of VALID_CLIS) {
    const wf = { type: 'execution', developerCli: cli, reviewerCli: 'claude' };
    assert.equal(resolveCliForRole('Fullstack Dev', wf, null), cli);
    assert.equal(resolveCliForRole('iOS Dev', wf, null), cli);
  }
});

test('resolver: per-role config slots — developer_cli / reviewer_cli beat default', () => {
  const cfg = { default: 'claude', developer_cli: 'opencode', reviewer_cli: 'codex' };
  const exec = { type: 'execution' };
  assert.equal(resolveCliForRole('Frontend Dev', exec, cfg), 'opencode');
  assert.equal(resolveCliForRole('Backend Dev', exec, cfg), 'opencode');
  assert.equal(resolveCliForRole('Code Reviewer', exec, cfg), 'codex');
  assert.equal(resolveCliForRole('Security', exec, cfg), 'codex');
  assert.equal(resolveCliForRole('Final Reviewer', exec, cfg), 'codex');
  assert.equal(resolveCliForRole('QA', exec, cfg), 'claude');
  // The configured reviewer slot applies in EVERY workflow type, not just execution
  for (const type of ['review', 'bugfix', 'kickoff', 'demo_review', 'onboarding']) {
    assert.equal(resolveCliForRole('Code Reviewer', { type }, cfg), 'codex', type);
    assert.equal(resolveCliForRole('Security', { type }, cfg), 'codex', type);
  }
  // Slots unset → default
  assert.equal(resolveCliForRole('Frontend Dev', exec, { default: 'opencode' }), 'opencode');
  assert.equal(resolveCliForRole('Code Reviewer', exec, { default: 'opencode' }), 'opencode');
});

test('resolver: legacy wf fields win over config slots (in-flight runs unchanged)', () => {
  const cfg = { default: 'claude', developer_cli: 'codex', reviewer_cli: 'codex' };
  const wf = { type: 'execution', developerCli: 'opencode', reviewerCli: 'claude' };
  assert.equal(resolveCliForRole('Frontend Dev', wf, cfg), 'opencode');
  assert.equal(resolveCliForRole('Code Reviewer', wf, cfg), 'claude');
});

test('resolver: reviewer follows legacy wf.reviewerCli in execution runs only', () => {
  const exec = { type: 'execution', developerCli: 'claude', reviewerCli: 'opencode' };
  assert.equal(resolveCliForRole('Code Reviewer', exec, null), 'opencode');
  assert.equal(resolveCliForRole('Security', exec, null), 'opencode');

  // Same reviewerCli set, but review/kickoff/bugfix runs ignore it → default.
  const review = { type: 'review', developerCli: 'claude', reviewerCli: 'opencode' };
  assert.equal(resolveCliForRole('Code Reviewer', review, null), 'claude');
  const kickoff = { type: 'kickoff', developerCli: 'claude', reviewerCli: 'opencode' };
  assert.equal(resolveCliForRole('Code Reviewer', kickoff, null), 'claude');
  const bugfix = { type: 'bugfix', developerCli: 'opencode', reviewerCli: 'opencode' };
  assert.equal(resolveCliForRole('Code Reviewer', bugfix, null), 'claude');
});

test('resolver: every other role uses the project default CLI', () => {
  const cfg = { default: 'opencode' };
  const wf = { type: 'kickoff', developerCli: 'claude', reviewerCli: 'claude' };
  for (const role of ['PM', 'CEO', 'QA', 'Architect', 'Planner', 'Fix Planner', 'DevOps', 'Surveyor', 'Brand']) {
    assert.equal(resolveCliForRole(role, wf, cfg), 'opencode', role);
  }
  // …in every workflow type
  for (const type of ['kickoff', 'onboarding', 'review', 'execution', 'bugfix']) {
    assert.equal(resolveCliForRole('PM', { type, developerCli: 'claude' }, cfg), 'opencode', type);
  }
});

test('resolver: missing cli config falls back to claude everywhere', () => {
  const wf = { type: 'execution' };
  assert.equal(resolveCliForRole('Fullstack Dev', wf, null), 'claude');
  assert.equal(resolveCliForRole('Code Reviewer', wf, null), 'claude');
  assert.equal(resolveCliForRole('PM', wf, null), 'claude');
  assert.equal(resolveCliForRole('PM', wf, {}), 'claude');
});

// ─── resolveModelForRole ────────────────────────────────────────────────────

test('model: per-role selectors, default fallback, null when unset', () => {
  const cfg = { default: 'opencode', default_model: 'openrouter/a/a', developer_model: 'openrouter/b/b', reviewer_model: 'openrouter/c/c' };
  const exec = { type: 'execution', developerCli: 'opencode', reviewerCli: 'opencode' };
  assert.equal(resolveModelForRole('opencode', 'Fullstack Dev', exec, cfg), 'openrouter/b/b');
  assert.equal(resolveModelForRole('opencode', 'Code Reviewer', exec, cfg), 'openrouter/c/c');
  assert.equal(resolveModelForRole('opencode', 'PM', exec, cfg), 'openrouter/a/a');

  // Either dedicated slot, left unset, falls back to the default model.
  const cfgNoRev = { ...cfg, reviewer_model: null };
  assert.equal(resolveModelForRole('opencode', 'Security', exec, cfgNoRev), 'openrouter/a/a');
  const cfgNoDev = { ...cfg, developer_model: null };
  assert.equal(resolveModelForRole('opencode', 'Fullstack Dev', exec, cfgNoDev), 'openrouter/a/a');

  // Nothing set anywhere → null (the CLI runs its own configured default).
  assert.equal(resolveModelForRole('opencode', 'Fullstack Dev', exec, { default: 'opencode' }), null);
  assert.equal(resolveModelForRole('PM', exec, null), null);
});

test('model: CLI-incompatible values are dropped, never passed as flags', () => {
  const exec = { type: 'execution' };
  // opencode ids are provider-scoped (contain '/'); claude/codex take bare names.
  assert.equal(resolveModelForRole('claude', 'PM', exec, { default_model: 'opus' }), 'opus');
  assert.equal(resolveModelForRole('codex', 'PM', exec, { default_model: 'gpt-5.2-codex' }), 'gpt-5.2-codex');
  assert.equal(resolveModelForRole('claude', 'PM', exec, { default_model: 'openrouter/a/a' }), null);
  assert.equal(resolveModelForRole('codex', 'PM', exec, { default_model: 'openrouter/a/a' }), null);
  assert.equal(resolveModelForRole('opencode', 'PM', exec, { default_model: 'opus' }), null);
  assert.equal(isModelCompatibleWithCli('opencode', null), true);
  assert.equal(isModelCompatibleWithCli('claude', 'sonnet5'), true);
  assert.equal(isModelCompatibleWithCli('claude', 5), false);
});

// ─── resolveEffortForRole ───────────────────────────────────────────────────

test('effort: per-role selectors mirror the model slots', () => {
  const cfg = { default: 'opencode', default_effort: 'low', developer_effort: 'high', reviewer_effort: 'max' };
  const exec = { type: 'execution', developerCli: 'opencode', reviewerCli: 'opencode' };
  assert.equal(resolveEffortForRole('Fullstack Dev', exec, cfg), 'high');
  assert.equal(resolveEffortForRole('Code Reviewer', exec, cfg), 'max');
  assert.equal(resolveEffortForRole('PM', exec, cfg), 'low');

  // Either slot, left unset, falls back to default (same as the model slots).
  assert.equal(resolveEffortForRole('Security', exec, { ...cfg, reviewer_effort: null }), 'low');
  assert.equal(resolveEffortForRole('Fullstack Dev', exec, { ...cfg, developer_effort: null }), 'low');
  // Nothing set → null (no effort flag).
  assert.equal(resolveEffortForRole('PM', exec, { default: 'opencode' }), null);
  assert.equal(resolveEffortForRole('PM', exec, null), null);
});

test('effort: invalid tokens never reach the command line', () => {
  const exec = { type: 'execution' };
  assert.equal(resolveEffortForRole('PM', exec, { default_effort: 'high; rm -rf ~' }), null);
  assert.equal(resolveEffortForRole('PM', exec, { default_effort: '$(whoami)' }), null);
  assert.equal(resolveEffortForRole('PM', exec, { default_effort: 5 }), null);
  assert.equal(isValidEffortToken('xhigh'), true);
  assert.equal(isValidEffortToken('minimal'), true);
  assert.equal(isValidEffortToken('high max'), false);
  assert.equal(isValidEffortToken(''), false);
  assert.equal(isValidEffortToken(null), false);
});

// ─── global CLI defaults: normalize / has / merge ───────────────────────────

test('normalizeCliBlock: canonical 9-field shape, junk dropped', () => {
  assert.deepEqual(normalizeCliBlock(null), {
    default: null, developer_cli: null, reviewer_cli: null,
    default_model: null, developer_model: null, reviewer_model: null,
    default_effort: null, developer_effort: null, reviewer_effort: null,
  });
  const n = normalizeCliBlock({
    default: 'opencode', developer_cli: 'codex', reviewer_cli: 'not-a-cli',
    default_model: 'openrouter/a/b', default_effort: 'high',
    developer_effort: 'bad; token', extra: 'ignored',
  });
  assert.equal(n.default, 'opencode');
  assert.equal(n.developer_cli, 'codex');
  assert.equal(n.reviewer_cli, null); // invalid CLI → dropped
  assert.equal(n.default_model, 'openrouter/a/b');
  assert.equal(n.default_effort, 'high');
  assert.equal(n.developer_effort, null); // shell-unsafe → dropped
  assert.equal(n.reviewer_model, null);
  assert.equal('extra' in n, false);
});

test('hasGlobalCliDefaults: false for empty/unset, true for any real value', () => {
  assert.equal(hasGlobalCliDefaults(null), false);
  assert.equal(hasGlobalCliDefaults({}), false);
  assert.equal(hasGlobalCliDefaults({ default: 'not-a-cli' }), false);
  assert.equal(hasGlobalCliDefaults({ default: 'opencode' }), true);
  assert.equal(hasGlobalCliDefaults({ reviewer_effort: 'max' }), true);
});

test('mergeGlobalCli: global non-null wins, nulls keep the base', () => {
  const base = { default: 'claude', default_model: null, developer_model: null, reviewer_model: null, default_effort: null, developer_effort: null, reviewer_effort: null };
  const merged = mergeGlobalCli(base, { default: 'opencode', default_model: 'openrouter/m/k', reviewer_effort: 'low' });
  assert.equal(merged.default, 'opencode');
  assert.equal(merged.default_model, 'openrouter/m/k');
  assert.equal(merged.reviewer_effort, 'low');
  assert.equal(merged.developer_model, null); // untouched by global null
  assert.equal(merged.default_effort, null);
});

// ─── resolveAutoReviewerCli ─────────────────────────────────────────────────

test('auto reviewer: always a DIFFERENT CLI than the developer, deterministic', () => {
  const all = ['claude', 'codex', 'opencode'];
  assert.equal(resolveAutoReviewerCli('claude', all), 'codex');
  assert.equal(resolveAutoReviewerCli('codex', all), 'claude');
  assert.equal(resolveAutoReviewerCli('opencode', all), 'claude');

  // Subsets: first enabled in VALID_CLIS order that ≠ developer.
  assert.equal(resolveAutoReviewerCli('claude', ['claude', 'opencode']), 'opencode');
  assert.equal(resolveAutoReviewerCli('codex', ['codex', 'opencode']), 'opencode');
});

test('auto reviewer: single enabled CLI degrades to same (UI warns there)', () => {
  assert.equal(resolveAutoReviewerCli('claude', ['claude']), 'claude');
  assert.equal(resolveAutoReviewerCli('opencode', []), 'opencode');
  assert.equal(resolveAutoReviewerCli('claude', null), 'claude');
});

// ─── resolveReviewerCliAtStart (server-side start semantics) ───────────────

test('start-time reviewer resolution: auto flips, explicit wins, omitted mirrors developer', () => {
  const { resolveReviewerCliAtStart } = require('./api/workflow');
  const all = ['claude', 'codex', 'opencode'];
  // 'auto' is resolved server-side — non-hub callers get diversity too.
  assert.equal(resolveReviewerCliAtStart('auto', 'claude', all), 'codex');
  assert.equal(resolveReviewerCliAtStart('auto', 'opencode', all), 'claude');
  assert.equal(resolveReviewerCliAtStart('auto', 'claude', ['claude']), 'claude'); // only one enabled
  // Explicit value passes through.
  assert.equal(resolveReviewerCliAtStart('opencode', 'claude', all), 'opencode');
  // Omitted → developer CLI (conservative same-CLI default; flip stays opt-in).
  assert.equal(resolveReviewerCliAtStart(undefined, 'codex', all), 'codex');
  assert.equal(resolveReviewerCliAtStart(null, 'opencode', all), 'opencode');
});

// ─── resolveEffectiveCliConfig + resolveAgentLaunchSettings ─────────────────
// These two pure functions answer "which CLI/model/effort does a brand-new
// tmux agent get?" for project-specific vs global (Use default) settings and
// each role slot — the manual-verification scenario that's hard to eyeball.

const EXEC = { type: 'execution' };
const KICKOFF = { type: 'kickoff' };

test('effective config: project-specific when use_global is false/unset', () => {
  const local = {
    default: 'claude', developer_cli: 'opencode', reviewer_cli: 'opencode',
    default_model: 'opus', developer_model: 'openrouter/moonshotai/kimi-k3',
    developer_effort: 'high', use_global: false,
  };
  const global = { default: 'codex', default_model: 'gpt-5.2-codex', default_effort: 'low' };
  const eff = resolveEffectiveCliConfig({ localCli: local, globalCli: global });
  assert.equal(eff.default, 'claude');
  assert.equal(eff.developer_cli, 'opencode');
  assert.equal(eff.developer_model, 'openrouter/moonshotai/kimi-k3');
  assert.equal(eff.developer_effort, 'high');
  assert.notEqual(eff.default, 'codex'); // global ignored
});

test('effective config: Use default → global wholesale (project values stay out)', () => {
  const local = {
    default: 'claude', developer_cli: 'opencode', developer_model: 'openrouter/a/a',
    use_global: true,
  };
  const global = {
    default: 'codex', developer_cli: 'claude', reviewer_cli: 'claude',
    default_model: 'gpt-5.2-codex', default_effort: 'medium',
    developer_model: 'opus', developer_effort: 'high',
  };
  const eff = resolveEffectiveCliConfig({ localCli: local, globalCli: global });
  assert.equal(eff.use_global, true);
  assert.equal(eff.default, 'codex');
  assert.equal(eff.developer_cli, 'claude');
  assert.equal(eff.developer_model, 'opus');
  assert.equal(eff.developer_effort, 'high');
  // Project's opencode developer setting must NOT leak through
  assert.notEqual(eff.developer_cli, 'opencode');
});

test('effective config: use_global with empty global falls back to project values', () => {
  const local = { default: 'opencode', developer_model: 'openrouter/a/a', use_global: true };
  const eff = resolveEffectiveCliConfig({ localCli: local, globalCli: {} });
  assert.equal(eff.default, 'opencode');
  assert.equal(eff.developer_model, 'openrouter/a/a');
});

test('launch settings: Default / Developer / Reviewer slots + flag fragments', () => {
  const cfg = {
    default: 'claude', developer_cli: 'opencode', reviewer_cli: 'codex',
    default_model: 'opus4.7[1m]', default_effort: 'highlog',
    developer_model: 'openrouter/moonshotai/kimi-k3', developer_effort: 'max',
    reviewer_model: 'gpt-5.2-codex', reviewer_effort: 'medium',
  };
  // Fix intentional typo highlog, would be filtered by isValidEffortToken - use high
  cfg.default_effort = 'high';

  // Default role (QA) — claude + opus4.7[1m] + high
  const qa = resolveAgentLaunchSettings('QA', EXEC, cfg);
  assert.equal(qa.cli, 'claude');
  assert.equal(qa.model, 'opus4.7[1m]');
  assert.equal(qa.effort, 'high');
  assert.equal(qa.modelFlag, ` --model ${MODEL_IDS['opus4.7[1m]']}`);
  assert.equal(qa.effortFlag, ' --effort high');

  // Developer — opencode + kimi + max
  const dev = resolveAgentLaunchSettings('Frontend Dev', EXEC, cfg);
  assert.equal(dev.cli, 'opencode');
  assert.equal(dev.model, 'openrouter/moonshotai/kimi-k3');
  assert.equal(dev.effort, 'max');
  assert.equal(dev.modelFlag, ' -m openrouter/moonshotai/kimi-k3');
  assert.equal(dev.effortFlag, ' --variant max');

  // Reviewer (execution) — codex + gpt-5.2-codex + medium
  const rev = resolveAgentLaunchSettings('Code Reviewer', EXEC, cfg);
  assert.equal(rev.cli, 'codex');
  assert.equal(rev.model, 'gpt-5.2-codex');
  assert.equal(rev.effort, 'medium');
  assert.equal(rev.modelFlag, ' --model gpt-5.2-codex');
  assert.equal(rev.effortFlag, ' -c model_reasoning_effort=medium');

  // Reviewer role outside execution → still the Reviewer slot. Reviewing is
  // reviewing whatever workflow it happens in; only the legacy per-run
  // wf.reviewerCli knob stays execution-scoped.
  const revKick = resolveAgentLaunchSettings('Code Reviewer', KICKOFF, cfg);
  assert.equal(revKick.cli, 'codex');
  assert.equal(revKick.model, 'gpt-5.2-codex');
  assert.equal(revKick.effort, 'medium');
});

test('launch settings: Use-default path (global) drives every role', () => {
  const global = {
    default: 'opencode', developer_cli: 'claude', reviewer_cli: 'claude',
    default_model: 'openrouter/moonshotai/kimi-k3', default_effort: 'low',
    developer_model: 'sonnet5', developer_effort: 'high',
    reviewer_model: 'opus', reviewer_effort: 'max',
  };
  const local = { use_global: true, default: 'codex' }; // project values must not leak
  const eff = resolveEffectiveCliConfig({ localCli: local, globalCli: global });

  const dev = resolveAgentLaunchSettings('Backend Dev', EXEC, eff);
  assert.equal(dev.cli, 'claude');
  assert.equal(dev.model, 'sonnet5');
  assert.equal(dev.effort, 'high');
  assert.equal(dev.modelFlag, ` --model ${MODEL_IDS.sonnet5}`);
  assert.equal(dev.effortFlag, ' --effort high');

  const qa = resolveAgentLaunchSettings('QA', EXEC, eff);
  assert.equal(qa.cli, 'opencode');
  assert.equal(qa.model, 'openrouter/moonshotai/kimi-k3');
  assert.equal(qa.effort, 'low');
  assert.equal(qa.modelFlag, ' -m openrouter/moonshotai/kimi-k3');
  assert.equal(qa.effortFlag, ' --variant low');

  const sec = resolveAgentLaunchSettings('Security', EXEC, eff);
  assert.equal(sec.cli, 'claude');
  assert.equal(sec.model, 'opus');
  assert.equal(sec.effort, 'max');
});

test('launch settings: both developer and reviewer model/effort fall back to the default slot', () => {
  const cfg = {
    default: 'opencode',
    default_model: 'openrouter/a/a', default_effort: 'low',
    developer_cli: 'opencode', // no developer_model / effort → inherit default_
    reviewer_cli: 'opencode', // no reviewer_model / effort → inherit default_
  };
  const dev = resolveAgentLaunchSettings('iOS Dev', EXEC, cfg);
  assert.equal(dev.model, 'openrouter/a/a');
  assert.equal(dev.effort, 'low');
  assert.equal(dev.modelFlag, ' -m openrouter/a/a');
  assert.equal(dev.effortFlag, ' --variant low');

  const rev = resolveAgentLaunchSettings('Code Reviewer', EXEC, cfg);
  assert.equal(rev.model, 'openrouter/a/a');
  assert.equal(rev.effort, 'low');
  assert.equal(rev.modelFlag, ' -m openrouter/a/a');
  assert.equal(rev.effortFlag, ' --variant low');
});

test('launch settings: Final Reviewer uses the reviewer slot, in non-execution runs too', () => {
  const cfg = {
    default: 'claude', default_model: 'sonnet5', default_effort: 'low',
    reviewer_cli: 'codex', reviewer_model: 'gpt-5.2-codex', reviewer_effort: 'high',
  };
  for (const wf of [EXEC, { type: 'bugfix' }, { type: 'review' }]) {
    const fin = resolveAgentLaunchSettings('Final Reviewer', wf, cfg);
    assert.equal(fin.cli, 'codex', `${wf.type} cli`);
    assert.equal(fin.model, 'gpt-5.2-codex', `${wf.type} model`);
    assert.equal(fin.effort, 'high', `${wf.type} effort`);
  }
  // …while a non-reviewer role in the same runs still uses the default slot.
  const pm = resolveAgentLaunchSettings('PM', { type: 'bugfix' }, cfg);
  assert.equal(pm.cli, 'claude');
  assert.equal(pm.model, 'sonnet5');
});

// ─── per-step overrides across CLIs ─────────────────────────────────────────

test('step efforts: a bare token applies to every CLI, not just claude', () => {
  // This is the gap: step_efforts used to be read only on the claude path, so
  // a codex or opencode agent silently ran at the CLI's own default.
  for (const cli of VALID_CLIS) {
    assert.equal(resolveStepEffortForCli('xhigh', cli), 'xhigh', cli);
  }
  // Per-CLI map narrows it when one CLI wants a different level.
  const perCli = { claude: 'max', codex: 'high', opencode: 'low' };
  assert.equal(resolveStepEffortForCli(perCli, 'claude'), 'max');
  assert.equal(resolveStepEffortForCli(perCli, 'codex'), 'high');
  assert.equal(resolveStepEffortForCli(perCli, 'opencode'), 'low');
  // Absent CLI in the map, and unset/garbage entries → no flag.
  assert.equal(resolveStepEffortForCli({ claude: 'max' }, 'codex'), null);
  assert.equal(resolveStepEffortForCli(null, 'claude'), null);
  assert.equal(resolveStepEffortForCli('high; rm -rf ~', 'claude'), null);
  assert.equal(resolveStepEffortForCli({ codex: '$(whoami)' }, 'codex'), null);
});

test('step models: a bare string stays claude-only; a per-CLI map reaches the others', () => {
  // Every shipped preset uses the bare form (`task_execution: 'sonnet'`), and
  // that is a CLAUDE short name — handing it to opencode would emit `-m sonnet`,
  // which is not a provider-scoped id.
  assert.equal(resolveStepModelForCli('sonnet', 'claude'), 'sonnet');
  assert.equal(resolveStepModelForCli('sonnet', 'codex'), null);
  assert.equal(resolveStepModelForCli('sonnet', 'opencode'), null);

  const perCli = { claude: 'sonnet5', codex: 'gpt-5.2-codex', opencode: 'openrouter/moonshotai/kimi-k3' };
  assert.equal(resolveStepModelForCli(perCli, 'claude'), 'sonnet5');
  assert.equal(resolveStepModelForCli(perCli, 'codex'), 'gpt-5.2-codex');
  assert.equal(resolveStepModelForCli(perCli, 'opencode'), 'openrouter/moonshotai/kimi-k3');
  assert.equal(resolveStepModelForCli({ claude: 'sonnet5' }, 'opencode'), null);
  assert.equal(resolveStepModelForCli(null, 'claude'), null);
  assert.equal(resolveStepModelForCli(42, 'claude'), null);
});

test('buildCliFlags: per-CLI spelling, with incompatible values dropped', () => {
  assert.deepEqual(
    buildCliFlags('claude', 'sonnet5', 'xhigh'),
    { model: 'sonnet5', effort: 'xhigh', modelFlag: ` --model ${MODEL_IDS.sonnet5}`, effortFlag: ' --effort xhigh' });
  assert.deepEqual(
    buildCliFlags('opencode', 'openrouter/a/a', 'low'),
    { model: 'openrouter/a/a', effort: 'low', modelFlag: ' -m openrouter/a/a', effortFlag: ' --variant low' });
  assert.deepEqual(
    buildCliFlags('codex', 'gpt-5.2-codex', 'high'),
    { model: 'gpt-5.2-codex', effort: 'high', modelFlag: ' --model gpt-5.2-codex', effortFlag: ' -c model_reasoning_effort=high' });

  // A mistyped step_models entry must never reach a shell command line.
  assert.deepEqual(buildCliFlags('opencode', 'sonnet', null),
    { model: null, effort: null, modelFlag: '', effortFlag: '' });
  assert.deepEqual(buildCliFlags('claude', 'openrouter/a/a', 'max; rm -rf ~'),
    { model: null, effort: null, modelFlag: '', effortFlag: '' });
});

test('launch settings: incompatible model for the slot CLI is dropped (no flag)', () => {
  // claude row with an opencode-shaped model string
  const cfg = { default: 'claude', default_model: 'openrouter/moonshotai/kimi-k3', default_effort: 'high' };
  const qa = resolveAgentLaunchSettings('PM', EXEC, cfg);
  assert.equal(qa.cli, 'claude');
  assert.equal(qa.model, null);
  assert.equal(qa.modelFlag, '');
  assert.equal(qa.effort, 'high'); // effort is CLI-agnostic, still applies
  assert.equal(qa.effortFlag, ' --effort high');
});

// ─── providersFromCliConfig (usage meter filter) ────────────────────────────

test('providersFromCliConfig: only the CLIs in use across the three slots', () => {
  assert.deepEqual(
    providersFromCliConfig({ default: 'codex' }),
    ['codex'],
  );
  assert.deepEqual(
    providersFromCliConfig({ default: 'opencode', developer_cli: 'claude', reviewer_cli: 'codex' }),
    ['openrouter', 'claude', 'codex'],
  );
  assert.deepEqual(
    providersFromCliConfig({ default: 'claude', developer_cli: null, reviewer_cli: null }),
    ['claude'],
  );
  // unset developer/reviewer fall back to default → single provider
  assert.deepEqual(
    providersFromCliConfig({ default: 'opencode', developer_cli: 'opencode', reviewer_cli: null }),
    ['openrouter'],
  );
  assert.deepEqual(providersFromCliConfig(null), ['claude']);
});


