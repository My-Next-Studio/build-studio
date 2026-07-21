'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  parseOpencodeModelsOutput,
  parseModelEfforts,
  getCatalog,
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

test('parseModelEfforts: effort values per provider/model, skips non-effort entries', () => {
  const apiJson = {
    openrouter: {
      models: {
        'moonshotai/kimi-k3': { reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'high', 'max'] }] },
        'some/text-only': { reasoning: false },
        'bad/entry': { reasoning_options: [{ type: 'effort', values: [] }] },
      },
    },
  };
  const efforts = parseModelEfforts(apiJson);
  assert.deepEqual(efforts['openrouter/moonshotai/kimi-k3'], ['low', 'high', 'max']);
  assert.equal(efforts['openrouter/some/text-only'], undefined);
  assert.equal(efforts['openrouter/bad/entry'], undefined);
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
