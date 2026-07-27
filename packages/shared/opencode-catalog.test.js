'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  parseOpencodeModelsOutput,
  parseModelEfforts,
  parseModelContexts,
  parseProviderModelIds,
  getCatalog,
  isCurrentCatalogSchema,
} = require('./opencode-catalog');

test('parseOpencodeModelsOutput: strict provider/model lines, tolerant fallback', () => {
  const out = 'opencode/big-pickle\nopenrouter/moonshotai/kimi-k3\nopenrouter/~anthropic/claude-fable-latest\n';
  assert.deepEqual(parseOpencodeModelsOutput(out), [
    'opencode/big-pickle',
    'openrouter/moonshotai/kimi-k3',
    'openrouter/~anthropic/claude-fable-latest',
  ]);
  // No strict matches → non-empty token lines so the picker degrades, not empties
  assert.deepEqual(parseOpencodeModelsOutput('weird line with spaces\nok-token\n'), ['ok-token']);
  assert.deepEqual(parseOpencodeModelsOutput(''), []);
});

test('parseModelContexts: context window per provider/model, skips non-numeric', () => {
  const apiJson = {
    anthropic: {
      models: {
        'claude-opus-5': { limit: { context: 1000000, output: 128000 } },
        'claude-haiku-4-5': { limit: { context: 200000 } },
        'no-limit-block': {},
        'bad-context': { limit: { context: 'lots' } },
      },
    },
  };
  const ctx = parseModelContexts(apiJson);
  assert.equal(ctx['anthropic/claude-opus-5'], 1000000);
  assert.equal(ctx['anthropic/claude-haiku-4-5'], 200000);
  // Missing/garbage limits are absent, so the `[1m]` synthesis simply skips
  // them rather than inventing an id the CLI would reject.
  assert.equal(ctx['anthropic/no-limit-block'], undefined);
  assert.equal(ctx['anthropic/bad-context'], undefined);
  assert.deepEqual(parseModelContexts(null), {});
});

test('parseProviderModelIds: drives both the codex and claude pickers', () => {
  const apiJson = {
    anthropic: { models: { 'claude-opus-5': {}, 'claude-sonnet-5': {} } },
    openai: { models: { 'gpt-5.2-codex': {} } },
  };
  assert.deepEqual(parseProviderModelIds(apiJson, 'anthropic'), ['claude-opus-5', 'claude-sonnet-5']);
  assert.deepEqual(parseProviderModelIds(apiJson, 'openai'), ['gpt-5.2-codex']);
  assert.deepEqual(parseProviderModelIds(apiJson, 'nope'), []);
});

test('parseModelEfforts: effort values per provider/model, skips non-effort entries', () => {
  const apiJson = {
    openrouter: {
      models: {
        'moonshotai/kimi-k3': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] },
        'some/text-only': { reasoning: false },
        'bad/entry': { reasoning_options: [{ type: 'effort', values: [] }] },
        'odd/entry': { reasoning_options: [{ type: 'budget', values: ['1000'] }] },
      },
    },
    opencode: {
      models: {
        'big-pickle': { reasoning_options: [{ type: 'effort', values: ['minimal', 'low', 'medium', 'high'] }] },
      },
    },
    'no-models-key': {},
  };
  const efforts = parseModelEfforts(apiJson);
  assert.deepEqual(efforts['openrouter/moonshotai/kimi-k3'], ['low', 'high', 'max']);
  assert.deepEqual(efforts['opencode/big-pickle'], ['minimal', 'low', 'medium', 'high']);
  assert.equal(efforts['openrouter/some/text-only'], undefined);
  assert.equal(efforts['openrouter/bad/entry'], undefined);
  assert.equal(efforts['openrouter/odd/entry'], undefined); // non-effort reasoning_option
  assert.deepEqual(parseModelEfforts(null), {});
});

