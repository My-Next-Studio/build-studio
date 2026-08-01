'use strict';

// Config hot-reload depends on noticing writes to config.yaml, local.json and
// the global config.json. Every one of those is written atomically — tmp file
// then rename — and that is the case a naive watcher gets wrong, so it is the
// case pinned here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { watchPaths } = require('./config');

const settle = (ms = 400) => new Promise(r => setTimeout(r, ms));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bs-watch-'));
}

/** How every config writer in this codebase saves: write .tmp, rename over. */
function atomicWrite(file, contents) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

test('fires on every atomic replace, not just the first', async () => {
  // The regression: fs.watch on a FILE follows the inode, so a rename over it
  // leaves the watcher attached to a deleted inode. It fired once and went
  // deaf — a global Model page change reached running servers exactly once,
  // and the revert silently did not.
  const dir = tmpDir();
  const target = path.join(dir, 'config.json');
  fs.writeFileSync(target, '{"v":0}');

  let hits = 0;
  const stop = watchPaths([target], () => { hits++; });
  await settle(300); // let the watcher arm

  for (let v = 1; v <= 3; v++) {
    atomicWrite(target, JSON.stringify({ v }));
    await settle(250);
  }
  stop();
  assert.ok(hits >= 3, `expected an event per write, got ${hits}`);
});

test('ignores unrelated files in the same directory', async () => {
  // ~/.build-studio also holds usage-cache.json, opencode-catalog-cache.json
  // and learnings-stats.json, all rewritten constantly. Reloading the whole
  // project config on those would be pure waste.
  const dir = tmpDir();
  const target = path.join(dir, 'config.json');
  fs.writeFileSync(target, '{"v":0}');

  let hits = 0;
  const stop = watchPaths([target], () => { hits++; });
  await settle(400);
  hits = 0; // discard any late-delivered event from the setup write

  for (let i = 0; i < 5; i++) {
    atomicWrite(path.join(dir, 'usage-cache.json'), JSON.stringify({ i }));
    await settle(120);
  }
  await settle(300);
  stop();
  assert.equal(hits, 0, `unrelated writes should not fire, got ${hits}`);
});

test('notices a watched file that did not exist when watching began', async () => {
  // local.json is often absent until the first Model page edit. The old file
  // form threw on a missing path and silently skipped it forever.
  const dir = tmpDir();
  const target = path.join(dir, 'local.json');

  let hits = 0;
  const stop = watchPaths([target], () => { hits++; });
  await settle(300);

  atomicWrite(target, '{"cli":{}}');
  await settle(400);
  stop();
  assert.ok(hits >= 1, `expected creation to fire, got ${hits}`);
});

test('watches several files across several directories', async () => {
  const a = tmpDir();
  const b = tmpDir();
  const fileA = path.join(a, 'config.yaml');
  const fileB = path.join(b, 'config.json');
  fs.writeFileSync(fileA, 'name: x\n');
  fs.writeFileSync(fileB, '{}');

  let hits = 0;
  const stop = watchPaths([fileA, fileB], () => { hits++; });
  await settle(300);

  atomicWrite(fileA, 'name: y\n');
  await settle(250);
  const afterFirst = hits;
  atomicWrite(fileB, '{"v":1}');
  await settle(250);
  stop();

  assert.ok(afterFirst >= 1, 'first directory did not fire');
  assert.ok(hits > afterFirst, 'second directory did not fire');
});

test('stop() detaches, and is safe to call twice', async () => {
  const dir = tmpDir();
  const target = path.join(dir, 'config.json');
  fs.writeFileSync(target, '{}');

  let hits = 0;
  const stop = watchPaths([target], () => { hits++; });
  await settle(400);
  stop();
  stop(); // idempotent

  // Baseline at detach time: FSEvents can deliver a setup-write event late,
  // and that is not what this test is about. What matters is that nothing
  // arrives from a write made AFTER stop().
  const atStop = hits;
  atomicWrite(target, '{"v":1}');
  await settle(400);
  assert.equal(hits, atStop, `no events after stop, got ${hits - atStop} new`);
});

test('a missing directory is skipped without throwing', () => {
  const stop = watchPaths([path.join(tmpDir(), 'nope', 'deeper', 'config.json')], () => {});
  stop();
});
