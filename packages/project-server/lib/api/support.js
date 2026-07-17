/**
 * Support API — owner-reported issue triage.
 *
 * Flow: the owner files a free-text report (+ optional attachments); a
 * propose-only oneshot "Support triage" agent classifies it into one of five
 * verdicts and writes a structured proposal; approved outcomes materialize as
 * backlog items — written by THIS SERVER, never by the agent.
 *
 * Storage (runtime state, deliberately gitignored — see the exclude pattern for
 * `.build-studio/support/`): one directory per report under
 *   <projectRoot>/.build-studio/support/reports/RPT-<NNN>/
 *     report.md            — YAML frontmatter (id, created, status, decision,
 *                            linked_item) + the owner's free text as the body.
 *     attachments/<name>   — uploaded files (names sanitized with path.basename).
 *     proposal.json        — the triage agent's structured proposal.
 *
 * Report status lifecycle:
 *   new → triaging → proposed → (filed | rejected | dismissed)
 * A `bug` verdict skips `proposed` and is filed immediately (no approval needed);
 * every other verdict waits in `proposed` for an owner decision.
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const {
  readItem, writeItem, nextItemId, isValidId,
  backlogDir, projectStatePath, parseBacklogSection, writeBacklogSection,
} = require('../backlog');
const { assertInside } = require('../path-guard');
const { scopedCommit } = require('../scoped-commit');
const {
  runOneShot: defaultRunOneShot,
  getOneShotStatus: defaultGetOneShotStatus,
} = require('../oneshot');

// Triage is a single-pass read-only investigation — bound it like the CI-fix
// investigation so a wedged agent can't hold the per-project oneshot slot forever.
const SUPPORT_TRIAGE_MAX_DURATION_MS = 15 * 60 * 1000;

// Total decoded attachment payload cap. base64 in the JSON body inflates by ~33%,
// so the route-level json parser is mounted at 40mb to leave headroom.
const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024;

// Backlog section headings the server files new items under.
const BUGS_HEADING = 'Bugs — fix next';
const UNSCHEDULED_HEADING = 'Unscheduled';

const RPT_ID_RE = /^RPT-\d{3,}$/;
function isValidReportId(id) { return typeof id === 'string' && RPT_ID_RE.test(id); }

const VERDICTS = new Set(['invalid', 'duplicate', 'bug', 'bug_prd_scale', 'feature', 'task']);

// ─── report.md parse / serialize ─────────────────────────────────────────────

function parseReport(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { body: raw };
  const fm = yaml.load(m[1]) || {};
  return { ...fm, body: m[2].replace(/^\n+/, '') };
}

function serializeReport(report) {
  const { body, ...fm } = report;
  const ordered = {};
  for (const k of ['id', 'created', 'status', 'decision', 'linked_item']) {
    if (k in fm) ordered[k] = fm[k];
  }
  for (const k of Object.keys(fm)) if (!(k in ordered)) ordered[k] = fm[k];
  const fmText = yaml.dump(ordered, { lineWidth: 100, noRefs: true });
  return `---\n${fmText}---\n\n${(body || '').replace(/^\n+/, '')}${body && !body.endsWith('\n') ? '\n' : ''}`;
}

function appendNote(body, note) {
  return `${(body || '').replace(/\s+$/, '')}\n\n> [${new Date().toISOString()}] ${note}\n`;
}

// ─── item-prefix derivation ──────────────────────────────────────────────────

/**
 * The project's backlog id prefix (FAZ, DR, VK, …). Prefer the dominant prefix
 * among existing backlog item files — that's the ground truth for an established
 * project. Fall back to initials of the project name for a brand-new project
 * with no items yet.
 */
function deriveItemPrefix(projectRoot, docsPath, config) {
  const dir = backlogDir(projectRoot, docsPath);
  const counts = new Map();
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^([A-Z]{2,5})-\d{1,5}\.md$/);
      if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
  }
  if (counts.size > 0) {
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }
  return prefixFromName((config && config.name) || path.basename(projectRoot));
}

