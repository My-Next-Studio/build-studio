'use strict';

// The model-selection precedence, pinned end to end.
//
//   per-run override  >  project config.yaml  >  UI role slot  >  preset  >  agent_defaults
//
// The load-bearing pair is the middle two: a PRESET step model must NOT beat an
// explicit Agents-tab slot (that made picking a model in the UI silently do
// nothing on every step a preset named), while a PROJECT step model must, since
// it is a current deliberate choice and more specific than a role slot.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolvePreset } = require('./presets');
const {
  resolveAgentLaunchSettings, resolveStepModelForCli, resolveStepEffortForCli,
} = require('@build-studio/shared/cli');

/** Mirrors the launcher's chain in api/workflow.js. */
function pickModel({ cfg, step, role, wf = { type: 'execution' }, runOverride = null }) {
  const launch = resolveAgentLaunchSettings(role, wf, cfg.cli);
  const cli = launch.cli;
  const stepEntry = runOverride || (cfg.projectStepModels || {})[step] || null;
  const presetEntry = (cfg.presetStepModels || {})[step] || null;
  const stepModel = resolveStepModelForCli(stepEntry, cli);
  const presetModel = resolveStepModelForCli(presetEntry, cli);
  const model = stepModel || launch.model || presetModel
    || (cli === 'claude' ? (cfg.agent_defaults.model || 'opus') : null);
  const source = stepModel ? 'step' : launch.model ? 'role' : presetModel ? 'preset' : 'default';
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

test('an explicit UI role slot now beats a preset step model', () => {
  // The regression this whole change exists for: the solo preset sets
  // reviewing:'sonnet', which used to override an Opus pick in the Agents tab.
  const cfg = configWith({ cli: { default: 'claude', default_model: 'claude-opus-5' } });
  const got = pickModel({ cfg, step: 'reviewing', role: 'PM' });
  assert.equal(got.model, 'claude-opus-5');
  assert.equal(got.source, 'role');
});

test('a project step model still beats the UI role slot', () => {
  const cfg = configWith({
    projectStepModels: { task_execution: 'opus[1m]' },
    cli: { default: 'claude', default_model: 'sonnet5' },
  });
  const got = pickModel({ cfg, step: 'task_execution', role: 'QA' });
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
  assert.equal(got.source, 'step');
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
  // Bare preset strings are claude short names; the reviewer slot here is codex,
  // so the preset entry drops and the slot's own model stands.
  const cfg = configWith({
    cli: { default: 'claude', reviewer_cli: 'codex', reviewer_model: 'gpt-5.6-sol' },
  });
  const got = pickModel({ cfg, step: 'code_review', role: 'Code Reviewer' });
  assert.equal(got.cli, 'codex');
  assert.equal(got.model, 'gpt-5.6-sol');
  assert.equal(got.source, 'role');
});

test('effort follows the same order', () => {
  const r = resolvePreset('solo', { step_efforts: { task_execution: 'max' } });
  const cli = { default: 'claude', default_effort: 'medium' };
  const pick = (step) => {
    const launch = resolveAgentLaunchSettings('QA', { type: 'execution' }, cli);
    return resolveStepEffortForCli(r.projectStepEfforts[step] || null, launch.cli)
      || launch.effort
      || resolveStepEffortForCli(r.presetStepEfforts[step] || null, launch.cli)
      || null;
  };
  assert.equal(pick('task_execution'), 'max');   // project wins
  assert.equal(pick('reviewing'), 'medium');     // slot beats the preset's 'high'
});
