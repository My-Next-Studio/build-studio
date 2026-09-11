'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeModelId, rateFor, costUSD, pricedModels } = require('./token-pricing');

// ── the rule that matters most ───────────────────────────────────────────────

test('an unknown model prices to null, never to a default', () => {
  // The table this replaces did `TOKEN_COSTS[model] || TOKEN_COSTS.sonnet`, so
  // every id in real use fell through to Sonnet 4.x rates and nobody noticed
  // for months. A fallback here is the bug, not the safety net.
  assert.equal(costUSD('some-model-nobody-configured', { inputTokens: 1e6 }), null);
  assert.equal(costUSD('', { inputTokens: 1e6 }), null);
  assert.equal(costUSD(null, { inputTokens: 1e6 }), null);
  assert.equal(rateFor('gpt-4o'), null);
});

test('a priced model with no usage is still null, not zero', () => {
  assert.equal(costUSD('claude-opus-5', null), null);
});

// ── id normalisation, against the shapes actually stored ─────────────────────

test('the long-context suffix resolves to the base model', () => {
  // `claude-opus-5[1m]` is what this installation's config stores, and it
  // matched no key in the old table — the single most common id here.
  assert.equal(normalizeModelId('claude-opus-5[1m]'), 'claude-opus-5');
  assert.ok(rateFor('claude-opus-5[1m]'));
});

test('an OpenRouter routing prefix is dropped', () => {
  assert.equal(normalizeModelId('openrouter/x-ai/grok-4.6'), 'x-ai/grok-4.6');
  assert.ok(rateFor('openrouter/x-ai/grok-4.6'));
});

test('a dated snapshot resolves to its family', () => {
  assert.equal(normalizeModelId('claude-opus-5-20260514'), 'claude-opus-5');
});

test('matching is case-insensitive and tolerates whitespace', () => {
  assert.ok(rateFor('  Claude-Opus-5  '));
});

test('an unknown id normalises without throwing and stays unpriced', () => {
  assert.equal(normalizeModelId('llama-9'), 'llama-9');
  assert.equal(rateFor('llama-9'), null);
});

// ── the arithmetic ───────────────────────────────────────────────────────────

test('all four token classes are billed at their own rate', () => {
  // 1M of each against opus-5: 5 + 25 + 0.5 + 6.25
  const c = costUSD('claude-opus-5', {
    inputTokens: 1e6, outputTokens: 1e6, cacheRead: 1e6, cacheCreate: 1e6,
  });
  assert.equal(c, 36.75);
});

test('cache reads are priced separately, because they dominate', () => {
  // A measured run: 28.4M cache reads against 173K output, a ratio near 200:1.
  // A table without this column is not approximately right — it is wrong by two
  // orders of magnitude on the term that decides the answer.
  const withCache = costUSD('claude-opus-5', { cacheRead: 17_144_637 });
  assert.ok(Math.abs(withCache - 8.5723) < 0.001, `got ${withCache}`);
  assert.equal(costUSD('claude-opus-5', { cacheRead: 0 }), 0);
});

test('the old fallback would have understated a real agent', () => {
  // The FAZ-shaped case: an opus-5 agent priced at Sonnet 4.x rates. The point
  // is direction and magnitude, not a precise ratio.
  const real = costUSD('claude-opus-5', { cacheRead: 17_144_637, outputTokens: 41_004, cacheCreate: 265_876 });
  const asSonnet = costUSD('claude-sonnet-4-6', { cacheRead: 17_144_637, outputTokens: 41_004, cacheCreate: 265_876 });
  assert.ok(real > asSonnet * 1.5, `real ${real} should be well above sonnet-priced ${asSonnet}`);
});

test('missing or non-numeric usage fields count as zero, not NaN', () => {
  // A partially-populated usage object must not poison a sum with NaN — that
  // propagates through an entire project total silently.
  const c = costUSD('claude-opus-5', { inputTokens: '1000000', outputTokens: undefined, cacheRead: null });
  assert.equal(c, 5);
});

// ── coverage, for the scorecard ──────────────────────────────────────────────

test('the models this installation actually runs are all priced', () => {
  // Config'd today: opus-5 (default + review + plan), gpt-5.6-sol (build).
  for (const m of ['claude-opus-5[1m]', 'claude-sonnet-5', 'gpt-5.6-sol']) {
    assert.ok(rateFor(m), `${m} must be priced or its agents show no cost`);
  }
});

test('pricedModels lists what a scorecard can cost, for gap reporting', () => {
  const list = pricedModels();
  assert.ok(list.includes('claude-opus-5'));
  assert.ok(list.includes('gpt-5.6-sol'));
  assert.deepEqual(list, [...list].sort(), 'stable order');
});

// A bare CLI alias is the ORDINARY case, not an edge one: the launcher stores
// whatever `agent_defaults.model` holds, and that defaults to the literal 'opus'.
// Before this, such an agent carried real token counts and costUSD null — eleven
// of them in one measured run (2026-09-11) — so the most common configuration on
// the platform reported as "unmeasured".
test('bare CLI aliases price through the same table the launcher resolves', () => {
  assert.equal(normalizeModelId('sonnet'), 'claude-sonnet-5');
  assert.equal(normalizeModelId('opus'), 'claude-opus-4-8');
  assert.equal(normalizeModelId('opus[1m]'), 'claude-opus-4-8');
  assert.ok(rateFor('sonnet'), 'an alias must resolve to a rate');
  assert.ok(rateFor('opus'), 'an alias must resolve to a rate');
  assert.ok(costUSD('sonnet', { inputTokens: 1000, outputTokens: 1000 }) > 0);
});

// The honesty property this module exists for must survive the alias change: an
// unknown model is still null, never silently priced as something else.
test('an unknown model is still unpriced rather than guessed', () => {
  assert.equal(rateFor('not-a-real-model'), null);
  assert.equal(costUSD('not-a-real-model', { inputTokens: 1000, outputTokens: 1000 }), null);
});
