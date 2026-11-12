'use strict';

// The Obsidian worklog write must never block the server (lib/obsidian-worklog.js).
// A fake CLI that ignores SIGTERM and never exits stands in for an Obsidian CLI
// waiting on an app that is not running.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { obsidianAppend } = require('./obsidian-worklog');

function fakeCli(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-obsidian-'));
  const bin = path.join(dir, 'obsidian');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { dir, bin, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const quiet = () => {
  const { log, warn } = console;
  console.log = () => {}; console.warn = () => {};
  return () => { console.log = log; console.warn = warn; };
};

test('a CLI that ignores SIGTERM and never exits neither blocks the caller nor outlives the timeout', async () => {
  const pidFile = path.join(os.tmpdir(), `bs-obsidian-pid-${process.pid}`);
  const cli = fakeCli(`trap '' TERM\necho $$ > '${pidFile}'\nwhile true; do sleep 1; done`);
  const restore = quiet();
  try {
    const t0 = Date.now();
    const pending = obsidianAppend({ vault: 'V', dailyPath: 'd.md', content: 'x', date: '2026-11-12', bin: cli.bin, timeoutMs: 300 });
    assert.ok(Date.now() - t0 < 100, 'returns before the CLI finishes');
    let ticked = false;
    setImmediate(() => { ticked = true; });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(ticked, 'the event loop keeps running while the CLI hangs');
    assert.equal(await pending, false);
    assert.ok(Date.now() - t0 < 2000, 'gives up at the timeout');
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), 'the hung CLI was killed');
  } finally { restore(); cli.done(); fs.rmSync(pidFile, { force: true }); }
});

test('a note the CLI reports missing is created, then appended to', async () => {
  const cli = fakeCli(`echo "$1" >> "${'$'}(dirname "$0")/calls"\nif [ "$1" = append ] && [ ! -f "${'$'}(dirname "$0")/created" ]; then echo "Error: file not found"; fi\nif [ "$1" = create ]; then touch "${'$'}(dirname "$0")/created"; fi`);
  const restore = quiet();
  try {
    const ok = await obsidianAppend({ vault: 'V', dailyPath: 'd.md', content: 'x', date: '2026-11-12', bin: cli.bin });
    assert.equal(ok, true);
    assert.deepEqual(fs.readFileSync(path.join(cli.dir, 'calls'), 'utf8').trim().split('\n'), ['append', 'create', 'append']);
  } finally { restore(); cli.done(); }
});

test('a missing CLI is a logged failure, not a throw', async () => {
  const restore = quiet();
  try {
    assert.equal(await obsidianAppend({ vault: 'V', dailyPath: 'd.md', content: 'x', date: '2026-11-12', bin: '/nonexistent/obsidian' }), false);
  } finally { restore(); }
});