function prefixFromName(name) {
  const words = String(name || '').split(/[^A-Za-z0-9]+/).filter(Boolean);
  let p;
  if (words.length >= 2) p = words.map(w => w[0]).join('');
  else if (words.length === 1) p = words[0].slice(0, 3);
  else p = 'ITM';
  p = p.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 5);
  if (p.length < 2) p = (p + 'XX').slice(0, 2);
  return p;
}

// ─── triage prompt ───────────────────────────────────────────────────────────

/** Compose the single-pass, propose-only prompt for the Support triage agent. */
function composeTriagePrompt({ reportId, reportText, attachmentPaths = [], proposalFile }) {
  return [
    '== Support triage ==',
    'You are the Support triage agent. Use the /support skill; read your role definition at'
      + ' .claude/commands/support.md before you begin.',
    '',
    `Report ${reportId} — the project owner reported this issue:`,
    '```',
    reportText || '(no text provided)',
    '```',
    attachmentPaths.length
      ? `Attachments (read if relevant):\n${attachmentPaths.map(p => `- ${p}`).join('\n')}`
      : 'No attachments.',
    '',
    'Investigate READ-ONLY:',
    '- Do NOT modify any repo file, run git, or write anywhere except the single proposal file below.',
    '- FIRST check docs/backlog/ for an existing item with the same SYMPTOM (grep titles + bodies) —'
      + ' if one matches, this is a duplicate. Match on symptom, not wording.',
    '- Then read the relevant code (read-only) to localize the fault and gather evidence. In your'
      + ' findings, separate what you OBSERVED from what you INFER.',
    '',
    `Write your proposal — and NOTHING else — as JSON to ${proposalFile}:`,
    '{',
    '  "verdict": "invalid" | "duplicate" | "bug" | "bug_prd_scale" | "feature" | "task",',
    '  "duplicate_of": "XX-NNN" | null,',
    '  "title": "<concise backlog item title>",',
    '  "body": "<markdown body for the item: symptom, repro, expected vs actual, agent findings>",',
    '  "role": "<suggested builder role, or null>",',
    '  "severity": "critical" | "normal",',
    '  "findings": "<what your investigation actually found>",',
    '  "reasoning": "<one paragraph justifying the verdict>"',
    '}',
    '',
    'Verdict rules:',
    '- invalid = not reproducible / not this product / user error. Be conservative — when unsure, prefer bug.',
    '- duplicate = same symptom as an existing backlog item (set duplicate_of to its id).',
    '- bug = a real defect with a localized fix.',
    '- bug_prd_scale = a real defect whose fix clearly spans multiple surfaces, needs design decisions,'
      + ' or touches schema/architecture. A bug is NEVER reclassified as a feature just for being big.',
    '- feature / task = a genuine new request (not a defect).',
    '',
    'Propose only. The dashboard files the backlog item after the owner decides. Never write to docs/,'
      + ' never touch git — your ONLY output is the proposal JSON file.',
  ].join('\n');
}

// ─── router ──────────────────────────────────────────────────────────────────

