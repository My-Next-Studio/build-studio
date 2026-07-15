'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  createSupportRouter,
  composeTriagePrompt,
  deriveItemPrefix,
  prefixFromName,
} = require('./support');

// ─── fixtures ────────────────────────────────────────────────────────────────

function makeProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-test-'));
  const backlog = path.join(root, 'docs', 'backlog');
  fs.mkdirSync(backlog, { recursive: true });
  // Seed one item so the prefix derives to EX and nextItemId → EX-002.
  fs.writeFileSync(path.join(backlog, 'EX-001.md'),
    '---\nid: EX-001\ntitle: Seed item\ntype: Feature\nstatus: Backlog\ncreated: 2026-07-01\n---\n\nSeed.\n');
  fs.writeFileSync(path.join(root, 'docs', 'project-state.md'),
    '# Project State\n\n<!-- BACKLOG-START -->\n\n### Release 1\n\n- EX-001 — Seed item  [Feature · Backlog]\n\n<!-- BACKLOG-END -->\n');
  return root;
}
function cleanDir(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }

function makeApp(config, deps) {
  const app = express();
  // Match the intended real-server behaviour: a generous parser so the router's
  // own size check (not a transport-layer 413) governs oversized attachments.
  app.use(express.json({ limit: '50mb' }));
  app.use('/api', createSupportRouter(config, deps || {}));
  return app;
}

// Replicate server.js's exact middleware arrangement: a default (100kb) global
// json parser that SKIPS POST /api/support/reports, plus the router (whose create
// route carries its own 40mb parser). Used to prove the narrow-surface property —
// only the create route escapes the app-wide limit.
function makeServerLikeApp(config, deps) {
  const app = express();
  const defaultJsonParser = express.json(); // default 100kb, mirrors the real server
  app.use((req, res, next) =>
    (req.method === 'POST' && req.path === '/api/support/reports')
      ? next()
      : defaultJsonParser(req, res, next));
  app.use('/api', createSupportRouter(config, deps || {}));
  // Stand-in for "any other endpoint" — relies on the default parser.
  app.post('/api/echo', (req, res) => res.json({ ok: true }));
  return app;
}

