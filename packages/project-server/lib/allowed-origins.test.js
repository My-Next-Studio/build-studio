const { test } = require('node:test');
const assert = require('node:assert');
const {
  defaultAllowedOrigins,
  parseAllowedOrigins,
  isAllowedOrigin,
} = require('./allowed-origins');

const ALLOW = defaultAllowedOrigins();

test('hub origin is allowed under both spellings of loopback', () => {
  assert.strictEqual(isAllowedOrigin('http://localhost:18080', ALLOW), true);
  assert.strictEqual(isAllowedOrigin('http://127.0.0.1:18080', ALLOW), true);
});

test('an arbitrary website is rejected', () => {
  assert.strictEqual(isAllowedOrigin('https://evil.example', ALLOW), false);
});

test('a different localhost port is rejected', () => {
  // A page served from any other local port is still a different origin, and
  // "it is on localhost" is not evidence that it is the hub.
  assert.strictEqual(isAllowedOrigin('http://localhost:3000', ALLOW), false);
});

test('https on the hub port is rejected', () => {
  // Scheme is part of the origin; the hub is served over http.
  assert.strictEqual(isAllowedOrigin('https://localhost:18080', ALLOW), false);
});

test('a prefix of an allowed origin is rejected', () => {
  // Guards against ever reverting this to a startsWith check.
  assert.strictEqual(isAllowedOrigin('http://localhost:18080.evil.example', ALLOW), false);
});

test('missing origin is allowed — non-browser clients are not the exposure', () => {
  assert.strictEqual(isAllowedOrigin(undefined, ALLOW), true);
  assert.strictEqual(isAllowedOrigin('', ALLOW), true);
});

test("the string 'null' is rejected, unlike a missing origin", () => {
  // Sandboxed iframes and file:// pages send Origin: null, and an attacker can
  // arrange that — it must not be treated as "no browser involved".
  assert.strictEqual(isAllowedOrigin('null', ALLOW), false);
});

test('BUILD_STUDIO_ALLOWED_ORIGINS overrides the default list', () => {
  const list = parseAllowedOrigins('http://localhost:4000,https://studio.example');
  assert.deepStrictEqual(list, ['http://localhost:4000', 'https://studio.example']);
  assert.strictEqual(isAllowedOrigin('https://studio.example', list), true);
  // An explicit list replaces the defaults rather than extending them.
  assert.strictEqual(isAllowedOrigin('http://localhost:18080', list), false);
});

test('override tolerates whitespace and trailing commas', () => {
  const list = parseAllowedOrigins(' http://a.example , http://b.example ,');
  assert.deepStrictEqual(list, ['http://a.example', 'http://b.example']);
});

test('unset or blank override falls back to the hub defaults', () => {
  assert.deepStrictEqual(parseAllowedOrigins(undefined), ALLOW);
  assert.deepStrictEqual(parseAllowedOrigins(''), ALLOW);
  assert.deepStrictEqual(parseAllowedOrigins('   '), ALLOW);
  assert.deepStrictEqual(parseAllowedOrigins(' , , '), ALLOW);
});

test('a wildcard in the override is treated as a literal, never as "any"', () => {
  // If someone puts '*' in the env var expecting the old behaviour, it must
  // fail closed rather than silently restoring the hole this replaced.
  const list = parseAllowedOrigins('*');
  assert.strictEqual(isAllowedOrigin('https://evil.example', list), false);
});
