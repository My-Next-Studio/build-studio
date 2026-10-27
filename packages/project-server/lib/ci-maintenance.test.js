'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createCiMaintenance, composeMaintenancePrompt, stateFileFor } = require('./ci-maintenance');

const FLAG = {
  baselineSeconds: 6735, latestSeconds: 8778, overPct: 30,
  since: { id: 1, createdAt: '2026-10-18T13:24:22Z', sha: '4c00efaa5dad', title: 'chore: x' },
  grownSteps: [{ step: 'gates › Lighthouse', beforeSeconds: 1361, nowSeconds: 2217, deltaSeconds: 856 }],
};
const WEB = { name: 'Web', state: 'over', medianSeconds: 6900, latest: { id: 7, seconds: 8778 }, flag: FLAG };

function setup({ status = 'Backlog', oneshot = 'running' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-maint-'));
  const calls = { prompts: [], items: [], markers: [], commits: [] };
  const items = {};
  let runState = oneshot;
  const ciRuntime = {
    enabled: true,
    get: () => ({ workflows: [WEB] }),
    run: (id) => (id === 7 ? { id: 7, url: 'https://x/run/7', steps: { 'gates › Lighthouse': 2217, 'gates › npm test': 3144 } } : null),
    markBaseline: (at, reason) => { calls.markers.push({ at, reason }); return ['Web', 'Docs CI']; },
  };
  const m = createCiMaintenance({ projectRoot: root, deployment: { repo: 'a/b' } }, ciRuntime, {
    stateFile: path.join(root, 'state.json'),
    runOneShot: ({ prompt }) => { calls.prompts.push(prompt); return { runId: 'r1' }; },
    getOneShotStatus: () => (runState ? { state: runState, stderr: 'boom' } : null),
    createItem: (_root, _docs, item) => {
      calls.items.push(item);
      items['FAZ-9'] = { id: 'FAZ-9', status };
      return { id: 'FAZ-9' };
    },
    readItem: (_root, _docs, id) => items[id] || null,
    scopedCommit: async (_root, paths, msg) => { calls.commits.push(msg); return { committed: true }; },
    now: () => Date.parse('2026-10-28T10:00:00Z'),
  });
  return {
    m, root, calls, items,
    finish: (result) => {
      runState = 'complete';
      if (result) fs.writeFileSync(m.status().resultFile, JSON.stringify(result));
    },
    setRun: (s) => { runState = s; },
  };
}

test('the prompt carries the numbers, the grown steps and where the time goes, and forbids changes', () => {
  const p = composeMaintenancePrompt({
    repo: 'a/b', workflow: WEB, resultFile: '/tmp/r.json',
    latestRun: { url: 'https://x/run/7', steps: { 'gates › Lighthouse': 2217, 'gates › npm test': 3144 } },
  });
  assert.match(p, /ANALYSIS ONLY/);
  assert.match(p, /Do not write the PRD yourself/);
  assert.match(p, /2h26 now, against a baseline of 1h52 \(30% over\)/);
  assert.match(p, /gates › Lighthouse: 23 → 37 min/);
  assert.match(p, /- gates › npm test: 52 min\n- gates › Lighthouse: 37 min/, 'largest step first');
  assert.match(p, /name the test that still covers that\s+acceptance criterion/);
  assert.match(p, /\/tmp\/r\.json/);
});

test('start launches one analysis and records it; a second start is refused', () => {
  const { m, calls } = setup();
  const s = m.start('Web');
  assert.equal(s.state, 'running');
  assert.equal(calls.prompts.length, 1);
  assert.throws(() => m.start('Web'), /already running/);
});

test('a finished analysis is filed as a backlog Task the owner can Draft', async () => {
  const { m, calls, finish, root } = setup();
  fs.mkdirSync(path.join(root, '.git'));
  m.start('Web');
  finish({ title: 'Web CI: merge the Lighthouse passes', summary: 'Two gates audit the same pages.', estimatedSavingsMinutes: 25, body: '## Proposals\n| a | b |' });
  const s = await m.tick();
  assert.equal(s.state, 'filed');
  assert.equal(s.itemId, 'FAZ-9');
  const item = calls.items[0];
  assert.equal(item.type, 'Task');
  assert.equal(item.title, 'Web CI: merge the Lighthouse passes');
  assert.match(item.body, /2h26 of runner time against a baseline of 1h52 \(30% over\)/);
  assert.match(item.body, /about 25 runner minutes/);
  assert.match(item.body, /restarts the CI runtime baseline/);
  assert.match(item.body, /## Proposals/);
  assert.deepEqual(calls.commits, ['docs(FAZ-9): add CI maintenance pass to the backlog']);
  assert.throws(() => m.start('Web'), /already filed as FAZ-9/);
});

test('the baseline restarts for every workflow once the item is implemented, not before', async () => {
  const t = setup();
  t.m.start('Web');
  t.finish({ title: 't', body: 'b' });
  await t.m.tick();
  await t.m.tick();
  assert.equal(t.calls.markers.length, 0, 'still in the backlog');
  t.items['FAZ-9'].status = 'Implemented';
  const s = await t.m.tick();
  assert.equal(s.state, 'done');
  assert.deepEqual(t.calls.markers, [{ at: '2026-10-28T10:00:00.000Z', reason: 'maintenance' }]);
  assert.equal(t.m.start('Web').state, 'running', 'a new pass can start after a finished one');
});

test('a failed or timed-out analysis is reported, and can be started again', async () => {
  const t = setup();
  t.m.start('Web');
  t.setRun('timeout');
  const s = await t.m.tick();
  assert.equal(s.state, 'error');
  assert.match(s.error, /timed out/);
  assert.equal(t.m.start('Web').state, 'running');
});

test('after a server restart, a result on disk is still filed; without one the pass is lost', async () => {
  const a = setup();
  a.m.start('Web');
  fs.writeFileSync(a.m.status().resultFile, JSON.stringify({ title: 't', body: 'b' }));
  a.setRun(null);
  assert.equal((await a.m.tick()).state, 'filed');

  const b = setup();
  b.m.start('Web');
  b.setRun(null);
  assert.equal((await b.m.tick()).state, 'lost');
});

test('an item deleted from the backlog ends the pass instead of blocking the button forever', async () => {
  const t = setup();
  t.m.start('Web');
  t.finish({ title: 't', body: 'b' });
  await t.m.tick();
  delete t.items['FAZ-9'];
  const s = await t.m.tick();
  assert.equal(s.state, 'error');
  assert.match(s.error, /no longer in the backlog/);
});

test('the state file sits beside the runtime store', () => {
  assert.equal(stateFileFor('/h/.build-studio/ci-runtime/a__b.json'), '/h/.build-studio/ci-runtime/a__b.maintenance.json');
});
