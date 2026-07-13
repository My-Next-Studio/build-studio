const { test } = require('node:test');
const assert = require('node:assert');
const { resolvePermissionMode, claudePermissionFlag } = require('./permission-mode');

test('explicit permission_mode wins over legacy skip_permissions', () => {
  assert.equal(resolvePermissionMode({ permission_mode: 'dontAsk', skip_permissions: true }), 'dontAsk');
});

test('legacy skip_permissions true → bypassPermissions, false → default', () => {
  assert.equal(resolvePermissionMode({ skip_permissions: true }), 'bypassPermissions');
  assert.equal(resolvePermissionMode({ skip_permissions: false }), 'default');
});

test('nothing configured → auto', () => {
  assert.equal(resolvePermissionMode({}), 'auto');
  assert.equal(resolvePermissionMode(undefined), 'auto');
});

test('invalid permission_mode falls back to auto', () => {
  assert.equal(resolvePermissionMode({ permission_mode: 'yolo' }), 'auto');
});

test('claudePermissionFlag omits the flag only for default', () => {
  assert.equal(claudePermissionFlag('default'), '');
  assert.equal(claudePermissionFlag('auto'), ' --permission-mode auto');
  assert.equal(claudePermissionFlag('bypassPermissions'), ' --permission-mode bypassPermissions');
});
