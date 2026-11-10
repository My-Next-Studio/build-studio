'use strict';

// Is the stack decision (ADR-001) still Pending? (lib/adr-status.js)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stackDecision } = require('./adr-status');

function docsWith(adrs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bs-adr-'));
  const docs = path.join(root, 'docs');
  fs.mkdirSync(path.join(docs, 'adrs'), { recursive: true });
  for (const [name, text] of Object.entries(adrs)) fs.writeFileSync(path.join(docs, 'adrs', name), text);
  return { root, docs };
}

test('no ADR-001: nothing decided, nothing pending', () => {
  const { root, docs } = docsWith({ 'ADR-002-ci.md': '**Status:** Accepted\n' });
  try { assert.deepEqual(stackDecision(docs), { exists: false }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Pending in the usual markdown shapes', () => {
  for (const line of [
    'Status: Pending',
    '**Status:** Pending — waits for the auth and backend investigation',
    '- **Status**: pending',
    '| Status | Pending |',
    '> Status: Pending',
  ]) {
    const { root, docs } = docsWith({ 'ADR-001-tech-stack.md': `# ADR-001: Tech stack\n\n${line}\n\n## Candidates\n` });
    try {
      const s = stackDecision(docs);
      assert.equal(s.exists, true, line);
      assert.equal(s.pending, true, line);
      assert.equal(s.file, path.join('docs', 'adrs', 'ADR-001-tech-stack.md'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('Accepted, Proposed or no status line is not pending', () => {
  for (const body of ['**Status:** Accepted\n', 'Status: Proposed\n', 'We use Postgres.\n']) {
    const { root, docs } = docsWith({ 'ADR-001-stack.md': `# ADR-001\n\n${body}` });
    try { assert.equal(stackDecision(docs).pending, false, body); } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('reads the status near the top, not a "status: pending" deep in the body', () => {
  const filler = Array.from({ length: 60 }, () => 'text').join('\n');
  const { root, docs } = docsWith({ 'ADR-001-stack.md': `# ADR-001\n\n**Status:** Accepted\n\n${filler}\n\n| Item | Status |\n| CDN | pending |\n` });
  try {
    const s = stackDecision(docs);
    assert.equal(s.pending, false);
    assert.equal(s.status, 'Accepted');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('ADR-010 and ADR-011 are not ADR-001', () => {
  const { root, docs } = docsWith({ 'ADR-010-x.md': 'Status: Pending\n', 'ADR-011-y.md': 'Status: Pending\n' });
  try { assert.deepEqual(stackDecision(docs), { exists: false }); } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
