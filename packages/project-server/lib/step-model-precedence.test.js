'use strict';

// The model-selection precedence, pinned end to end.
//
//   per-run override  >  UI group slot  >  project config.yaml  >  preset  >  agent_defaults
//
// Owner-specified (2026-07-31): what the Model page shows is what runs. The UI
// slot is the STEP GROUP's slot — resolved from the PROJECT Model page when
// "Use default" is unchecked and the GLOBAL Model page otherwise, with
// resolveEffectiveCliConfig collapsing those two before this chain sees it.
//
// Everything below the slot is a FALLBACK for what the UI has not configured.
// config.yaml `step_models` used to outrank the slot, which meant choosing a
// model in the UI silently did nothing on any step config.yaml named, and the
// agent card showed the config.yaml value with no hint the picker was ignored.
// A per-run override still wins over everything: it is an explicit choice made
// for this run.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolvePreset } = require('./presets');
const {
  resolveStepLaunchSettings, resolveStepModelForCli, resolveStepEffortForCli,
  normalizeStepGroups,
} = require('@build-studio/shared/cli');

const GROUPS = normalizeStepGroups(null);

/** Mirrors the launcher's chain in api/workflow.js. */
function pickModel({ cfg, step, role, wf = { type: 'execution' }, runOverride = null }) {
  const launch = resolveStepLaunchSettings(step, wf, cfg.cli, GROUPS);
  const cli = launch.cli;
  const runModel = resolveStepModelForCli(runOverride, cli);
  const stepModel = resolveStepModelForCli((cfg.projectStepModels || {})[step] || null, cli);
  const presetModel = resolveStepModelForCli((cfg.presetStepModels || {})[step] || null, cli);
  const model = runModel || launch.model || stepModel || presetModel
    || (cli === 'claude' ? (cfg.agent_defaults.model || 'opus') : null);
  const source = runModel ? 'run' : launch.model ? 'group' : stepModel ? 'step' : presetModel ? 'preset' : 'default';
  return { cli, model, source };
}

function configWith({ projectStepModels = {}, cli = {}, agentModel = 'opus' } = {}) {
  const resolved = resolvePreset('solo', { step_models: projectStepModels });
  return {
    cli: { default: 'claude', ...cli },
    agent_defaults: { model: agentModel },
    projectStepModels: resolved.projectStepModels,
    presetStepModels: resolved.presetStepModels,
  };
}

test('resolvePreset returns preset and project step models separately', () => {
  const r = resolvePreset('solo', { step_models: { task_execution: 'opus[1m]' } });
  // Project half holds only what the project set.
  assert.deepEqual(r.projectStepModels, { task_execution: 'opus[1m]' });
  // Preset half holds the shipped defaults and is NOT polluted by the project's.
  assert.equal(r.presetStepModels.reviewing, 'sonnet');
  assert.equal(r.presetStepModels.task_execution !== 'opus[1m]', true);
  // The merged view still exists for existing consumers.
  assert.equal(r.step_models.task_execution, 'opus[1m]');
  assert.equal(r.step_models.reviewing, 'sonnet');
});

test('an explicit UI group slot now beats a preset step model', () => {
  // The regression this whole change exists for: the solo preset sets
  // reviewing:'sonnet', which used to override an Opus pick on the Model page.
  const cfg = configWith({ cli: { default: 'claude', default_model: 'claude-opus-5' } });
  const got = pickModel({ cfg, step: 'reviewing', role: 'PM' });
  assert.equal(got.model, 'claude-opus-5');
  assert.equal(got.source, 'group');
});

test('the UI group slot now beats a project config.yaml step model', () => {
  // Reversed on owner instruction (2026-07-31). config.yaml is a fallback for
  // what the UI has not configured, not an override of it — the previous order
  // made the Model page silently inert on any step config.yaml named.
  const cfg = configWith({
    projectStepModels: { task_execution: 'opus[1m]' },
    cli: { default: 'claude', default_model: 'sonnet5' },
  });
  const got = pickModel({ cfg, step: 'task_execution', role: 'QA' });
  assert.equal(got.model, 'sonnet5');
  assert.equal(got.source, 'group');
});

