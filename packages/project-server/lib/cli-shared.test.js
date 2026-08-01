'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isModelCompatibleWithCli,
  resolveEffectiveCliConfig,
  resolveStepLaunchSettings,
  normalizeStepGroups,
  groupForStep,
  migrateRoleSlotsToGroups,
  validateCliPatch,
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


// ─── Step groups: shape, migration, resolution ──────────────────────────────
//
// Agent settings moved from per-ROLE slots (Default / Developer / Reviewer) to
// per-STEP-GROUP, with the grouping itself living in config. These pin the
// migration (nobody's setup changes on pull) and the resolution order.

const GROUPS = normalizeStepGroups(null); // the shipped default grouping

test('normalizeCliBlock: canonical shape, junk dropped', () => {
  assert.deepEqual(normalizeCliBlock(null), {
    default: null, default_model: null, default_effort: null, groups: {},
  });
  const n = normalizeCliBlock({
    default: 'opencode', default_model: 'openrouter/a/b', default_effort: 'high',
    groups: {
      build: { cli: 'codex', model: 'gpt-5.2-codex', effort: 'high' },
      review: { cli: 'not-a-cli', effort: 'bad; token' },
      'Bad Key': { cli: 'claude' },
      empty: { cli: null, model: null, effort: null },
    },
    extra: 'ignored',
  });
  assert.equal(n.default, 'opencode');
  assert.deepEqual(n.groups.build, { cli: 'codex', model: 'gpt-5.2-codex', effort: 'high' });
  // review's only values were an invalid CLI and a shell-unsafe effort; with
  // both dropped nothing is left, so the group is not stored at all.
  assert.equal('review' in n.groups, false);
  assert.equal('Bad Key' in n.groups, false);   // invalid key
  assert.equal('empty' in n.groups, false);     // nothing set → not stored
  assert.equal('extra' in n, false);
});

test('migration: the old role slots become groups, so a pull changes nothing', () => {
  // developer_* drove task_execution/fix_execution → the build group.
  // reviewer_* drove code review / security / final review → the review group.
  // default_* stays the block fallback, which is what it always was.
  const legacy = {
    default: 'claude', default_model: 'claude-opus-5[1m]', default_effort: 'medium',
    developer_cli: 'codex', developer_model: 'gpt-5.6-sol', developer_effort: 'high',
    reviewer_cli: 'claude', reviewer_model: 'sonnet5', reviewer_effort: 'high',
  };
  const g = migrateRoleSlotsToGroups(legacy);
  assert.deepEqual(g.build, { cli: 'codex', model: 'gpt-5.6-sol', effort: 'high' });
  assert.deepEqual(g.review, { cli: 'claude', model: 'sonnet5', effort: 'high' });
  assert.equal('plan' in g, false); // plan steps used default_*, which survives as-is
});

test('migration is idempotent and never overwrites a real grouping', () => {
  const already = { groups: { build: { cli: 'claude', model: null, effort: null } }, developer_cli: 'codex' };
  assert.deepEqual(migrateRoleSlotsToGroups(already), already.groups);
  assert.equal(migrateRoleSlotsToGroups({}).build, undefined);
});

test('a legacy block resolves through the launcher unchanged after migration', () => {
  const legacy = {
    default: 'claude', default_model: 'claude-opus-5[1m]', default_effort: 'medium',
    developer_cli: 'codex', developer_model: 'gpt-5.6-sol', developer_effort: 'high',
    reviewer_cli: 'claude', reviewer_model: 'sonnet5', reviewer_effort: 'high',
  };
  const eff = resolveEffectiveCliConfig({ localCli: legacy });
  const exec = { type: 'execution' };
  const build = resolveStepLaunchSettings('task_execution', exec, eff, GROUPS);
  assert.deepEqual([build.cli, build.model, build.effort], ['codex', 'gpt-5.6-sol', 'high']);
  const review = resolveStepLaunchSettings('code_review', exec, eff, GROUPS);
  assert.deepEqual([review.cli, review.model, review.effort], ['claude', 'sonnet5', 'high']);
  // Plan steps were never covered by either slot — they used default_*.
  const plan = resolveStepLaunchSettings('planning', exec, eff, GROUPS);
  assert.deepEqual([plan.cli, plan.model, plan.effort], ['claude', 'claude-opus-5[1m]', 'medium']);
});