test('getCatalog: cache honored within TTL; refresh combines both sources; stale fallback on total failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-catalog-'));
  const cachePath = path.join(dir, 'cache.json');

  const modelsJson = { openrouter: { models: { 'a/b': { reasoning_options: [{ type: 'effort', values: ['low'] }] } } } };
  const goodExec = () => 'openrouter/a/b\nopencode/x\n';
  const goodFetch = async () => ({ ok: true, json: async () => modelsJson });

  const first = await getCatalog({ cachePath, execImpl: goodExec, fetchImpl: goodFetch, refresh: true });
  assert.equal(first.cached, false);
  assert.deepEqual(first.models, ['openrouter/a/b', 'opencode/x']);
  assert.deepEqual(first.efforts, { 'openrouter/a/b': ['low'] });

  // Within TTL → cache, injected impls not consulted
  const badExec = () => { throw new Error('must not be called'); };
  const badFetch = async () => { throw new Error('must not be called'); };
  const second = await getCatalog({ cachePath, execImpl: badExec, fetchImpl: badFetch });
  assert.equal(second.cached, true);
  assert.deepEqual(second.models, first.models);

  // Refresh with total failure → stale cache, never hard-fails
  const third = await getCatalog({ cachePath, execImpl: badExec, fetchImpl: badFetch, refresh: true });
  assert.equal(third.stale, true);
  assert.deepEqual(third.models, first.models);

  // Refresh with partial failure (models.dev down) → fresh models + cached efforts
  const partial = await getCatalog({ cachePath, execImpl: goodExec, fetchImpl: badFetch, refresh: true });
  assert.equal(partial.stale, true);
  assert.deepEqual(partial.models, ['openrouter/a/b', 'opencode/x']);
  assert.deepEqual(partial.efforts, { 'openrouter/a/b': ['low'] });
});

test('getCatalog: a pre-upgrade cache is refetched, not served with holes', async () => {
  // Regression: a cache written before `anthropicModels`/`contexts` existed
  // still satisfied the TTL check, so the claude picker silently fell back to
  // its static list for up to 24h after an upgrade.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-catalog-old-'));
  const cachePath = path.join(dir, 'cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({
    fetchedAt: new Date().toISOString(), // well inside the TTL
    models: ['openrouter/a/b'],
    efforts: { 'openrouter/a/b': ['low'] },
    openaiModels: ['gpt-5.2-codex'],
    // no anthropicModels, no contexts — the pre-upgrade shape
  }));
  assert.equal(isCurrentCatalogSchema(JSON.parse(fs.readFileSync(cachePath, 'utf8'))), false);

  const apiJson = {
    anthropic: { models: { 'claude-opus-5': { limit: { context: 1000000 } } } },
    openai: { models: { 'gpt-5.2-codex': {} } },
  };
  const fresh = await getCatalog({
    cachePath,
    execImpl: () => 'openrouter/a/b\n',
    fetchImpl: async () => ({ ok: true, json: async () => apiJson }),
  });
  // Refetched despite being inside the TTL, and the new fields are populated.
  assert.equal(fresh.cached, false);
  assert.deepEqual(fresh.anthropicModels, ['claude-opus-5']);
  assert.equal(fresh.contexts['anthropic/claude-opus-5'], 1000000);

  // …and the refreshed payload now satisfies the TTL check on the next read.
  const second = await getCatalog({
    cachePath,
    execImpl: () => { throw new Error('must not be called'); },
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(second.cached, true);
  assert.deepEqual(second.anthropicModels, ['claude-opus-5']);
});

test('getCatalog: an old-schema cache still serves as the offline fallback', async () => {
  // Schema mismatch must force a refetch, but never throw away the only data
  // available when the network is down.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-catalog-fb-'));
  const cachePath = path.join(dir, 'cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    models: ['openrouter/a/b'],
    efforts: { 'openrouter/a/b': ['low'] },
    openaiModels: [],
  }));
  const boom = () => { throw new Error('offline'); };
  const out = await getCatalog({ cachePath, execImpl: boom, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(out.stale, true);
  assert.deepEqual(out.models, ['openrouter/a/b']);
});
