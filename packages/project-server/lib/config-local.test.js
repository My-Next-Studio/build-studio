'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig, loadLocalOverrides, saveLocalOverrides, CLI_DEFAULTS } = require('./config');

function makeProject(configYaml, localJson) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-local-test-'));
  fs.mkdirSync(path.join(root, '.build-studio'), { recursive: true });
  fs.writeFileSync(path.join(root, '.build-studio', 'config.yaml'), configYaml);
  if (localJson !== undefined) {
    fs.writeFileSync(path.join(root, '.build-studio', 'local.json'), localJson);
  }
  return root;
}

function clean(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

const BASE_YAML = 'name: t\nport: 3999\n';

test('cli defaults: no cli block anywhere → claude, null models', () => {
  const root = makeProject(BASE_YAML);
  try {
    const cfg = loadConfig(root);
    assert.deepEqual(cfg.cli, CLI_DEFAULTS);
    assert.equal(cfg.cli.default, 'claude');
  } finally { clean(root); }
});

test('cli from config.yaml is honored', () => {
  const root = makeProject(BASE_YAML + 'cli:\n  default: codex\n  developer_model: openrouter/a/b\n');
  try {
    const cfg = loadConfig(root);
    assert.equal(cfg.cli.default, 'codex');
    assert.equal(cfg.cli.developer_model, 'openrouter/a/b');
    assert.equal(cfg.cli.reviewer_model, null);
  } finally { clean(root); }
});

test('local.json overrides config.yaml for cli (hub writes win)', () => {
  const root = makeProject(
    BASE_YAML + 'cli:\n  default: claude\n  developer_model: openrouter/a/b\n',
    JSON.stringify({ cli: { default: 'opencode', reviewer_model: 'openrouter/c/d' } })
  );
  try {
    const cfg = loadConfig(root);
    // local.json wins where set…
    assert.equal(cfg.cli.default, 'opencode');
    assert.equal(cfg.cli.reviewer_model, 'openrouter/c/d');
    // …yaml value survives where local.json is silent.
    assert.equal(cfg.cli.developer_model, 'openrouter/a/b');
  } finally { clean(root); }
});

test('invalid cli.default falls back to claude with a warning', () => {
  const root = makeProject(BASE_YAML + 'cli:\n  default: bogus\n');
  try {
    const cfg = loadConfig(root);
    assert.equal(cfg.cli.default, 'claude');
  } finally { clean(root); }
});

test('corrupt local.json is tolerated (yaml stays authoritative)', () => {
  const root = makeProject(BASE_YAML + 'cli:\n  default: codex\n', '{ not json');
  try {
    const cfg = loadConfig(root);
    assert.equal(cfg.cli.default, 'codex');
    assert.deepEqual(loadLocalOverrides(root), {});
  } finally { clean(root); }
});

test('saveLocalOverrides: shallow-merges per top-level key, preserves others', () => {
  const root = makeProject(BASE_YAML);
  try {
    saveLocalOverrides(root, { cli: { default: 'opencode' } });
    saveLocalOverrides(root, { cli: { developer_model: 'openrouter/x/y' } });
    const local = loadLocalOverrides(root);
    assert.deepEqual(local.cli, { default: 'opencode', developer_model: 'openrouter/x/y' });

    // null clears a field; unrelated keys preserved
    saveLocalOverrides(root, { cli: { developer_model: null } });
    const local2 = loadLocalOverrides(root);
    assert.deepEqual(local2.cli, { default: 'opencode', developer_model: null });

    // config.yaml on disk was never touched by saves
    const yamlOnDisk = fs.readFileSync(path.join(root, '.build-studio', 'config.yaml'), 'utf8');
    assert.equal(yamlOnDisk, BASE_YAML);
  } finally { clean(root); }
});