test('every agent in a step resolves identically, whatever its role', () => {
  // The reason for the move: `reviewing` ran Security on the reviewer slot and
  // Brand on the default slot purely because of their role names.
  const eff = resolveEffectiveCliConfig({
    localCli: { default: 'claude', groups: { review: { cli: 'codex', model: 'gpt-5.2-codex', effort: 'high' } } },
  });
  const a = resolveStepLaunchSettings('reviewing', { type: 'review' }, eff, GROUPS);
  assert.deepEqual([a.cli, a.model, a.effort], ['codex', 'gpt-5.2-codex', 'high']);
});

test('an unset group inherits the block default', () => {
  const eff = resolveEffectiveCliConfig({
    localCli: { default: 'opencode', default_model: 'openrouter/a/b', default_effort: 'high' },
  });
  const r = resolveStepLaunchSettings('task_execution', {}, eff, GROUPS);
  assert.deepEqual([r.cli, r.model, r.effort], ['opencode', 'openrouter/a/b', 'high']);
});

test('a step in no group still runs, on the block default', () => {
  // A step added by a newer Build Studio, before anyone has grouped it.
  const eff = resolveEffectiveCliConfig({ localCli: { default: 'claude', default_model: 'opus' } });
  const r = resolveStepLaunchSettings('a_brand_new_step', {}, eff, GROUPS);
  assert.equal(r.group, null);
  assert.equal(r.cli, 'claude');
  assert.equal(r.model, 'opus');
});

test('a model incompatible with the group CLI is dropped, never flagged', () => {
  const eff = resolveEffectiveCliConfig({
    localCli: { default: 'claude', groups: { build: { cli: 'claude', model: 'openrouter/a/b', effort: null } } },
  });
  const r = resolveStepLaunchSettings('task_execution', {}, eff, GROUPS);
  assert.equal(r.model, null);
  assert.equal(r.modelFlag, '');
});

test('legacy per-run pins still steer in-flight runs', () => {
  const eff = resolveEffectiveCliConfig({ localCli: { default: 'claude' } });
  const wf = { type: 'execution', developerCli: 'codex', reviewerCli: 'opencode' };
  assert.equal(resolveStepLaunchSettings('task_execution', wf, eff, GROUPS).cli, 'codex');
  assert.equal(resolveStepLaunchSettings('code_review', wf, eff, GROUPS).cli, 'opencode');
  // The reviewer pin was always execution-scoped.
  assert.equal(resolveStepLaunchSettings('code_review', { type: 'bugfix', reviewerCli: 'opencode' }, eff, GROUPS).cli, 'claude');
});

test('groupForStep: first match wins, unknown steps are null', () => {
  assert.equal(groupForStep('task_execution', GROUPS), 'build');
  assert.equal(groupForStep('capture_learnings', GROUPS), 'review');
  assert.equal(groupForStep('planning', GROUPS), 'plan');
  assert.equal(groupForStep('nope', GROUPS), null);
  assert.equal(groupForStep(null, GROUPS), null);
});

test('a project can define its own grouping', () => {
  // The whole point of putting the mapping in config: split the expensive
  // backstop out of Review without touching code.
  const custom = normalizeStepGroups([
    { key: 'gate', label: 'Final gate', steps: ['final_review'] },
    { key: 'review', label: 'Review', steps: ['final_review', 'code_review'] },
  ]);
  assert.equal(groupForStep('final_review', custom), 'gate'); // first wins
  assert.equal(groupForStep('code_review', custom), 'review');
});

test('a malformed grouping falls back to the shipped default', () => {
  for (const bad of [null, undefined, 'nope', 42, [], [{ key: '' }], [{ key: 'Bad Key' }]]) {
    const g = normalizeStepGroups(bad);
    assert.ok(g.length >= 3, JSON.stringify(bad));
    assert.equal(groupForStep('task_execution', g), 'build');
  }
});

test('hasGlobalCliDefaults: an empty block is not "configured"', () => {
  // `groups` is an object and never null — testing it for non-null would make
  // every empty block look configured, and use_global projects would inherit
  // nothing over their own values.
  assert.equal(hasGlobalCliDefaults(null), false);
  assert.equal(hasGlobalCliDefaults({}), false);
  assert.equal(hasGlobalCliDefaults({ groups: {} }), false);
  assert.equal(hasGlobalCliDefaults({ default: 'not-a-cli' }), false);
  assert.equal(hasGlobalCliDefaults({ default: 'opencode' }), true);
  assert.equal(hasGlobalCliDefaults({ groups: { build: { cli: 'codex' } } }), true);
});