test('a project config.yaml step model applies when no slot is set', () => {
  // The fallback role config.yaml keeps: per-step tuning still works on a
  // project whose Model page leaves the slot empty.
  const cfg = configWith({ projectStepModels: { task_execution: 'opus[1m]' }, cli: { default: 'claude' } });
  const got = pickModel({ cfg, step: 'task_execution', role: 'QA' });
  assert.equal(got.model, 'opus[1m]');
  assert.equal(got.source, 'step');
});

test('config.yaml still outranks the preset', () => {
  const cfg = configWith({ projectStepModels: { reviewing: 'opus[1m]' }, cli: { default: 'claude' } });
  const got = pickModel({ cfg, step: 'reviewing', role: 'PM' });
  assert.equal(got.model, 'opus[1m]');
  assert.equal(got.source, 'step');
});

test('a per-run override beats everything', () => {
  const cfg = configWith({
    projectStepModels: { task_execution: 'opus[1m]' },
    cli: { default: 'claude', default_model: 'sonnet5' },
  });
  const got = pickModel({ cfg, step: 'task_execution', role: 'QA', runOverride: 'fable' });
  assert.equal(got.model, 'fable');
  assert.equal(got.source, 'run');
});

test('the preset still applies when no slot and no project entry are set', () => {
  // The fallback the owner asked to keep: an unconfigured project, or a slot
  // momentarily cleared mid-reconfig, still launches with a sane model.
  const cfg = configWith({ cli: { default: 'claude' } });
  const got = pickModel({ cfg, step: 'reviewing', role: 'PM' });
  assert.equal(got.model, 'sonnet');
  assert.equal(got.source, 'preset');
});

test('agent_defaults remains the last resort, so an agent always has a model', () => {
  const cfg = configWith({ cli: { default: 'claude' }, agentModel: 'opus' });
  // A step no preset names and no slot covers.
  const got = pickModel({ cfg, step: 'a_step_nobody_configured', role: 'PM' });
  assert.equal(got.model, 'opus');
  assert.equal(got.source, 'default');
});

test('a claude-only preset value is not forced onto a codex agent', () => {
  // Bare preset strings are claude short names; the review group here is codex,
  // so the preset entry drops and the group's own model stands.
  const cfg = configWith({
    cli: { default: 'claude', groups: { review: { cli: 'codex', model: 'gpt-5.6-sol', effort: null } } },
  });
  const got = pickModel({ cfg, step: 'code_review', role: 'Code Reviewer' });
  assert.equal(got.cli, 'codex');
  assert.equal(got.model, 'gpt-5.6-sol');
  assert.equal(got.source, 'group');
});

test('effort follows the same order', () => {
  const r = resolvePreset('solo', { step_efforts: { task_execution: 'max' } });
  const pick = (step, cli) => {
    const launch = resolveStepLaunchSettings(step, { type: 'execution' }, cli, GROUPS);
    return launch.effort
      || resolveStepEffortForCli(r.projectStepEfforts[step] || null, launch.cli)
      || resolveStepEffortForCli(r.presetStepEfforts[step] || null, launch.cli)
      || null;
  };
  const withSlot = { default: 'claude', default_effort: 'medium' };
  const noSlot = { default: 'claude' };
  // Slot set: it wins over BOTH config.yaml and the preset — this is the
  // reversal. A project running an xhigh per-step experiment now needs that
  // effort in the Model page, or an empty slot, for it to apply.
  assert.equal(pick('task_execution', withSlot), 'medium');
  assert.equal(pick('reviewing', withSlot), 'medium');
  // Slot empty: config.yaml then the preset still fill in.
  assert.equal(pick('task_execution', noSlot), 'max');
  assert.equal(pick('reviewing', noSlot), 'high');
});