function createSupportRouter(config, {
  runOneShotFn = defaultRunOneShot,
  getOneShotStatusFn = defaultGetOneShotStatus,
} = {}) {
  const router = express.Router();
  const projectRoot = config.projectRoot;
  const docsPath = config.docs_path || './docs';

  // reportId → oneshot runId for an in-flight triage. Lost on restart, which the
  // status endpoint tolerates by falling back to on-disk proposal.json presence.
  const triageRunByReport = new Map();

  function reportsDir() {
    return path.join(projectRoot, '.build-studio', 'support', 'reports');
  }

  // Resolve <reportsDir>/<id>, guarding against traversal via a crafted id.
  function resolveReportDir(id) {
    const base = reportsDir();
    return assertInside(id, base); // throws FORBIDDEN if id escapes base
  }

  function readReport(reportDir) {
    return parseReport(fs.readFileSync(path.join(reportDir, 'report.md'), 'utf8'));
  }
  function writeReport(reportDir, report) {
    fs.writeFileSync(path.join(reportDir, 'report.md'), serializeReport(report));
  }

  function nextReportId() {
    const dir = reportsDir();
    let max = 0;
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^RPT-(\d{3,})$/);
        if (m) max = Math.max(max, parseInt(m[1], 10));
      }
    }
    return `RPT-${String(max + 1).padStart(3, '0')}`;
  }

  function attachmentNames(reportDir) {
    const attDir = path.join(reportDir, 'attachments');
    if (!fs.existsSync(attDir)) return [];
    return fs.readdirSync(attDir).filter(Boolean);
  }

  // Build the API-facing summary of a report (frontmatter + excerpt + attachment
  // names + proposal verdict + linked backlog item's live status).
  function summarizeReport(id) {
    const reportDir = path.join(reportsDir(), id);
    const report = readReport(reportDir);
    const proposal = report.decision || null;
    let linkedItemStatus = null;
    if (report.linked_item && isValidId(report.linked_item)) {
      try {
        const it = readItem(projectRoot, docsPath, report.linked_item);
        if (it) linkedItemStatus = it.status || null;
      } catch { /* linked item unreadable — leave null */ }
    }
    return {
      id: report.id,
      created: report.created || null,
      status: report.status || 'new',
      excerpt: (report.body || '').slice(0, 280),
      attachments: attachmentNames(reportDir),
      verdict: proposal ? proposal.verdict : null,
      proposal,
      linked_item: report.linked_item || null,
      linkedItemStatus,
    };
  }

  // ─── materialization (server-written; the agent never writes items) ──────────

  /**
   * Add `<newId>` as a marker line to project-state.md's BACKLOG section.
   * `bucket === 'bugs'` files it under the "Bugs — fix next" heading (created
   * right after BACKLOG-START if absent); otherwise it goes under the first
   * existing (non-Bugs) release heading, or a new "Unscheduled" heading.
   */
  function addMarkerLine(newId, bucket) {
    const statePath = projectStatePath(projectRoot, docsPath);
    const groups = fs.existsSync(statePath)
      ? parseBacklogSection(fs.readFileSync(statePath, 'utf8'))
      : [];
    if (bucket === 'bugs') {
      let g = groups.find(x => x.release === BUGS_HEADING);
      if (!g) { g = { release: BUGS_HEADING, items: [] }; groups.unshift(g); }
      g.items.push(newId);
    } else {
      let g = groups.find(x => x.release !== BUGS_HEADING);
      if (!g) { g = { release: UNSCHEDULED_HEADING, items: [] }; groups.push(g); }
      g.items.push(newId);
    }
    writeBacklogSection(projectRoot, docsPath, groups);
  }

  // Create the backlog item file + its marker line from an accepted proposal.
  function materializeItem(report, proposal) {
    const prefix = deriveItemPrefix(projectRoot, docsPath, config);
    const newId = nextItemId(projectRoot, docsPath, prefix);
    const isBug = proposal.verdict === 'bug' || proposal.verdict === 'bug_prd_scale';
    const type = isBug ? 'Bug' : (proposal.verdict === 'feature' ? 'Feature' : 'Task');

    let body = String(proposal.body || '').trim();
    if (proposal.verdict === 'bug_prd_scale') {
      body += '\n\n## Routing\n\nPRD-scale — the fix spans multiple surfaces or needs design decisions.'
        + ' Draft a PRD before implementing.';
    }
    body += `\n\n_Filed from support report ${report.id}._`;

    const item = {
      id: newId,
      title: String(proposal.title || '(untitled)').trim(),
      type,
      status: 'Backlog',
      created: new Date().toISOString().slice(0, 10),
      reported_via: report.id,
      body,
    };
    if (proposal.severity === 'critical' || proposal.severity === 'normal') item.severity = proposal.severity;
    if (proposal.role) item.role = String(proposal.role);

    writeItem(projectRoot, docsPath, item);
    addMarkerLine(newId, isBug ? 'bugs' : 'other');
    return newId;
  }

  /**
   * Auto-commit a filed item + its project-state marker line so the owner
   * never has to commit filings manually (owner decision 2026-07-17,
   * `support.auto_commit`, default on). Commits land on WHATEVER branch is
   * checked out — during an execution run that is the feature branch, which
   * merges to main with the PRD; the report itself lives branch-independent
   * in .build-studio/support/. The pathspec-scoped commit never sweeps
   * concurrent agent work, and a failed commit NEVER fails the filing — the
   * files stay in the tree and the report carries a visible note instead.
   */
  async function autoCommitFiling(report, newId) {
    const enabled = !(config.support && config.support.auto_commit === false);
    if (!enabled || !newId || !fs.existsSync(path.join(projectRoot, '.git'))) return;
    const paths = [
      path.relative(projectRoot, path.join(projectRoot, docsPath || 'docs', 'backlog', `${newId}.md`)),
      path.relative(projectRoot, projectStatePath(projectRoot, docsPath)),
    ];
    const result = await scopedCommit(projectRoot, paths, `chore(support): file ${newId} (from ${report.id})`);
    if (result.committed) {
      report.filed_commit = result.sha || 'concurrent';
    } else {
      report.body = appendNote(report.body, `Filed as ${newId} but NOT committed — ${result.reason}. Commit docs/backlog/${newId}.md + project-state.md manually.`);
    }
  }

  // Apply a completed triage run's proposal.json to the report. `bug` verdicts
  // are filed immediately; everything else parks in `proposed` for a decision.
  async function applyProposal(id) {
    const reportDir = path.join(reportsDir(), id);
    const report = readReport(reportDir);
    let proposal = null;
    try {
      proposal = JSON.parse(fs.readFileSync(path.join(reportDir, 'proposal.json'), 'utf8'));
    } catch { /* handled below */ }
    // An unknown verdict would otherwise park the report in `proposed`, where the
    // decision endpoint 409s (no valid proposal) and re-triage 409s (not `new`) —
    // a dead-end. Treat it like an unreadable proposal: back to `new`, re-run.
    if (!proposal || typeof proposal !== 'object' || !VERDICTS.has(proposal.verdict)) {
      report.status = 'new';
      report.body = appendNote(report.body, 'Triage produced an invalid proposal.json — re-run triage.');
      writeReport(reportDir, report);
      triageRunByReport.delete(id);
      return summarizeReport(id);
    }
    report.decision = proposal;
    if (proposal.verdict === 'bug') {
      try {
        report.linked_item = materializeItem(report, proposal);
        report.status = 'filed';
        await autoCommitFiling(report, report.linked_item);
      } catch (e) {
        // Filing failed (e.g. no project-state.md markers) — surface the proposal
        // so the owner can act rather than losing the triage.
        report.status = 'proposed';
        report.body = appendNote(report.body, `Auto-file failed: ${e.message}`);
      }
    } else {
      report.status = 'proposed';
    }
    writeReport(reportDir, report);
    triageRunByReport.delete(id);
    return summarizeReport(id);
  }

  // ─── POST /support/reports — create a report (route-level 40mb json parser) ───
  router.post('/support/reports', express.json({ limit: '40mb' }), (req, res) => {
    const body = req.body || {};
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return res.status(400).json({ error: 'text is required' });

    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    const decoded = [];
    let total = 0;
    for (const a of attachments) {
      if (!a || typeof a.name !== 'string' || typeof a.base64 !== 'string') {
        return res.status(400).json({ error: 'each attachment must be { name, base64 }' });
      }
      const buf = Buffer.from(a.base64, 'base64');
      total += buf.length;
      decoded.push({ name: path.basename(a.name), buf });
    }
    if (total > MAX_ATTACHMENTS_BYTES) {
      return res.status(413).json({ error: `attachments exceed the ${MAX_ATTACHMENTS_BYTES}-byte limit` });
    }

    const dir = reportsDir();
    fs.mkdirSync(dir, { recursive: true });
    const id = nextReportId();
    const reportDir = path.join(dir, id);
    fs.mkdirSync(reportDir, { recursive: true });
    writeReport(reportDir, {
      id,
      created: new Date().toISOString(),
      status: 'new',
      decision: null,
      linked_item: null,
      body: text,
    });

    if (decoded.length) {
      const attDir = path.join(reportDir, 'attachments');
      fs.mkdirSync(attDir, { recursive: true });
      for (const d of decoded) {
        if (!d.name || d.name === '.' || d.name === '..') continue;
        fs.writeFileSync(assertInside(d.name, attDir), d.buf);
      }
    }

    res.status(201).json({ report: summarizeReport(id) });
  });

  // ─── GET /support/reports — list, newest first ───────────────────────────────
  router.get('/support/reports', (req, res) => {
    try {
      const dir = reportsDir();
      if (!fs.existsSync(dir)) return res.json({ reports: [] });
      const ids = fs.readdirSync(dir)
        .filter(f => isValidReportId(f) && fs.existsSync(path.join(dir, f, 'report.md')))
        .sort((a, b) => parseInt(b.slice(4), 10) - parseInt(a.slice(4), 10));
      res.json({ reports: ids.map(summarizeReport) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /support/reports/:id/triage — launch the propose-only triage agent ──
  router.post('/support/reports/:id/triage', (req, res) => {
    const id = req.params.id;
    if (!isValidReportId(id)) return res.status(400).json({ error: 'invalid report id' });
    let reportDir;
    try { reportDir = resolveReportDir(id); }
    catch { return res.status(400).json({ error: 'invalid report id' }); }
    if (!fs.existsSync(path.join(reportDir, 'report.md'))) {
      return res.status(404).json({ error: 'report not found' });
    }

    const report = readReport(reportDir);
    if (report.status === 'triaging') return res.status(409).json({ error: 'triage already in progress' });
    if (report.status !== 'new') {
      return res.status(409).json({ error: `cannot triage a report in status "${report.status}"` });
    }

    const attDir = path.join(reportDir, 'attachments');
    const attachmentPaths = fs.existsSync(attDir)
      ? fs.readdirSync(attDir).map(f => path.join(attDir, f))
      : [];

    const proposalFile = path.join(reportDir, 'proposal.json');
    try { fs.unlinkSync(proposalFile); } catch { /* no stale proposal */ }

    const prompt = composeTriagePrompt({ reportId: id, reportText: report.body, attachmentPaths, proposalFile });
    let result;
    try {
      result = runOneShotFn({
        projectRoot,
        prompt,
        label: `support-triage-${id}`,
        maxDurationMs: SUPPORT_TRIAGE_MAX_DURATION_MS,
        agentDefaults: config.agent_defaults,
      });
    } catch (e) {
      if (e.code === 'CONFLICT') return res.status(409).json({ error: e.message });
      return res.status(500).json({ error: e.message });
    }

    report.status = 'triaging';
    report.decision = null;
    writeReport(reportDir, report);
    triageRunByReport.set(id, result.runId);
    res.json({ runId: result.runId, sessionName: result.sessionName, report: summarizeReport(id) });
  });

  // ─── GET /support/reports/:id/triage/status — poll the triage run ────────────
  router.get('/support/reports/:id/triage/status', async (req, res) => {
    const id = req.params.id;
    if (!isValidReportId(id)) return res.status(400).json({ error: 'invalid report id' });
    let reportDir;
    try { reportDir = resolveReportDir(id); }
    catch { return res.status(400).json({ error: 'invalid report id' }); }
    if (!fs.existsSync(path.join(reportDir, 'report.md'))) {
      return res.status(404).json({ error: 'report not found' });
    }

    const report = readReport(reportDir);

    // Terminal / non-triaging states — nothing to poll, just echo current state.
    if (report.status !== 'triaging') {
      const terminalComplete = report.status === 'proposed' || report.status === 'filed';
      return res.json({ state: terminalComplete ? 'complete' : report.status, report: summarizeReport(id) });
    }

    const proposalExists = fs.existsSync(path.join(reportDir, 'proposal.json'));
    if (proposalExists) {
      return res.json({ state: 'complete', report: await applyProposal(id) });
    }

    const runId = triageRunByReport.get(id);
    const runStatus = runId ? getOneShotStatusFn(runId) : null;

    if (runStatus && runStatus.state === 'running') {
      return res.json({ state: 'running', report: summarizeReport(id) });
    }

    if (!runStatus) {
      // Run unknown (e.g. server restart) and no proposal on disk — revert to
      // `new` so the owner can re-trigger triage.
      report.status = 'new';
      writeReport(reportDir, report);
      return res.json({ state: 'idle', report: summarizeReport(id) });
    }

    // Run finished/errored without writing a proposal — treat as a failed triage.
    report.status = 'new';
    report.body = appendNote(report.body, `Triage did not complete (${runStatus.state}) — re-run triage.`);
    writeReport(reportDir, report);
    triageRunByReport.delete(id);
    res.json({ state: runStatus.state, error: runStatus.stderr || runStatus.state, report: summarizeReport(id) });
  });

  // ─── POST /support/reports/:id/decision — accept/reject a proposed report ─────
  router.post('/support/reports/:id/decision', async (req, res) => {
    const id = req.params.id;
    if (!isValidReportId(id)) return res.status(400).json({ error: 'invalid report id' });
    let reportDir;
    try { reportDir = resolveReportDir(id); }
    catch { return res.status(400).json({ error: 'invalid report id' }); }
    if (!fs.existsSync(path.join(reportDir, 'report.md'))) {
      return res.status(404).json({ error: 'report not found' });
    }

    const body = req.body || {};
    if (typeof body.accept !== 'boolean') {
      return res.status(400).json({ error: 'body.accept (boolean) is required' });
    }
    const note = typeof body.note === 'string' ? body.note.trim() : '';

    const report = readReport(reportDir);
    if (report.status !== 'proposed') {
      return res.status(409).json({ error: `report is not awaiting a decision (status "${report.status}")` });
    }
    const proposal = report.decision;
    if (!proposal || !VERDICTS.has(proposal.verdict)) {
      return res.status(409).json({ error: 'report has no valid proposal to decide on' });
    }
    if (proposal.verdict === 'bug') {
      return res.status(409).json({ error: 'bug verdicts are filed automatically — no decision needed' });
    }

    // Reject → back to `new` with the note appended, so the owner can edit or re-triage.
    if (!body.accept) {
      report.status = 'new';
      report.decision = null;
      report.body = appendNote(report.body, `Proposal rejected${note ? `: ${note}` : ''}. Re-triage or edit the report.`);
      writeReport(reportDir, report);
      return res.json({ report: summarizeReport(id) });
    }

    // Accept.
    try {
      if (proposal.verdict === 'duplicate') {
        report.status = 'dismissed';
        report.linked_item = isValidId(proposal.duplicate_of) ? proposal.duplicate_of : null;
        if (note) report.body = appendNote(report.body, `Dismissed as duplicate: ${note}`);
      } else if (proposal.verdict === 'invalid') {
        report.status = 'rejected';
        if (note) report.body = appendNote(report.body, `Marked invalid: ${note}`);
      } else {
        // feature | task | bug_prd_scale → file a backlog item.
        report.linked_item = materializeItem(report, proposal);
        report.status = 'filed';
        if (note) report.body = appendNote(report.body, `Filed: ${note}`);
        await autoCommitFiling(report, report.linked_item);
      }
    } catch (e) {
      return res.status(500).json({ error: `Could not apply decision: ${e.message}` });
    }
    writeReport(reportDir, report);
    res.json({ report: summarizeReport(id) });
  });

  return router;
}

module.exports = {
  createSupportRouter,
  composeTriagePrompt,
  deriveItemPrefix,
  prefixFromName,
  parseReport,
  serializeReport,
};