test('mergeGlobalCli: groups merge per key rather than wholesale', () => {
  const base = { default: 'claude', default_model: null, default_effort: null, groups: { review: { cli: 'claude', model: null, effort: null } } };
  const merged = mergeGlobalCli(base, { default: 'opencode', groups: { build: { cli: 'codex' } } });
  assert.equal(merged.default, 'opencode');
  assert.equal(merged.groups.build.cli, 'codex');
  assert.equal(merged.groups.review.cli, 'claude'); // a global that sets only build must not blank review
});

test('effective config: project values apply when use_global is off', () => {
  const local = { default: 'claude', groups: { build: { cli: 'opencode', model: 'openrouter/m/k', effort: 'high' } }, use_global: false };
  const global = { default: 'codex', default_model: 'gpt-5.2-codex' };
  const eff = resolveEffectiveCliConfig({ localCli: local, globalCli: global });
  assert.equal(eff.default, 'claude');
  assert.equal(eff.groups.build.cli, 'opencode');
});

test('effective config: Use default takes the global wholesale', () => {
  const local = { default: 'claude', groups: { build: { cli: 'opencode' } }, use_global: true };
  const global = { default: 'codex', groups: { build: { cli: 'claude', model: 'opus', effort: 'high' } } };
  const eff = resolveEffectiveCliConfig({ localCli: local, globalCli: global });
  assert.equal(eff.use_global, true);
  assert.equal(eff.default, 'codex');
  assert.equal(eff.groups.build.cli, 'claude'); // the project's opencode must not leak through
});

test('effective config: use_global with an empty global keeps project values', () => {
  const local = { default: 'opencode', groups: { build: { cli: 'codex' } }, use_global: true };
  const eff = resolveEffectiveCliConfig({ localCli: local, globalCli: {} });
  assert.equal(eff.default, 'opencode');
  assert.equal(eff.groups.build.cli, 'codex');
});

test('effective config: local groups layer over yaml groups', () => {
  const eff = resolveEffectiveCliConfig({
    yamlCli: { default: 'claude', groups: { build: { cli: 'codex' }, review: { cli: 'codex' } } },
    localCli: { groups: { build: { cli: 'opencode', model: 'openrouter/a/b', effort: null } } },
  });
  assert.equal(eff.groups.build.cli, 'opencode'); // local wins
  assert.equal(eff.groups.review.cli, 'codex');   // yaml survives
});

test('providersFromCliConfig: every CLI any group can launch on', () => {
  assert.deepEqual(providersFromCliConfig({ default: 'claude' }), ['claude']);
  assert.deepEqual(
    providersFromCliConfig({ default: 'claude', groups: { build: { cli: 'codex' }, review: { cli: 'opencode' } } }),
    ['claude', 'codex', 'openrouter'],
  );
  // A group with no CLI of its own contributes the default, not a duplicate.
  assert.deepEqual(providersFromCliConfig({ default: 'codex', groups: { build: {}, review: {} } }), ['codex']);
  assert.deepEqual(providersFromCliConfig(null), ['claude']);
});

// ─── validateCliPatch (shared by both Model pages) ──────────────────────────

test('validateCliPatch: accepts a group patch, rejects junk', () => {
  assert.equal(validateCliPatch({ groups: { build: { cli: 'codex', model: 'gpt-5.2-codex', effort: 'high' } } }).error, undefined);
  assert.match(validateCliPatch({ groups: { build: { cli: 'nope' } } }).error, /must be one of/);
  assert.match(validateCliPatch({ groups: { build: { effort: 'bad; rm -rf /' } } }).error, /effort token/);
  assert.match(validateCliPatch({ groups: { 'Bad Key': {} } }).error, /invalid group key/);
  assert.match(validateCliPatch({ groups: [] }).error, /object keyed by group/);
  assert.match(validateCliPatch({}).error, /No cli settings/);
});

test('validateCliPatch: a null group slot clears it', () => {
  const { patch } = validateCliPatch({ groups: { build: null } });
  assert.deepEqual(patch.groups.build, { cli: null, model: null, effort: null });
});

test('validateCliPatch: block-level fields and use_global still validate', () => {
  assert.equal(validateCliPatch({ default: 'claude' }).error, undefined);
  assert.match(validateCliPatch({ default: 'nope' }).error, /default must be one of/);
  assert.equal(validateCliPatch({ use_global: true }).error, undefined);
  assert.match(validateCliPatch({ use_global: 'yes' }).error, /boolean/);
  assert.match(validateCliPatch({ default_effort: 'bad token' }).error, /effort token/);
});
