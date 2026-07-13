const { test } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const { expandTilde, resolveUserPath } = require('./paths');

test('expandTilde: expands ~/ to the home directory', () => {
  assert.equal(expandTilde('~/projects/x'), path.join(os.homedir(), 'projects/x'));
});

test('expandTilde: bare ~ becomes home', () => {
  assert.equal(expandTilde('~'), os.homedir());
});

test('expandTilde: leaves absolute and relative paths alone', () => {
  assert.equal(expandTilde('/tmp/x'), '/tmp/x');
  assert.equal(expandTilde('projects/x'), 'projects/x');
  assert.equal(expandTilde('x~y'), 'x~y');
});

test('expandTilde: does not expand ~user form', () => {
  assert.equal(expandTilde('~other/x'), '~other/x');
});

test('expandTilde: non-strings pass through', () => {
  assert.equal(expandTilde(undefined), undefined);
});

test('resolveUserPath: absolute result for tilde input', () => {
  assert.equal(resolveUserPath('~/a'), path.join(os.homedir(), 'a'));
  assert.ok(path.isAbsolute(resolveUserPath('~/a')));
});
