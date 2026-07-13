const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ensureMcpAutoApprove } = require('./claude-settings');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-settings-'));
}

test('creates .claude/settings.local.json with the flag when absent', () => {
  const dir = tmpdir();
  assert.equal(ensureMcpAutoApprove(dir), true);
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'));
  assert.equal(settings.enableAllProjectMcpServers, true);
});

test('merges into an existing file without dropping other keys', () => {
  const dir = tmpdir();
  const claudeDir = path.join(dir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.local.json'),
    JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }));
  assert.equal(ensureMcpAutoApprove(dir), true);
  const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, 'settings.local.json'), 'utf8'));
  assert.equal(settings.enableAllProjectMcpServers, true);
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] });
});

test('is idempotent when the flag is already set', () => {
  const dir = tmpdir();
  assert.equal(ensureMcpAutoApprove(dir), true);
  const file = path.join(dir, '.claude', 'settings.local.json');
  const before = fs.statSync(file).mtimeMs;
  assert.equal(ensureMcpAutoApprove(dir), true);
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test('leaves an unparseable settings file untouched', () => {
  const dir = tmpdir();
  const claudeDir = path.join(dir, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, 'settings.local.json'), '{ not json');
  assert.equal(ensureMcpAutoApprove(dir), false);
  assert.equal(fs.readFileSync(path.join(claudeDir, 'settings.local.json'), 'utf8'), '{ not json');
});
