const express = require('express');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { derivePrdPhase } = require('../prd-phase');

// ─── Active-PRD + Backlog parsers (used by /status/prd-phase) ───────────────

/**
 * Parse the `## Active PRD` section of project-state.md into a structured PRD ref.
 * Tolerates both "[Title](path) — context" and bare "PRD-NNN: Title" lines.
 * Returns { id, title, path } or null when no active PRD is declared.
 *
 * If the Active PRD line lacks a markdown link, `path` is recovered by scanning
 * `<projectRoot>/docs/prds/` for a file whose basename starts with the PRD id —
 * keeps phase derivation working even when the project-state line is bold-text-only.
 */
function parseActivePrd(content, projectRoot) {
  const m = content.match(/^##\s+Active\s+PRD\s*\n+([^\n]+)/m);
  if (!m) return null;
  const line = m[1].trim();
  const linkMatch = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
  let title = null;
  let pathRel = null;
  if (linkMatch) { title = linkMatch[1].trim(); pathRel = linkMatch[2].trim(); }
  else { title = line; }
  const idMatch = (line.match(/PRD-[A-Za-z0-9]+/) || [])[0] || null;
  if (!idMatch) return null;
  // If no path was extracted from a markdown link, scan docs/prds/ for a file
  // whose basename starts with the PRD id (e.g. PRD-005e-closures-by-hour.md).
  if (!pathRel && projectRoot) {
    try {
      const prdsDir = path.join(projectRoot, 'docs', 'prds');
      const f = fs.readdirSync(prdsDir).find((n) => {
        if (!n.endsWith('.md')) return false;
        // Match either exact-id-prefix (PRD-5 doesn't match PRD-5e), or
        // id followed by - / . / end-of-name.
        const m2 = n.match(/^(PRD-[A-Za-z0-9]+)(?:[-.]|$)/);
        return m2 && m2[1].toUpperCase() === idMatch.toUpperCase();
      });
      if (f) pathRel = `docs/prds/${f}`;
    } catch {}
  }
  return { id: idMatch, title, path: pathRel };
}

/**
 * Parse a single Backlog row's status by PRD id. Recognized markers:
 *   "Status: Done (YYYY-MM-DD)"        → done
 *   "Status: Closed (YYYY-MM-DD)"      → done   (back-compat — old marker)
 *   "Status: Deferred (YYYY-MM-DD) — reason was: <prevPhase>"  → deferred
 *   anything else                       → active (default)
 * Returns { status, deferredAt?, doneAt?, reason?, previousPhase?, previousPhaseAt? }.
 */
function parseBacklogRow(content, prdId) {
  if (!prdId) return { status: 'active' };
  const start = content.indexOf('\n## Backlog\n');
  if (start === -1) return { status: 'active' };
  const end = content.indexOf('\n## ', start + 12);
  const section = end === -1 ? content.slice(start) : content.slice(start, end);
  const lines = section.split('\n');
  // Prefer rows where the PRD id appears in a status marker — `(Active|Done|Closed|Deferred) (<prdId>)`
  // or in a `Status: …` segment written by setBacklogRowStatus. Falls back to any row mentioning
  // the id, but only if no other row claims it as a primary marker.
  const idEsc = prdId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const markerRe = new RegExp(`\\b(?:Active|Done|Closed|Deferred)\\s*\\(${idEsc}\\b`, 'i');
  const statusRe = new RegExp(`—\\s*Status:[^|]*${idEsc}`, 'i');
  let rowMatch =
    lines.find((l) => markerRe.test(l)) ||
    lines.find((l) => statusRe.test(l)) ||
    lines.find((l) => l.includes(prdId));
  if (!rowMatch) return { status: 'active' };
  const rowText = rowMatch.replace(/—\s*Status:\s*/i, '— ');
  const done = rowText.match(/(?:Done|Closed)(?:\s*\((\d{4}-\d{2}-\d{2})\))?/i);
  if (done) return { status: 'done', doneAt: done[1] ? `${done[1]}T00:00:00.000Z` : null };
  const deferred = rowText.match(/Deferred(?:\s*\((\d{4}-\d{2}-\d{2})\))?(?:\s*—\s*([^|]+?)(?:\s*was:\s*(\w+))?)?(?:\s*\||\s*$)/i);
  if (deferred) {
    return {
      status: 'deferred',
      deferredAt: deferred[1] ? `${deferred[1]}T00:00:00.000Z` : null,
      reason: (deferred[2] || '').trim() || null,
      previousPhase: deferred[3] || null,
      previousPhaseAt: null,
    };
  }
  return { status: 'active' };
}

/**
 * Find the execution-merge commit for a PRD. Two signals, in order:
 *
 *   1. SNAPSHOT — workflow snapshot shows the execution workflow's
 *      `merge_to_main` step is `completed` for this PRD.
 *   2. MERGE COMMIT — `git log --merges --grep="^Merge review/<PRD>:"` finds
 *      the actual merge commit produced by workflow.js → merge_to_main step.
 *
 * Intermediate per-task commits (feat(PRD-X/US-N): …) do NOT count — only the
 * end-of-execution merge flips the phase to `implemented`. Per the lifecycle
 * spec: implemented = "end of execution workflow when it's merged".
 *
 * Returns { mergedSha, mergedAt } or empty {} when no signal matches.
 */
function findMergedCommit(projectRoot, prdId, statePath, prdPath) {
  if (!prdId) return {};

  // Signal 1 — snapshot evidence (authoritative if present).
  const snapshotMerge = findMergeFromSnapshots(statePath, prdPath, projectRoot, prdId);
  if (snapshotMerge.mergedSha) return snapshotMerge;

  // Signal 2 — actual `--no-ff` merge commit with the workflow's exact message convention.
  try {
    const out = execFileSync('git', [
      'log', '-1', '--merges', '--format=%h|%cI',
      `--grep=^Merge review/${prdId}:`, '--extended-regexp',
      'main',
    ], { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (out) {
      const [sha, when] = out.split('|');
      return { mergedSha: sha, mergedAt: when };
    }
  } catch {}

  return {};
}

/**
 * Look for an execution-workflow snapshot whose `merge_to_main` step is
 * completed and whose prdPath matches. Returns the merge commit's short SHA +
 * date if found, else empty.
 */
function findMergeFromSnapshots(statePath, prdPath, projectRoot, prdId) {
  if (!statePath) return {};
  const dir = path.join(statePath, 'snapshots');
  if (!fs.existsSync(dir)) return {};
  let bestSnapshot = null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    // Snapshot filename pattern: workflow-execution-<sess>-step-merge_to_main-<at>.json
    if (!/workflow-execution-.*-step-merge_to_main-/.test(f)) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch { continue; }
    if (!data || data.type !== 'execution') continue;
    // Match this PRD by path (not just id — paths are more specific).
    if (prdPath && data.prdPath && !data.prdPath.endsWith(prdPath) && data.prdPath !== prdPath) continue;
    const stepStatus = data.steps?.merge_to_main?.status;
    if (stepStatus !== 'completed') continue;
    if (!bestSnapshot || (data.updatedAt && data.updatedAt > bestSnapshot.updatedAt)) {
      bestSnapshot = data;
    }
  }
  if (!bestSnapshot) return {};
  // Snapshot proves merge_to_main completed. Look up the actual SHA via the
  // workflow's merge commit message convention. If the lookup fails (rare —
  // commit was rewritten or the snapshot is stale), return a synthetic record
  // so the phase still flips to merged even without a SHA.
  try {
    const out = execFileSync('git', [
      'log', '-1', '--merges', '--format=%h|%cI',
      `--grep=^Merge review/${prdId}:`, '--extended-regexp',
      'main',
    ], { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (out) {
      const [sha, when] = out.split('|');
      return { mergedSha: sha, mergedAt: when, source: 'snapshot+commit' };
    }
  } catch {}
  return { mergedSha: '(snapshot)', mergedAt: bestSnapshot.updatedAt || null, source: 'snapshot' };
}

/**
 * Read .build-studio/snapshots/ and return completed-workflow snapshots
 * filtered to the PRD whose prdPath matches. Snapshot filenames look like:
 *   workflow-<type>-<sessionTimestamp>-step-<step>-<atTimestamp>.json
 * We treat any snapshot whose embedded type is review/execution and whose
 * prdPath matches as a candidate; "completedAt" comes from the snapshot's
 * updatedAt or the filename suffix.
 */
function loadSnapshotsForPrd(statePath, prdPath) {
  const dir = path.join(statePath, 'snapshots');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    if (!f.startsWith('workflow-')) continue;
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch { continue; }
    if (!data || !data.type || !['review', 'execution'].includes(data.type)) continue;
    if (prdPath && data.prdPath && !data.prdPath.endsWith(prdPath) && data.prdPath !== prdPath) continue;
    // A snapshot represents a *step* completion. We surface the latest one per type as
    // completedAt = updatedAt; whether the workflow as a whole was approved is implied
    // by the existence of a merge commit (for execution) or absence of pending-review
    // step (for review). Be conservative: mark approved=true unless we can prove otherwise.
    // `approved` = workflow ran to its `completed` step. The phase derivation
    // only counts review snapshots whose workflow actually completed —
    // mid-review snapshots (currentStep=reviewing/pm_fix/companion_specs)
    // do not flip the phase to `reviewed`.
    out.push({
      type: data.type,
      completedAt: data.updatedAt || null,
      approved: data.currentStep === 'completed',
    });
  }
  return out;
}

/**
 * Replace (or insert) a status marker on the Backlog row containing prdId.
 * Strategy:
 *   - If the row contains an existing "Status: …" segment, replace its value.
 *   - Else, append " — Status: <marker>" to the row.
 * Returns the updated content, or null when no Backlog row matches.
 */
function setBacklogRowStatus(content, prdId, marker) {
  const start = content.indexOf('\n## Backlog\n');
  if (start === -1) return null;
  const end = content.indexOf('\n## ', start + 12);
  const before = content.slice(0, start + 1);
  const section = end === -1 ? content.slice(start + 1) : content.slice(start + 1, end);
  const after = end === -1 ? '' : content.slice(end);
  const lines = section.split('\n');
  let touched = false;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes(prdId)) continue;
    // Strip existing markers — Status:, Deferred (…), Done (…), Closed (…), Active.
    let row = lines[i];
    row = row.replace(/\s*—\s*Status:[^|\n]*/i, '');
    row = row.replace(/\s*—\s*(Deferred|Done|Closed|Active)\s*(?:\([^)]*\))?[^|\n]*/i, '');
    row = row.trimEnd();
    // Avoid wedging the marker inside a markdown table cell — append at end of line.
    lines[i] = `${row} — Status: ${marker}`;
    touched = true;
    break;
  }
  if (!touched) return null;
  return before + lines.join('\n') + after;
}