async function req(app, method, url, body) {
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const { port } = server.address();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${url}`, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, body: json };
  } finally {
    server.close();
  }
}

// A stubbed oneshot that writes proposal.json synchronously (the id is carried
// in the label `support-triage-<id>`), so a subsequent status poll materializes.
function stubDeps(proposal) {
  return {
    runOneShotFn: ({ projectRoot, label }) => {
      const id = label.replace('support-triage-', '');
      const reportDir = path.join(projectRoot, '.build-studio', 'support', 'reports', id);
      fs.writeFileSync(path.join(reportDir, 'proposal.json'), JSON.stringify(proposal));
      return { runId: `run-${id}`, sessionName: `sess-${id}` };
    },
    getOneShotStatusFn: () => ({ state: 'complete' }),
  };
}

function reportsDir(root) {
  return path.join(root, '.build-studio', 'support', 'reports');
}

// ─── pure helpers ────────────────────────────────────────────────────────────

test('prefixFromName — multi-word → initials, single-word → first three letters', () => {
  assert.equal(prefixFromName('my-next-studio'), 'MNS');
  assert.equal(prefixFromName('build-studio'), 'BS');
  assert.equal(prefixFromName('fazon'), 'FAZ');
  assert.equal(prefixFromName('x'), 'XX'); // single-char padded up to a valid 2-char prefix
  assert.match(prefixFromName('x'), /^[A-Z]{2,5}$/);
});

test('deriveItemPrefix — dominant existing backlog prefix wins over the name', () => {
  const root = makeProject();
  try {
    // Name would derive to "TP" but the seeded EX-001 dominates.
    assert.equal(deriveItemPrefix(root, 'docs', { name: 'test project' }), 'EX');
  } finally { cleanDir(root); }
});

test('composeTriagePrompt — read-only, duplicate-first, proposal-file-only guardrails', () => {
  const p = composeTriagePrompt({
    reportId: 'RPT-001', reportText: 'it crashes', attachmentPaths: ['/x/a.png'],
    proposalFile: '/tmp/RPT-001/proposal.json',
  });
  assert.match(p, /\.claude\/commands\/support\.md/);
  assert.match(p, /READ-ONLY/);
  assert.match(p, /docs\/backlog\//);
  assert.match(p, /\/tmp\/RPT-001\/proposal\.json/);
  assert.match(p, /bug_prd_scale/);
  assert.match(p, /a\.png/);
});

// ─── create ──────────────────────────────────────────────────────────────────

test('POST /support/reports — writes RPT-001 dir + frontmatter, status new', async () => {
  const root = makeProject();
  try {
    const app = makeApp({ projectRoot: root, docs_path: 'docs', name: 'ex' });
    const r = await req(app, 'POST', '/api/support/reports', { text: 'the export button does nothing' });
    assert.equal(r.status, 201);
    assert.equal(r.body.report.id, 'RPT-001');
    assert.equal(r.body.report.status, 'new');
    const md = fs.readFileSync(path.join(reportsDir(root), 'RPT-001', 'report.md'), 'utf8');
    assert.match(md, /id: RPT-001/);
    assert.match(md, /status: new/);
    assert.match(md, /the export button does nothing/);
  } finally { cleanDir(root); }
});

test('POST /support/reports — empty text → 400', async () => {
  const root = makeProject();
  try {
    const app = makeApp({ projectRoot: root, docs_path: 'docs', name: 'ex' });
    const r = await req(app, 'POST', '/api/support/reports', { text: '   ' });
    assert.equal(r.status, 400);
  } finally { cleanDir(root); }
});

test('POST /support/reports — attachments over 25MB → 413', async () => {
  const root = makeProject();
  try {
    const app = makeApp({ projectRoot: root, docs_path: 'docs', name: 'ex' });
    const base64 = Buffer.alloc(26 * 1024 * 1024).toString('base64'); // 26MB decoded
    const r = await req(app, 'POST', '/api/support/reports', {
      text: 'huge log attached', attachments: [{ name: 'big.log', base64 }],
    });
    assert.equal(r.status, 413);
  } finally { cleanDir(root); }
});

test('POST /support/reports — attachment name is sanitized with basename', async () => {
  const root = makeProject();
  try {
    const app = makeApp({ projectRoot: root, docs_path: 'docs', name: 'ex' });
    const base64 = Buffer.from('hello').toString('base64');
    const r = await req(app, 'POST', '/api/support/reports', {
      text: 'see attachment', attachments: [{ name: '../../evil.txt', base64 }],
    });
    assert.equal(r.status, 201);
    const attDir = path.join(reportsDir(root), 'RPT-001', 'attachments');
    assert.deepEqual(fs.readdirSync(attDir), ['evil.txt']);
    // The traversal target must NOT have been written outside the report dir.
    assert.equal(fs.existsSync(path.join(root, '.build-studio', 'support', 'evil.txt')), false);
  } finally { cleanDir(root); }
});

// ─── list ────────────────────────────────────────────────────────────────────

test('GET /support/reports — lists newest first with excerpt + attachments', async () => {
  const root = makeProject();
  try {
    const app = makeApp({ projectRoot: root, docs_path: 'docs', name: 'ex' });
    await req(app, 'POST', '/api/support/reports', { text: 'first' });
    await req(app, 'POST', '/api/support/reports', { text: 'second' });
    const r = await req(app, 'GET', '/api/support/reports');
    assert.equal(r.status, 200);
    assert.equal(r.body.reports.length, 2);
    assert.equal(r.body.reports[0].id, 'RPT-002'); // newest first
    assert.match(r.body.reports[0].excerpt, /second/);
  } finally { cleanDir(root); }
});

// ─── triage: bug → auto-filed ────────────────────────────────────────────────

test('triage: bug verdict auto-files a backlog item (reported_via + Bugs marker)', async () => {
  const root = makeProject();
  try {
    const proposal = {
      verdict: 'bug', duplicate_of: null, title: 'Export button no-op',
      body: '## Symptom\nClicking Export does nothing.', role: 'Frontend Dev',
      severity: 'normal', findings: 'onClick handler is not wired.', reasoning: 'Clear localized defect.',
    };
    const app = makeApp({ projectRoot: root, docs_path: 'docs', name: 'ex' }, stubDeps(proposal));
    await req(app, 'POST', '/api/support/reports', { text: 'export button broken' });
    const t = await req(app, 'POST', '/api/support/reports/RPT-001/triage', {});
    assert.equal(t.status, 200);
    assert.equal(t.body.report.status, 'triaging');
    const s = await req(app, 'GET', '/api/support/reports/RPT-001/triage/status');
    assert.equal(s.status, 200);
    assert.equal(s.body.state, 'complete');
    assert.equal(s.body.report.status, 'filed');
    assert.equal(s.body.report.linked_item, 'EX-002');

    const itemMd = fs.readFileSync(path.join(root, 'docs', 'backlog', 'EX-002.md'), 'utf8');
    assert.match(itemMd, /type: Bug/);
    assert.match(itemMd, /reported_via: RPT-001/);
    assert.match(itemMd, /status: Backlog/);
    const state = fs.readFileSync(path.join(root, 'docs', 'project-state.md'), 'utf8');
    assert.match(state, /### Bugs — fix next/);
    assert.match(state, /EX-002/);
  } finally { cleanDir(root); }
});

test('triage: unknown verdict reverts to new (no proposed dead-end)', async () => {
  const root = makeProject();
  try {
    const proposal = { verdict: 'wontfix', title: 'x', body: 'y' }; // not a valid verdict
    const app = makeApp({ projectRoot: root, docs_path: 'docs', name: 'ex' }, stubDeps(proposal));
    await req(app, 'POST', '/api/support/reports', { text: 'something odd' });
    await req(app, 'POST', '/api/support/reports/RPT-001/triage', {});
    const s = await req(app, 'GET', '/api/support/reports/RPT-001/triage/status');
    // Back to `new` with a note — NOT parked in `proposed`, where both the
    // decision endpoint and re-triage would 409 (unrecoverable).
    assert.equal(s.body.report.status, 'new');
    const md = fs.readFileSync(path.join(reportsDir(root), 'RPT-001', 'report.md'), 'utf8');
    assert.match(md, /invalid proposal\.json/);
    // And re-triage is possible again.
    const t2 = await req(app, 'POST', '/api/support/reports/RPT-001/triage', {});
    assert.equal(t2.status, 200);
  } finally { cleanDir(root); }
});

// ─── triage: feature → stays proposed ─────────────────────────────────────────

test('triage: feature verdict parks in proposed until a decision', async () => {
  const root = makeProject();
  try {
    const proposal = {
      verdict: 'feature', duplicate_of: null, title: 'Add dark mode',
      body: '## Request\nSupport a dark theme.', role: null, severity: 'normal',
      findings: 'No theming layer exists.', reasoning: 'Genuine new capability.',
    };
    const app = makeApp({ projectRoot: root, docs_path: 'docs', name: 'ex' }, stubDeps(proposal));
    await req(app, 'POST', '/api/support/reports', { text: 'please add dark mode' });
    await req(app, 'POST', '/api/support/reports/RPT-001/triage', {});
    const s = await req(app, 'GET', '/api/support/reports/RPT-001/triage/status');
    assert.equal(s.body.report.status, 'proposed');
    assert.equal(s.body.report.verdict, 'feature');
    // No new backlog item filed yet.
    assert.equal(fs.existsSync(path.join(root, 'docs', 'backlog', 'EX-002.md')), false);
  } finally { cleanDir(root); }
});

// ─── decision ────────────────────────────────────────────────────────────────

test('decision accept (feature) → materializes item under a release heading, status filed', async () => {
  const root = makeProject();
  try {
    const proposal = {
      verdict: 'feature', duplicate_of: null, title: 'Add dark mode',
      body: '## Request\nSupport a dark theme.', role: 'Frontend Dev', severity: 'normal',
      findings: 'No theming layer.', reasoning: 'New capability.',
    };
    const app = makeApp({ projectRoot: root, docs_path: 'docs', name: 'ex' }, stubDeps(proposal));
    await req(app, 'POST', '/api/support/reports', { text: 'dark mode please' });
    await req(app, 'POST', '/api/support/reports/RPT-001/triage', {});
    await req(app, 'GET', '/api/support/reports/RPT-001/triage/status');
    const d = await req(app, 'POST', '/api/support/reports/RPT-001/decision', { accept: true });
    assert.equal(d.status, 200);
    assert.equal(d.body.report.status, 'filed');
    assert.equal(d.body.report.linked_item, 'EX-002');
    const itemMd = fs.readFileSync(path.join(root, 'docs', 'backlog', 'EX-002.md'), 'utf8');
    assert.match(itemMd, /type: Feature/);
    assert.match(itemMd, /reported_via: RPT-001/);
    // Filed under a non-Bugs release heading (the seeded "Release 1").
    const state = fs.readFileSync(path.join(root, 'docs', 'project-state.md'), 'utf8');
    assert.match(state, /### Release 1/);
    assert.match(state, /EX-002/);
  } finally { cleanDir(root); }
});

test('decision accept (invalid) → status rejected, no item filed', async () => {
  const root = makeProject();
  try {
    const proposal = {
      verdict: 'invalid', duplicate_of: null, title: 'n/a', body: '', role: null,
      severity: 'normal', findings: 'Cannot reproduce.', reasoning: 'Not a defect.',
    };
    const app = makeApp({ projectRoot: root, docs_path: 'docs', name: 'ex' }, stubDeps(proposal));
    await req(app, 'POST', '/api/support/reports', { text: 'something weird' });
    await req(app, 'POST', '/api/support/reports/RPT-001/triage', {});
    await req(app, 'GET', '/api/support/reports/RPT-001/triage/status');
    const d = await req(app, 'POST', '/api/support/reports/RPT-001/decision', { accept: true });
    assert.equal(d.body.report.status, 'rejected');
    assert.equal(fs.existsSync(path.join(root, 'docs', 'backlog', 'EX-002.md')), false);
  } finally { cleanDir(root); }
});

test('decision reject (accept:false) → returns report to new with note', async () => {
  const root = makeProject();
  try {
    const proposal = {
      verdict: 'feature', duplicate_of: null, title: 'Add dark mode', body: 'x',
      role: null, severity: 'normal', findings: 'y', reasoning: 'z',
    };
    const app = makeApp({ projectRoot: root, docs_path: 'docs', name: 'ex' }, stubDeps(proposal));
    await req(app, 'POST', '/api/support/reports', { text: 'dark mode' });
    await req(app, 'POST', '/api/support/reports/RPT-001/triage', {});
    await req(app, 'GET', '/api/support/reports/RPT-001/triage/status');
    const d = await req(app, 'POST', '/api/support/reports/RPT-001/decision',
      { accept: false, note: 'not now' });
    assert.equal(d.status, 200);
    assert.equal(d.body.report.status, 'new');
    const md = fs.readFileSync(path.join(reportsDir(root), 'RPT-001', 'report.md'), 'utf8');
    assert.match(md, /not now/);
  } finally { cleanDir(root); }
});

// ─── path traversal guard ─────────────────────────────────────────────────────

test('path-traversal on :id → 400', async () => {
  const root = makeProject();
  try {
    const app = makeApp({ projectRoot: root, docs_path: 'docs', name: 'ex' });
    const encoded = 'RPT-001%2F..%2F..%2F..%2Fetc'; // decodes to a traversal-shaped id
    const s = await req(app, 'GET', `/api/support/reports/${encoded}/triage/status`);
    assert.equal(s.status, 400);
    const d = await req(app, 'POST', `/api/support/reports/${encoded}/decision`, { accept: true });
    assert.equal(d.status, 400);
  } finally { cleanDir(root); }
});

// ─── narrow-surface property: only the create route escapes the 100kb cap ─────

test('middleware ordering — create route bypasses the 100kb cap; every other route keeps it', async () => {
  const root = makeProject();
  try {
    const app = makeServerLikeApp({ projectRoot: root, docs_path: 'docs', name: 'ex' });
    // ~180KB raw attachment → ~240KB base64 body, well over the default 100kb cap.
    const base64 = Buffer.alloc(180 * 1024).toString('base64');

    // (a) The create route's own 40mb parser governs — a large attachment is accepted.
    const create = await req(app, 'POST', '/api/support/reports', {
      text: 'big screenshot attached', attachments: [{ name: 'shot.png', base64 }],
    });
    assert.equal(create.status, 201);

    // (b) The SAME oversized body on a different endpoint still trips the default
    //     100kb cap — the exemption is scoped to exactly POST /support/reports.
    const other = await req(app, 'POST', '/api/echo', { blob: base64 });
    assert.equal(other.status, 413);

    // (c) A different SUPPORT path (decision) is not exempt either.
    const decision = await req(app, 'POST', '/api/support/reports/RPT-001/decision', { accept: true, note: base64 });
    assert.equal(decision.status, 413);
  } finally { cleanDir(root); }
});
