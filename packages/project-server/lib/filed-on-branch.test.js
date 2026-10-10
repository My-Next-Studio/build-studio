'use strict';

// Items filed during a run live on the run's branch until it merges; the cancel
// dialog lists them because cancelling returns the checkout to the default
// branch, where they don't exist yet.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { itemsFiledOnBranch } = require('./filed-on-branch');

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'filed-on-branch-'));
  const g = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  fs.mkdirSync(path.join(root, 'docs', 'backlog'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'backlog', 'EX-001.md'), '---\nid: EX-001\ntitle: Already on main\n---\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  g('checkout', '-q', '-b', 'exec/EX-001');
  return { root, g };
}

test('lists the items added on the run branch, with their titles', () => {
  const { root, g } = repo();
  try {
    fs.writeFileSync(path.join(root, 'docs', 'backlog', 'EX-003.md'), '---\nid: EX-003\ntitle: >-\n  A long title from\n  the launch plan\n---\n');
    fs.writeFileSync(path.join(root, 'docs', 'backlog', 'EX-002.md'), '---\nid: EX-002\ntitle: Filed during the run\n---\n');
    fs.writeFileSync(path.join(root, 'docs', 'backlog', 'EX-001.md'), '---\nid: EX-001\ntitle: Edited, not added\nstatus: Done\n---\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'file two items');
    assert.deepEqual(itemsFiledOnBranch(root, './docs', 'exec/EX-001', 'main'), [
      { id: 'EX-002', title: 'Filed during the run' },
      { id: 'EX-003', title: 'A long title from the launch plan' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an item that also reached the default branch is not listed', () => {
  const { root, g } = repo();
  try {
    fs.writeFileSync(path.join(root, 'docs', 'backlog', 'EX-002.md'), '---\nid: EX-002\ntitle: Two\n---\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'two');
    g('checkout', '-q', 'main');
    g('merge', '-q', '--no-edit', 'exec/EX-001');
    g('checkout', '-q', 'exec/EX-001');
    assert.deepEqual(itemsFiledOnBranch(root, './docs', 'exec/EX-001', 'main'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('no own branch, the default branch itself, or a git error: an empty list', () => {
  const { root } = repo();
  try {
    assert.deepEqual(itemsFiledOnBranch(root, './docs', null, 'main'), []);
    assert.deepEqual(itemsFiledOnBranch(root, './docs', 'main', 'main'), []);
    assert.deepEqual(itemsFiledOnBranch(root, './docs', 'no-such-branch', 'main'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
