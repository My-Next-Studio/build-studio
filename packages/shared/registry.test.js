'use strict';

// A project's port is the `port:` key in its .build-studio/config.yaml; the
// port stored in the registry is only the fallback (docs/backlog-api-contract.md
// §1). The registry resolves its path from the home directory when it loads,
// so each case runs in a child process with HOME pointed at a scratch dir and
// never touches the real ~/.build-studio.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REGISTRY = path.join(__dirname, 'registry.js');

function scratch(projects) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-test-'));
  const entries = {};
  for (const [name, { registryPort, config }] of Object.entries(projects)) {
    const root = path.join(home, 'projects', name);
    fs.mkdirSync(path.join(root, '.build-studio'), { recursive: true });
    if (config !== undefined) fs.writeFileSync(path.join(root, '.build-studio', 'config.yaml'), config);
    entries[name] = { path: root, port: registryPort, addedAt: '2026-10-10T00:00:00.000Z' };
  }
  fs.mkdirSync(path.join(home, '.build-studio'));
  fs.writeFileSync(path.join(home, '.build-studio', 'registry.json'), JSON.stringify({ version: 1, projects: entries }));
  return home;
}

function inChild(home, expr) {
  const out = execFileSync(process.execPath, ['-e', `const r = require(${JSON.stringify(REGISTRY)}); process.stdout.write(JSON.stringify(${expr}))`], {
    env: { ...process.env, HOME: home }, encoding: 'utf8',
  });
  return JSON.parse(out);
}

test('config.yaml\'s port wins over the registry\'s, in list, get and findByPath', () => {
  const home = scratch({ alpha: { registryPort: 3002, config: 'name: alpha\nport: 3000\ndocs_path: ./docs\n' } });
  try {
    assert.equal(inChild(home, 'r.get("alpha").port'), 3000);
    assert.deepEqual(inChild(home, 'r.list().map(p => [p.name, p.port])'), [['alpha', 3000]]);
    assert.equal(inChild(home, `r.findByPath(${JSON.stringify(path.join(home, 'projects', 'alpha'))}).port`), 3000);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('without the key or the file, the registry\'s port is the fallback', () => {
  const home = scratch({
    nokey: { registryPort: 3004, config: 'name: nokey\ndocs_path: ./docs\n' },
    nofile: { registryPort: 3005 },
  });
  try {
    assert.deepEqual(inChild(home, 'r.list().map(p => [p.name, p.port])'), [['nokey', 3004], ['nofile', 3005]]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('only a top-level port key counts, with or without a trailing comment', () => {
  const home = scratch({
    nested: { registryPort: 3006, config: 'name: nested\ndeployment:\n  port: 9999\n' },
    commented: { registryPort: 3007, config: 'name: commented\nport: 3010   # the project server\n' },
  });
  try {
    assert.deepEqual(inChild(home, 'r.list().map(p => [p.name, p.port])'), [['nested', 3006], ['commented', 3010]]);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('nextAvailablePort skips ports claimed in a project\'s config.yaml', () => {
  // 3001 is free in the registry but claimed by beta's config.yaml.
  const home = scratch({ beta: { registryPort: 3003, config: 'name: beta\nport: 3001\n' } });
  try {
    assert.equal(inChild(home, 'r.nextAvailablePort()'), 3002);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the registry file itself is not rewritten by reading', () => {
  const home = scratch({ alpha: { registryPort: 3002, config: 'name: alpha\nport: 3000\n' } });
  try {
    const before = fs.readFileSync(path.join(home, '.build-studio', 'registry.json'), 'utf8');
    inChild(home, 'r.list()');
    assert.equal(fs.readFileSync(path.join(home, '.build-studio', 'registry.json'), 'utf8'), before);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
