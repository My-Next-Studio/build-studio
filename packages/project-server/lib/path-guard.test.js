const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { assertInside } = require('./path-guard');

const BASE = '/foo/marketing';

test('happy path — file directly inside base', () => {
  const result = assertInside('file.md', BASE);
  assert.equal(result, path.join(BASE, 'file.md'));
});

test('happy path — nested file inside base', () => {
  const result = assertInside('subdir/file.md', BASE);
  assert.equal(result, path.join(BASE, 'subdir', 'file.md'));
});

test('happy path — base itself resolves cleanly', () => {
  const result = assertInside('.', BASE);
  assert.equal(result, BASE);
});

test('traversal — single ../ escapes base', () => {
  assert.throws(() => assertInside('../escape.md', BASE), { code: 'FORBIDDEN' });
});

test('traversal — deep nested then escape', () => {
  assert.throws(() => assertInside('subdir/../../escape.md', BASE), { code: 'FORBIDDEN' });
});

test('absolute path — pointing outside base', () => {
  assert.throws(() => assertInside('/etc/passwd', BASE), { code: 'FORBIDDEN' });
});

test('absolute path — pointing at base itself is allowed', () => {
  const result = assertInside(BASE, BASE);
  assert.equal(result, BASE);
});

test('prefix-spoofing — /foo/marketing-evil/file.md rejected against /foo/marketing', () => {
  // Without the path.sep guard, startsWith('/foo/marketing') would match '/foo/marketing-evil/...'
  assert.throws(() => assertInside('../marketing-evil/file.md', BASE), { code: 'FORBIDDEN' });
});

test('prefix-spoofing — sibling directory with shared prefix', () => {
  // /foo/marketing-extra resolves as sibling, not child
  assert.throws(() => assertInside('/foo/marketing-extra/file.md', BASE), { code: 'FORBIDDEN' });
});