function createStatusRouter(config, gitOps, state) {
  const router = express.Router();
  const { docsPath, projectRoot } = config;

  router.get('/agents', (req, res) => {
    const statusFile = path.join(docsPath, 'agent-status.json');
    if (!fs.existsSync(statusFile)) return res.json({ agents: [] });
    try { res.json(JSON.parse(fs.readFileSync(statusFile, 'utf8'))); }
    catch (_) { res.status(500).json({ error: 'Failed to parse agent-status.json' }); }
  });

  router.get('/status', (req, res) => {
    const psFile = path.join(docsPath, 'project-state.md');
    let projectStateSection = null;
    let activePrd = null;
    if (fs.existsSync(psFile)) {
      const content = fs.readFileSync(psFile, 'utf8');
      const backlogStart = content.indexOf('\n## Backlog\n');
      if (backlogStart !== -1) {
        const fromHeading = backlogStart + 1;
        const nextSection = content.indexOf('\n## ', fromHeading + 10);
        projectStateSection = (nextSection !== -1
          ? content.slice(fromHeading, nextSection)
          : content.slice(fromHeading)).trimEnd();
      }
      const activePrdMatch = content.match(/^## Active PRD\n+(\[[^\]]+\][^\n]+)/m);
      if (activePrdMatch) activePrd = activePrdMatch[1].trim();
    }

    const commits = gitOps.getRecentCommits(10);
    let agents = null;
    const agentFile = path.join(docsPath, 'agent-status.json');
    if (fs.existsSync(agentFile)) {
      try { agents = JSON.parse(fs.readFileSync(agentFile, 'utf8')); } catch (_) {}
    }
    const git = gitOps.getStatus();

    const commandsDir = path.join(projectRoot, '.claude', 'commands');
    let commands = [];
    if (fs.existsSync(commandsDir)) {
      commands = fs.readdirSync(commandsDir).filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''));
    }

    // Current version from latest git tag
    let version = null;
    try {
      const { execFileSync } = require('child_process');
      const dep = config.deployment || {};
      const prefix = dep.tag_prefix || 'v';
      version = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', `${prefix}*`], {
        cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {} // no tags yet

    // Has this project been migrated to the PRD-004 backlog format? Detected
    // by presence of the BACKLOG-START marker in project-state.md. The hub
    // uses this to choose the default landing tab (Backlog vs Spec) when no
    // saved per-project tab preference exists yet — keeps unmigrated projects
    // on their existing default.
    let hasBacklog = false;
    if (fs.existsSync(psFile)) {
      try {
        const content = fs.readFileSync(psFile, 'utf8');
        hasBacklog = content.includes('<!-- BACKLOG-START -->');
      } catch {}
    }

    res.json({
      projectStateSection, activePrd, commits, agents, git, commands, version,
      config: { name: config.name, port: config.port },
      functions: config.functions,
      portals: config.portals || [],
      operationsTabs: config.operations_tabs || {},
      hasBacklog,
    });
  });

  // ─── PRD lifecycle phase ──────────────────────────────────────────────────
  // GET /api/status/prd-phase → { prd: { id, title, path, phase, … } | null }
  router.get('/status/prd-phase', (req, res) => {
    try {
      const psFile = path.join(docsPath, 'project-state.md');
      if (!fs.existsSync(psFile)) return res.json({ prd: null });
      const content = fs.readFileSync(psFile, 'utf8');

      const activePrd = parseActivePrd(content, projectRoot);
      if (!activePrd) return res.json({ prd: null });

      // PRD file existence + creation time (used for drafted-phase anchor)
      let createdAt = null;
      if (activePrd.path) {
        const abs = path.resolve(projectRoot, activePrd.path);
        try {
          const stat = fs.statSync(abs);
          createdAt = (stat.birthtime || stat.mtime).toISOString();
        } catch {}
      }

      const backlog = parseBacklogRow(content, activePrd.id);

      // Active workflow targeting this PRD. Match by id (primary — workflow.input
      // is always the PRD id and is reliably set) or by path (fallback for older
      // workflow entries that pre-date the id-matching path).
      let workflow = null;
      if (state && typeof state.loadWorkflow === 'function') {
        const wf = state.loadWorkflow();
        if (wf) {
          const idMatch = wf.input && activePrd.id && wf.input.toUpperCase() === activePrd.id.toUpperCase();
          const pathMatch = wf.prdPath && activePrd.path && (wf.prdPath === activePrd.path || wf.prdPath.endsWith(activePrd.path));
          if (idMatch || pathMatch) workflow = wf;
        }
      }

      const snapshots = loadSnapshotsForPrd(config.statePath, activePrd.path);
      const gitState = findMergedCommit(projectRoot, activePrd.id, config.statePath, activePrd.path);

      const phase = derivePrdPhase({
        prdFile: { ...activePrd, createdAt },
        workflow,
        snapshots,
        gitState,
        backlog,
      });

      res.json({ prd: phase });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/status/prd-phase/defer { prdId, reason }
  // Edits project-state.md to mark the Backlog row as Deferred. Does NOT git-commit;
  // the change shows up in the CI/CD tab Working Tree section.
  router.post('/status/prd-phase/defer', (req, res) => {
    const { prdId, reason } = req.body || {};
    if (!prdId || typeof prdId !== 'string') return res.status(400).json({ error: 'prdId required' });
    if (!reason || typeof reason !== 'string') return res.status(400).json({ error: 'reason required' });
    const psFile = path.join(docsPath, 'project-state.md');
    if (!fs.existsSync(psFile)) return res.status(404).json({ error: 'project-state.md not found' });
    let content;
    try { content = fs.readFileSync(psFile, 'utf8'); }
    catch (e) { return res.status(500).json({ error: e.message }); }

    // Determine previous phase by re-running derivation against the pre-defer state.
    let previousPhase = null;
    try {
      const activePrd = parseActivePrd(content, projectRoot);
      if (activePrd) {
        const wf = state && state.loadWorkflow ? state.loadWorkflow() : null;
        let filteredWf = null;
        if (wf) {
          const idMatch = wf.input && activePrd.id && wf.input.toUpperCase() === activePrd.id.toUpperCase();
          const pathMatch = wf.prdPath && activePrd.path && wf.prdPath.endsWith(activePrd.path);
          if (idMatch || pathMatch) filteredWf = wf;
        }
        const snapshots = loadSnapshotsForPrd(config.statePath, activePrd.path);
        const gitState = findMergedCommit(projectRoot, activePrd.id, config.statePath, activePrd.path);
        const current = derivePrdPhase({
          prdFile: { ...activePrd },
          workflow: filteredWf,
          snapshots,
          gitState,
          backlog: { status: 'active' },
        });
        if (current) previousPhase = current.phase;
      }
    } catch {}

    const today = new Date().toISOString().slice(0, 10);
    const safeReason = reason.replace(/\|/g, '-').trim();
    const marker = `Deferred (${today}) — ${safeReason}${previousPhase ? ` was: ${previousPhase}` : ''}`;
    const updated = setBacklogRowStatus(content, prdId, marker);
    if (updated === null) return res.status(404).json({ error: `No Backlog row found for ${prdId}` });
    try { fs.writeFileSync(psFile, updated); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    res.json({ ok: true, prdId, marker, previousPhase });
  });

  // POST /api/status/prd-phase/done { prdId }
  // Marks the Backlog row as Done — manual final state. Owner clicks the Done
  // button in the Status tab. Does NOT git-commit.
  router.post('/status/prd-phase/done', (req, res) => {
    const { prdId } = req.body || {};
    if (!prdId || typeof prdId !== 'string') return res.status(400).json({ error: 'prdId required' });
    const psFile = path.join(docsPath, 'project-state.md');
    if (!fs.existsSync(psFile)) return res.status(404).json({ error: 'project-state.md not found' });
    let content;
    try { content = fs.readFileSync(psFile, 'utf8'); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    const today = new Date().toISOString().slice(0, 10);
    const marker = `Done (${today})`;
    const updated = setBacklogRowStatus(content, prdId, marker);
    if (updated === null) return res.status(404).json({ error: `No Backlog row found for ${prdId}` });
    try { fs.writeFileSync(psFile, updated); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    res.json({ ok: true, prdId, marker });
  });

  // POST /api/status/prd-phase/reactivate { prdId }
  // Reverses defer or done — strips the marker so the row falls back to derived phase.
  router.post('/status/prd-phase/reactivate', (req, res) => {
    const { prdId } = req.body || {};
    if (!prdId || typeof prdId !== 'string') return res.status(400).json({ error: 'prdId required' });
    const psFile = path.join(docsPath, 'project-state.md');
    if (!fs.existsSync(psFile)) return res.status(404).json({ error: 'project-state.md not found' });
    let content;
    try { content = fs.readFileSync(psFile, 'utf8'); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    const updated = setBacklogRowStatus(content, prdId, 'Active');
    if (updated === null) return res.status(404).json({ error: `No Backlog row found for ${prdId}` });
    try { fs.writeFileSync(psFile, updated); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    res.json({ ok: true, prdId });
  });

  router.get('/roles', (req, res) => {
    const { getAllRoles } = require('../config');
    const commandsDir = path.join(projectRoot, '.claude', 'commands');
    // Find template commands dir — works from both source tree and Electron bundle
    const templateSuffix = path.join('templates', 'default', '.claude', 'commands');
    const candidates = [
      path.resolve(__dirname, '..', '..', '..', '..', templateSuffix),             // source tree
      path.resolve(__dirname, '..', '..', '..', templateSuffix),                    // Resources/project-server/lib/api
      path.resolve(__dirname, '..', '..', '..', '..', '..', '..', templateSuffix), // Resources/standalone/.../lib/api
    ];
    const templateCommandsDir = candidates.find(d => fs.existsSync(d)) || candidates[0];

    // Build roles list directly from categories to preserve correct category assignment
    // (same role name can appear in multiple categories, e.g. QA in review + standalone)
    const seen = new Set();
    const roles = [];
    for (const cat of ['review', 'execution', 'standalone']) {
      for (const role of (config.roles[cat] || [])) {
        // Deduplicate: same role+skill in multiple categories = show once with first category
        const key = `${role.role}:${role.skill || role.command}`;
        if (seen.has(key)) continue;
        seen.add(key);
        roles.push({ ...role, _category: cat });
      }
    }

    const enriched = roles.map(role => {
      const cat = role._category;
      const cmdFile = role.command ? path.join(commandsDir, role.command) : null;
      let commandContent = null;
      let isOverridden = false;

      if (cmdFile && fs.existsSync(cmdFile)) {
        commandContent = fs.readFileSync(cmdFile, 'utf8');
        // Check if the command has meaningful project-specific content beyond the init scaffold.
        // The init process always customizes the title and base role line, so exact comparison
        // against templates would mark everything as overridden. Instead, check if the
        // "Project-Specific Notes" section has real content (not just a placeholder comment).
        if (role.command) {
          const notesMatch = commandContent.match(/## Project-Specific Notes\s*\n([\s\S]*)$/);
          if (notesMatch) {
            const notesBody = notesMatch[1].trim();
            // Placeholder-only = not overridden (e.g., "<!-- Add example-web-specific overrides... -->")
            isOverridden = notesBody.length > 0 && !notesBody.match(/^<!--[\s\S]*-->$/);
          } else {
            // No "Project-Specific Notes" section — check if it has custom sections
            // beyond the standard scaffold (base role + before starting)
            const templateFile = path.join(templateCommandsDir, role.command);
            if (fs.existsSync(templateFile)) {
              const templateContent = fs.readFileSync(templateFile, 'utf8');
              isOverridden = commandContent.trim() !== templateContent.trim();
            } else {
              isOverridden = true;
            }
          }
        }
      }

      return {
        role: role.role,
        skill: role.skill || null,
        command: role.command || null,
        commandContent,
        isOverridden,
        category: cat,
        branchPrefix: role.branch_prefix || null,
        worktree: !!role.worktree,
        model: config.step_models?.[cat === 'execution' ? 'task_execution' : 'reviewing'] || config.agent_defaults?.model || 'opus',
      };
    });

    res.json({ roles: enriched });
  });

  router.get('/skills', (req, res) => {
    const os = require('os');

    function readSkillsDir(dir) {
      if (!fs.existsSync(dir)) return [];
      const skills = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillFile = path.join(dir, entry.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        const raw = fs.readFileSync(skillFile, 'utf8');
        // Parse YAML frontmatter
        let name = entry.name;
        let description = null;
        let content = raw;
        const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
        if (fmMatch) {
          const fm = fmMatch[1];
          content = fmMatch[2].trim();
          const nameMatch = fm.match(/^name:\s*(.+)$/m);
          if (nameMatch) name = nameMatch[1].trim();
          const descMatch = fm.match(/^description:\s*(.+)$/m);
          if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, '');
        }
        skills.push({ name, description, content });
      }
      return skills.sort((a, b) => a.name.localeCompare(b.name));
    }

    const projectSkills = readSkillsDir(path.join(projectRoot, '.claude', 'skills'));
    const globalSkills = readSkillsDir(path.join(os.homedir(), '.claude', 'skills'));

    res.json({ project: projectSkills, global: globalSkills });
  });

  router.post('/chat', async (req, res) => {
    const { messages, agentRole, documentPath } = req.body;
    if (!messages || !agentRole) return res.status(400).json({ error: 'messages and agentRole required' });

    const commandsDir = path.join(projectRoot, '.claude', 'commands');
    const roleFile = path.join(commandsDir, `${agentRole.toLowerCase().replace(/[\s/]+/g, '_')}.md`);
    let systemPrompt = `You are a ${agentRole} helping to review and improve project documents.`;
    if (fs.existsSync(roleFile)) {
      systemPrompt = fs.readFileSync(roleFile, 'utf8');
    }

    if (documentPath) {
      const absPath = path.resolve(docsPath, documentPath);
      if (absPath.startsWith(docsPath) && fs.existsSync(absPath)) {
        const docContent = fs.readFileSync(absPath, 'utf8');
        systemPrompt += `\n\n---\nCurrent document (${path.basename(documentPath)}):\n\n${docContent}`;
      }
    }

    systemPrompt += `\n\n---\n## Chat mode constraints\n\nYou are in a conversational review session. You do NOT have file system access — you cannot read, create, or modify files directly. The document shown above is the only file you can see.\n\nIf you want to propose changes to the open document, output the complete updated file content in a single fenced markdown code block. The user can then click "Apply edit" to write it to disk. Do NOT claim to have written, created, or updated any files — describe what you propose instead.`;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    try {
      const Anthropic = require('@anthropic-ai/sdk');
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const stream = anthropic.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: systemPrompt,
        messages,
      });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
        }
      }
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  });

  return router;
}

module.exports = {
  createStatusRouter,
  // Exported for unit tests
  findMergedCommit, findMergeFromSnapshots,
  parseActivePrd, parseBacklogRow,
};
