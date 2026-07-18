// Local Express router — not a Vercel Function or Vercel Workflow step.
// Intentional: uses CommonJS require, fs writes to local disk, setTimeout for polling.
const express = require('express');
const fs = require('fs');
const path = require('path');
const { stripAnsi } = require('../tmux');
const { transitionFeaturesForPRD, parseBacklogSection, writeBacklogSection, readItem, isValidId, writeItem } = require('../backlog');

// Common instruction fragments injected into all agent prompts.
// Placeholders {{CONTEXT_BUDGET}} and {{SOFT_THRESHOLD}} are replaced
// per-agent in launchWorkflowAgents based on the resolved model's
// context window (200K default, 1M for `[1m]` models, ~258K for Codex).
const EFFICIENCY_INSTRUCTIONS = `

## CONTEXT BUDGET — READ THIS

You have a context window of {{CONTEXT_BUDGET}}. Be efficient:
1. Execute your primary task FIRST — don't explore the codebase extensively before acting
2. Report feedback as soon as you have results — don't keep investigating
3. If you need to read files, read only what's necessary for your task
4. Do NOT attempt to fix issues outside your assigned scope
5. If you're stuck or unsure, report what you know and stop — don't burn context exploring`;

// Fix-execution agents are doing root-cause investigation by definition —
// they're called BECAUSE QA / review found a bug that requires diagnosis.
// The standard EFFICIENCY_INSTRUCTIONS' "don't explore extensively" and
// "if stuck, stop" rules fight against legitimate debugging. This variant
// permits investigation but keeps scope discipline + the soft compaction
// threshold. Observed failure (example-ios PRD-009 fix-1, 2026-05-23): agent
// found a real reactive-binding bug behind a test failure but was nudged
// by the standard rules toward shipping a partial-symptom fix.
const FIX_EXECUTION_EFFICIENCY_INSTRUCTIONS = `

## FIX-TASK CONTEXT BUDGET — READ THIS

You have {{CONTEXT_BUDGET}}. Fix tasks involve investigation — that's why this is a separate step from initial implementation. Don't rush a fix that requires understanding the bug.

1. **Investigation is expected.** Read enough to understand WHY the test fails, not just patch the symptom. A failing identifier check often hides a reactive-binding, seam fixture, or observer-notification bug behind it. Trace the data path.
2. **Trust your diagnostic instincts.** If a test passes after your initial fix but other related tests now fail differently, you patched a symptom — not the cause. Keep going.
3. **Stay within the assigned scope.** If your investigation reveals a deeper bug outside this fix task's scope, document it in your feedback as an Action Item for fix_plan — do NOT expand the current task to fix everything you find.
4. **Commit incrementally** as you make verified progress. Compaction won't lose committed work — uncommitted investigation IS at risk.
5. **At >{{SOFT_THRESHOLD}} consumed without a complete fix**, stop and POST your investigation findings as Action Items rather than burning more context. fix_plan will reassign with a fresh context budget plus your findings as a hint.

## ITERATION DISCIPLINE — DON'T SPIRAL

6. **Scope every test run to the failure.** While iterating, run ONLY the failing test(s) via \`-only-testing:Target/Class[/method]\` — NEVER the full \`xcodebuild test\` / whole suite. A full iOS suite run costs minutes per cycle; qa_validation re-runs the whole suite once at the end. Repeated full-suite runs are the #1 cause of fix-step time + context blowups.
7. **Cap attempts, then escalate.** If the SAME test still fails after ~3 focused attempts, STOP. Post your diagnosis + the specific recommended fix as Action Items (for fix_plan / human triage) instead of trying a 4th. A 4th+ attempt on the same failure rarely converges — escalating with a clear hypothesis is faster than spiralling.
8. **Screenshot / PR-evidence failures = check the FIXTURE first.** A blank, empty, or wrong-data capture almost always means the test didn't seed the state it asserts on (no open phase, empty store, missing record). Fix the test's data-seeding/setup. Do NOT modify production code to make a screenshot pass — that risks changing real behaviour to satisfy an evidence artifact.
9. **Leave no debug cruft.** If you add temporary logging/probes (NSLog, print, etc.) to diagnose, REMOVE them before reporting. Never commit debug code.`;

/** Resolve the context budget label for a model. */
function contextBudgetFor(modelId, useCodex) {
  if (useCodex) return { budget: '~258K tokens (Codex GPT-5.5)', softThreshold: '~130K tokens' };
  if (modelId && modelId.includes('[1m]')) return { budget: '~1M tokens (1M-context tier)', softThreshold: '~500K tokens' };
  return { budget: '~200K tokens', softThreshold: '~100K tokens' };
}

const STRUCTURED_FEEDBACK_INSTRUCTIONS = `

## FEEDBACK FORMAT — MANDATORY

Use the structured format defined in CLAUDE.md. Your feedback is machine-parsed.

For reviews: **Approved:** yes|no, **Blocking:** N, **Medium:** N, **Low:** N, ### Summary, ### Findings, ### Action Items
For QA: **Approved:** yes|no, **Tests passed:** N/N, **Failures:** N, ### Summary, ### Failures, ### Action Items
For fix reports: **All issues addressed:** yes|no, **Committed:** hash, ### Changes, ### Notes`;

// Appended to every prompt that tells a root-running agent (useWorktrees: false)
// to commit. Without this, an agent sitting on main may follow the default
// "branch first" git caution and strand its commit on a stray branch the
// workflow never merges (example-app PRD-031, 2026-06-09: pm_fix created
// prd-031-r1-revisions and left main without the approved PRD revision).
const COMMIT_ON_CURRENT_BRANCH = 'Commit on the currently checked-out branch — do NOT create a new branch or switch branches.';

// Execution-category developer roles whose CLI can be swapped via wf.developerCli.
// Mirrors the role names in presets.js → roles.execution. If a new developer
// role is added to a preset, add it here so the codex/claude switch covers it.
const DEVELOPER_ROLE_NAMES = new Set(['Frontend Dev', 'Backend Dev', 'Fullstack Dev', 'iOS Dev', 'Android Dev']);

function isDeveloperRole(roleName) {
  return DEVELOPER_ROLE_NAMES.has(roleName);
}

// Normalize role names for lookup so the API accepts every reasonable form an
// agent might reconstruct from its skill filename or memory after compaction
// (e.g. "iOS Dev", "ios_dev", "iOS_Dev", "iosdev" all match the same agent).
function normalizeRole(s) {
  return String(s || '').toLowerCase().replace(/[\s_-]+/g, '');
}

// Reviewer roles whose CLI can be swapped via wf.reviewerCli. Step 2 of the
// CLI knob: covers code_review (Code Reviewer role) and security_audit
// (Security role). Cross-model review is the value here — pairing the
// implementer's CLI with the *other* model for review surfaces blind spots.
const REVIEWER_ROLE_NAMES = new Set(['Code Reviewer', 'Security']);

function isReviewerRole(roleName) {
  return REVIEWER_ROLE_NAMES.has(roleName);
}

// The reviewer-CLI flip (cross-model review) applies ONLY to execution workflows.
// In a PRD review it adds no value (reviewing a doc, not code) and just risks a
// second-CLI auth/availability failure (the codex-token stall, 2026-06-05). So a
// reviewer runs on codex ONLY when this is an execution run AND reviewerCli is codex;
// reviewers in a review workflow always stay on the base (claude) CLI, regardless of
// reviewerCli. Cross-model review is opt-in per execution run via the UI.
function reviewerOnCodex(wf, roleName) {
  return isReviewerRole(roleName) && wf.reviewerCli === 'codex' && wf.type === 'execution';
}

function oppositeCli(cli) {
  return cli === 'codex' ? 'claude' : 'codex';
}

// ─── bugfix workflow (pure helpers — unit-testable, no I/O) ───────────────────
// A bugfix run is a lean execution flow driven by a single Bug backlog item:
// no PRD, no planning step, no review panel. The bug file IS the spec.

// Default step sequence when config.workflow.bugfix isn't set.
const DEFAULT_BUGFIX_STEPS = ['task_execution', 'qa_validation', 'code_review', 'merge_to_main', 'capture_learnings'];

// Appended verbatim to the synthetic fix task's description. `id` is the bug id.
function bugfixDisciplineBlock(id) {
  return `## BUG-FIX DISCIPLINE — REPRO TEST FIRST
1. Write a failing regression test that reproduces this bug BEFORE touching production code. Run it and paste the failing output in your feedback.
2. Fix the bug. Re-run: paste the passing output.
3. The regression test is part of the fix — it must be committed with it and named so its connection to ${id} is obvious.
4. Keep the diff minimal: fix the bug, do not refactor around it.
Report with the FIX-REPORT format; include the regression test path.`;
}

// The active step sequence for a bugfix run (config override or the default).
function bugfixSequence(config) {
  const configured = config && config.workflow && config.workflow.bugfix;
  return (Array.isArray(configured) && configured.length) ? configured.slice() : DEFAULT_BUGFIX_STEPS.slice();
}

// The active step sequence for a workflow — bugfix uses its own list, everything
// else uses the resolved execution list. Used by the step→step transitions so a
// bugfix run advances by ITS dict order, not the (longer) execution order.
function stepSequence(wf, config) {
  if (wf && wf.type === 'bugfix') return bugfixSequence(config);
  return (config && config.workflow && config.workflow.execution) || [];
}

// The step that follows `current` in a workflow's active sequence, or null at the end.
function nextStepInSequence(wf, config, current) {
  const seq = stepSequence(wf, config);
  const idx = seq.indexOf(current);
  return (idx >= 0 && idx < seq.length - 1) ? seq[idx + 1] : null;
}

// Validate a bugfix /workflow/start request against the resolved backlog item.
// Returns { status, error } on rejection, or null when the item is startable.
// NO PRD requirement — the prd-field gates that review/execution apply are
// deliberately skipped; a Bug's own file is its spec.
function validateBugfixStart(item, id) {
  if (!item) return { status: 404, error: `Backlog item ${id} not found.` };
  if (item.type !== 'Bug') {
    return { status: 400, error: `bugfix runs accept Bugs only; ${id} is a ${item.type || 'item with no type'}. Features and Tasks go through the PRD flow.` };
  }
  if (item.status === 'Fixing') return { status: 409, error: `a fix run for ${id} already happened or is in flight` };
  if (item.status === 'Done') return { status: 409, error: `${id} is already fixed (status Done).` };
  if (item.status !== 'Backlog' && item.status !== 'Blocked') {
    return { status: 409, error: `${id} is "${item.status || 'unset'}", but a bugfix run requires status Backlog or Blocked. Move the item there first.` };
  }
  return null;
}

// Resolve the builder role for a bugfix: honor the bug's frontmatter `role:`
// (matched by role name or skill, case-insensitive) when present and resolvable;
// otherwise fall back to the first execution role (the solo builder).
function resolveBuilderRole(config, item) {
  const { findRole } = require('../config');
  if (item && item.role) {
    const matched = findRole(config, String(item.role));
    if (matched) return matched;
  }
  return (config.roles && config.roles.execution && config.roles.execution[0]) || null;
}

// Build the synthetic single-task plan entry for a bugfix. The bug body is the
// spec; the discipline block enforces repro-test-first. `role` is a resolved
// role object; task.role holds its canonical name so launchTaskImpl re-resolves it.
function buildBugfixTask(id, item, role) {
  const title = String(item.title || id).replace(/\s+/g, ' ').trim();
  const body = String(item.body || '').trim();
  const description = `${body ? body + '\n\n' : ''}${bugfixDisciplineBlock(id)}`;
  return {
    role: role ? role.role : undefined,
    name: `Fix ${id} — ${title}`,
    description,
  };
}

function createWorkflowRouter(config, state, gitOps, tmuxOps, broadcast) {
  const router = express.Router();
  const { docsPath, projectRoot, worktreesPath, logsPath } = config;

  /**
   * Advance any backlog items (Feature, Bug, or Task) linked to this PRD to
   * `targetStatus`, then re-render the BACKLOG section in project-state.md so
   * the display lines reflect the new statuses. Safe to call when there's no
   * PRD path (no-op) or when no items match (no-op). Forward-only — never reverts.
   */
  function advanceLinkedFeatures(prdRelPath, targetStatus) {
    if (!prdRelPath) return;
    try {
      const result = transitionFeaturesForPRD(projectRoot, config.docs_path || './docs', prdRelPath, targetStatus);
      if (result.transitioned.length === 0) return;
      console.log(`[backlog] PRD ${prdRelPath}: ${result.transitioned.length} item(s) → ${targetStatus}: ${result.transitioned.map(t => t.id).join(', ')}`);
      // Re-render the order block so display lines pick up new statuses.
      const statePath = path.join(projectRoot, config.docs_path || './docs', 'project-state.md');
      if (fs.existsSync(statePath)) {
        const content = fs.readFileSync(statePath, 'utf8');
        const groups = parseBacklogSection(content);
        if (groups.length > 0) writeBacklogSection(projectRoot, config.docs_path || './docs', groups);
      }
    } catch (e) {
      console.warn(`[backlog] advanceLinkedFeatures(${prdRelPath} → ${targetStatus}) failed:`, e.message);
    }
  }

  /**
   * Set a backlog item's status (bugfix lifecycle: Backlog/Blocked → Fixing →
   * Done, or Fixing → Backlog on cancel) and re-render the BACKLOG section of
   * project-state.md so its marker line reflects the new status. `extraFields`
   * merges additional frontmatter (e.g. `{ fixed_in: <sha> }` at merge).
   *
   * Uses the validated backlog `writeItem` — all three bugfix statuses (Fixing,
   * Done, Backlog) are in VALID_STATUSES. Returns true when the item existed.
   */
  function setBugItemStatus(id, status, extraFields) {
    const relDocs = config.docs_path || './docs';
    const item = readItem(projectRoot, relDocs, id);
    if (!item) return false;
    const updated = { ...item, status, ...(extraFields || {}) };
    writeItem(projectRoot, relDocs, updated);
    try {
      const statePath = path.join(projectRoot, relDocs, 'project-state.md');
      if (fs.existsSync(statePath)) {
        const groups = parseBacklogSection(fs.readFileSync(statePath, 'utf8'));
        if (groups.length > 0) writeBacklogSection(projectRoot, relDocs, groups);
      }
    } catch (e) {
      console.warn(`[bugfix] project-state re-render for ${id}→${status} failed:`, e.message);
    }
    return true;
  }

  /**
   * Commit uncommitted docs changes (backlog item status, project-state.md,
   * worklog) on the CURRENT branch. The server writes these status transitions
   * directly to the working tree; without this they'd be left dirty (review:
   * stranded on the default branch; execution: dirty after merge, blocking the
   * next run's clean-tree guardrail). No-op when nothing under docs/ is dirty.
   */
  function commitWorkflowDocs(message) {
    try {
      const { execFileSync } = require('child_process');
      const docsRel = (config.docs_path || './docs').replace(/^\.\//, '');
      // Scope strictly to the backlog status files. A review may legitimately run
      // with the owner's unrelated PRD drafts uncommitted (the start guardrail
      // allows it), so a broad `git add docs/` would sweep those into this commit.
      const paths = [`${docsRel}/project-state.md`, `${docsRel}/backlog`];
      execFileSync('git', ['add', '--', ...paths], { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] });
      const staged = execFileSync('git', ['diff', '--cached', '--name-only', '--', ...paths], { cwd: projectRoot, encoding: 'utf8' }).trim();
      if (!staged) return false;
      // `-- paths` keeps the commit limited to these files even if anything else is staged.
      execFileSync('git', ['commit', '-m', message, '--', ...paths], { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] });
      console.log(`[workflow] committed backlog status (${staged.split('\n').length} file(s)): ${message}`);
      return true;
    } catch (e) {
      console.warn('[workflow] commitWorkflowDocs failed:', e.message);
      return false;
    }
  }

  /** Try JSON.parse with repair for common LLM output issues. */
  function tryParseJSON(raw) {
    if (!raw) return null;
    const trimmed = raw.trim();
    // 1. Direct parse
    try { return JSON.parse(trimmed); } catch {}
    // 2. Regex-extract just the task objects we need (id, roles, description, name)
    //    This handles cases where agents embed code with unescaped quotes in detail/verification fields
    try {
      const tasks = [];
      const taskBlocks = trimmed.split(/\{\s*"id"/);
      for (let i = 1; i < taskBlocks.length; i++) {
        const block = '{"id"' + taskBlocks[i];
        const id = block.match(/"id"\s*:\s*"?([^",}\s]+)/);
        // Handle both "roles": ["Backend Dev"] and "role": "Backend Dev"
        const rolesArr = block.match(/"roles"\s*:\s*\[\s*"([^"]+)"/);
        const roleSingle = block.match(/"role"\s*:\s*"([^"]+)"/);
        const role = rolesArr ? rolesArr[1] : (roleSingle ? roleSingle[1] : null);
        const name = block.match(/"name"\s*:\s*"([^"]+)"/);
        const desc = block.match(/"description"\s*:\s*"([^"]+)"/);
        const deps = block.match(/"dependencies"\s*:\s*\[([^\]]*)\]/);
        const acs = block.match(/"acs_covered"\s*:\s*\[([^\]]*)\]/);
        const size = block.match(/"estimated_size"\s*:\s*"([^"]+)"/);
        if (id && (role || desc || name)) {
          tasks.push({
            id: isNaN(Number(id[1])) ? i : Number(id[1]),
            name: name ? name[1] : (desc ? desc[1].slice(0, 80) : `Task ${id[1]}`),
            description: desc ? desc[1] : (name ? name[1] : ''),
            roles: role ? [role] : ['Backend Dev'],
            dependencies: deps ? deps[1].split(',').map(s => Number(s.trim())).filter(n => !isNaN(n)) : [],
            acs_covered: acs ? acs[1].match(/"([^"]+)"/g)?.map(s => s.replace(/"/g, '')) || [] : [],
            estimated_size: size ? size[1] : 'medium',
          });
        }
      }
      if (tasks.length > 0) {
        console.log(`[workflow] tryParseJSON: extracted ${tasks.length} tasks via regex fallback`);
        return { validation: 'passed', tasks };
      }
    } catch {}
    // 3. Truncate at last valid closing brace
    try {
      const lastBrace = trimmed.lastIndexOf('}');
      if (lastBrace > 0) return JSON.parse(trimmed.slice(0, lastBrace + 1));
    } catch {}
    return null;
  }

  // Wrap state.saveWorkflow to auto-kill the tmux session when a workflow
  // reaches 'completed'. This prevents zombie sessions when /workflow/finish
  // is never called (e.g. merge resolved manually, or dashboard stopped).
  const _origSaveWorkflow = state.saveWorkflow.bind(state);
  state.saveWorkflow = function (wf) {
    _origSaveWorkflow(wf);
    if (wf.currentStep === 'completed' && wf.sessionName) {
      try { tmuxOps.killSessionAndDevPorts(wf.sessionName, wf.devServerPorts); } catch (_) {}
    }
  };

  // --- Agent launching ---
  // The `[1m]` suffix selects Anthropic's 1M-context tier on the same model.
  // Configure via `step_models: { task_execution: 'opus[1m]' }` etc. — see
  // docs/experiments/prd-009-orchestration-model-matrix.md for the use case.
  // Higher per-token price; right choice for monolithic tasks that exceed 200K.
  const MODEL_IDS = {
    // `opus` and `opus[1m]` now resolve to 4.8 (promoted 2026-05-29 after the
    // PRD-009 orchestration-matrix re-run on 4.8 showed cleaner first-pass
    // implementations than 4.7 at the same wallclock). Configs that say
    // `opus` / `opus[1m]` auto-upgrade. Explicit-version aliases below let
    // a config pin a specific generation if needed.
    opus: 'claude-opus-4-8',
    // `sonnet` / `sonnet[1m]` now resolve to Sonnet 5 (promoted 2026-07-01 when
    // Sonnet 5 shipped as the current Sonnet, superseding 4.6 — same $3/$15 tier,
    // 1M context, effort defaults to high). Configs that say `sonnet` auto-upgrade.
    // Pin `sonnet4.6` below to stay on the prior generation.
    sonnet: 'claude-sonnet-5',
    fable: 'claude-fable-5',
    'opus[1m]': 'claude-opus-4-8[1m]',
    'sonnet[1m]': 'claude-sonnet-5[1m]',
    // Fable 5's 1M window is its default tier; the [1m] alias is kept so
    // configs read uniformly across model families.
    'fable[1m]': 'claude-fable-5[1m]',
    // Explicit-version aliases (kept stable across the floating `opus`/`sonnet` moves).
    'opus4.7': 'claude-opus-4-7',
    'opus4.7[1m]': 'claude-opus-4-7[1m]',
    'opus4.8': 'claude-opus-4-8',
    'opus4.8[1m]': 'claude-opus-4-8[1m]',
    'sonnet4.6': 'claude-sonnet-4-6',
    'sonnet4.6[1m]': 'claude-sonnet-4-6[1m]',
    'sonnet5': 'claude-sonnet-5',
    'sonnet5[1m]': 'claude-sonnet-5[1m]',
  };

  function resolveModel(stepKey, wf) {
    // Priority: workflow state override > step_models config > agent_defaults.model
    const override = wf.stepModelOverrides && wf.stepModelOverrides[stepKey];
    const stepDefault = config.step_models && config.step_models[stepKey];
    const globalDefault = config.agent_defaults.model || 'opus';
    const shortName = override || stepDefault || globalDefault;
    return MODEL_IDS[shortName] || shortName;
  }

  function appendTelemetryLog(wf, entry) {
    try {
      const logDir = path.join(config.tmpPath, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const logFile = path.join(logDir, `workflow-${wf.id}.md`);

      let line = `### Round ${entry.round} — ${entry.step} — ${entry.role}\n`;
      line += `*${entry.at}*\n\n`;
      line += `${entry.feedback}\n\n---\n\n`;

      // Write header on first entry
      if (!fs.existsSync(logFile)) {
        const header = `# Workflow Log: ${wf.id}\n\n**Type:** ${wf.type}\n**Input:** ${wf.input}\n**Started:** ${wf.createdAt}\n\n---\n\n`;
        fs.writeFileSync(logFile, header);
      }
      fs.appendFileSync(logFile, line);
    } catch (_) {}
  }

  /**
   * Write a worklog entry to the Obsidian daily note when a workflow completes.
   * Uses the `obsidian` CLI to append to 2nd Brain vault: Daily/YYYY/MM/build-studio-YYYY-MM-DD.md.
   */
  const OBSIDIAN_VAULT = '2nd Brain';
  const OBSIDIAN_FILE_PREFIX = 'build-studio';

  function obsidianDailyPath() {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return {
      path: `Daily/${yyyy}/${mm}/${yyyy}-${mm}-${dd}-${OBSIDIAN_FILE_PREFIX}.md`,
      yyyy, mm, dd,
      hhmm: now.toTimeString().slice(0, 5),
    };
  }

  function obsidianAppend(dailyPath, content, yyyy, mm, dd) {
    const { execFileSync } = require('child_process');
    const execOpts = { timeout: 5000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] };
    const appendResult = execFileSync('obsidian', ['append', `path=${dailyPath}`, `content=${content}`, `vault=${OBSIDIAN_VAULT}`, 'silent'], execOpts);
    if (appendResult.includes('Error:')) {
      const frontmatter = `---\\ndate: ${yyyy}-${mm}-${dd}\\n---\\n\\n## Work Log`;
      execFileSync('obsidian', ['create', `path=${dailyPath}`, `content=${frontmatter}`, `vault=${OBSIDIAN_VAULT}`, 'silent'], execOpts);
      execFileSync('obsidian', ['append', `path=${dailyPath}`, `content=${content}`, `vault=${OBSIDIAN_VAULT}`, 'silent'], execOpts);
    }
  }

  function writeWorklog(wf) {
    try {
      const projectName = config.name || path.basename(projectRoot);
      const { path: dailyPath, yyyy, mm, dd, hhmm } = obsidianDailyPath();

      // Build summary bullets
      const bullets = [];
      const wfType = wf.type || 'workflow';
      const prdMatch = (wf.input || '').match(/PRD-\d+[a-z]*/i);
      const prdId = prdMatch ? prdMatch[0].toUpperCase() : null;
      if (prdId) bullets.push(`${wfType} workflow completed for ${prdId}`);
      else bullets.push(`${wfType} workflow completed`);

      // Summarize which steps ran
      const stepNames = Object.keys(wf.steps || {}).filter(s => {
        const st = wf.steps[s];
        return st && st.status && st.status !== 'pending';
      });
      if (stepNames.length > 0) bullets.push(`Steps: ${stepNames.join(' → ')}`);

      // Rounds
      if (wf.round > 1) bullets.push(`${wf.round} rounds`);

      // Token usage
      const tokens = sumWorkflowTokens(wf);
      if (tokens > 0) bullets.push(`Tokens: ${fmtTok(tokens)}`);

      // Input description (truncated)
      if (wf.input && !prdMatch) {
        const desc = wf.input.length > 80 ? wf.input.slice(0, 80) + '…' : wf.input;
        bullets.push(desc);
      }

      const content = `\\n### ${hhmm} — ${projectName}\\n${bullets.map(b => `- ${b}`).join('\\n')}`;
      obsidianAppend(dailyPath, content, yyyy, mm, dd);
      console.log(`[workflow] Worklog written to ${OBSIDIAN_VAULT}/${dailyPath} for ${projectName}`);
    } catch (e) {
      console.warn(`[workflow] Failed to write worklog: ${e.message}`);
    }
  }

  /**
   * Auto-tag and push to remote after merge-to-main, based on deployment config.
   */
  function tagAndPush(wf) {
    const dep = config.deployment || {};
    const { execFileSync } = require('child_process');
    const execGit = (args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

    // Auto-tag (skip if HEAD already has a tag — allows manual major/minor tags)
    if (dep.auto_tag && dep.versioning !== 'none') {
      try {
        const prefix = dep.tag_prefix || 'v';

        // Check if HEAD already has a tag (manual tag takes precedence)
        try {
          const existing = execGit(['tag', '--points-at', 'HEAD']);
          if (existing) {
            wf.releaseTag = existing.split('\n')[0];
            console.log(`[workflow] HEAD already tagged ${wf.releaseTag} — skipping auto-tag`);
            // Skip to auto-push
            if (dep.auto_deploy) {
              try {
                execGit(['remote', 'get-url', 'origin']);
                execGit(['push', 'origin', 'main']);
                execGit(['push', 'origin', wf.releaseTag]);
                console.log(`[workflow] Pushed to origin/main with tag ${wf.releaseTag}`);
                writeChangelog(wf);
              } catch (e) {
                console.warn(`[workflow] Auto-push failed: ${e.message}`);
              }
            }
            return;
          }
        } catch {}

        let nextVersion;

        if (dep.versioning === 'calver') {
          const now = new Date();
          const datePart = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}`;
          // Find existing tags for today, increment build number
          let build = 0;
          try {
            const tags = execGit(['tag', '-l', `${prefix}${datePart}*`]);
            if (tags) build = tags.split('\n').length;
          } catch {}
          nextVersion = build > 0 ? `${datePart}.${build}` : datePart;
        } else {
          // semver: find latest tag, bump patch
          let latest = dep.initial_version || '0.1.0';
          try {
            const tag = execGit(['describe', '--tags', '--abbrev=0', '--match', `${prefix}*`]);
            if (tag) latest = tag.replace(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), '');
          } catch {} // no tags yet
          const parts = latest.split('.').map(Number);
          parts[2] = (parts[2] || 0) + 1;
          nextVersion = parts.join('.');
        }

        const tag = `${prefix}${nextVersion}`;
        const prdMatch = (wf.input || '').match(/PRD-\d+[a-z]*/i);
        const message = prdMatch ? `${prdMatch[0]}: ${wf.input}` : wf.input || 'release';
        execGit(['tag', '-a', tag, '-m', message]);
        wf.releaseTag = tag;
        console.log(`[workflow] Tagged ${tag}`);
      } catch (e) {
        console.warn(`[workflow] Auto-tag failed: ${e.message}`);
      }
    }

    // Auto-push (push commits + tags to remote, triggering CD)
    if (dep.auto_deploy) {
      try {
        // Check if remote exists
        execGit(['remote', 'get-url', 'origin']);
        execGit(['push', 'origin', 'main']);
        if (wf.releaseTag) execGit(['push', 'origin', wf.releaseTag]);
        console.log(`[workflow] Pushed to origin/main${wf.releaseTag ? ` with tag ${wf.releaseTag}` : ''}`);
        writeChangelog(wf);
      } catch (e) {
        // No remote or push failed — not fatal, log and continue
        console.warn(`[workflow] Auto-push failed (no remote or auth issue): ${e.message}`);
      }
    }
  }

  /**
   * Write a deploy changelog entry to the Obsidian daily note after pushing to production.
   */
  function writeChangelog(wf) {
    try {
      const { execFileSync } = require('child_process');
      const projectName = config.name || path.basename(projectRoot);
      const execGit = (args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();

      const { path: dailyPath, yyyy, mm, dd, hhmm } = obsidianDailyPath();

      // Get commits between previous tag and current tag (or HEAD)
      const tag = wf.releaseTag;
      let commits = [];
      try {
        const prefix = (config.deployment || {}).tag_prefix || 'v';
        let range = tag;
        try {
          const prevTag = execGit(['describe', '--tags', '--abbrev=0', `${tag}^`, '--match', `${prefix}*`]);
          if (prevTag) range = `${prevTag}..${tag}`;
        } catch {}
        const log = execGit(['log', range, '--oneline', '--no-decorate']);
        if (log) commits = log.split('\n').slice(0, 10);
      } catch {}

      if (commits.length === 0) {
        commits = [wf.input || 'release'];
      }

      const lines = [`\\n### ${hhmm} — ${projectName} deployed ${tag || ''}`];
      for (const c of commits) {
        const sp = c.indexOf(' ');
        const msg = sp > 0 ? c.slice(sp + 1) : c;
        lines.push(`- ${msg}`);
      }
      const content = lines.join('\\n');
      obsidianAppend(dailyPath, content, yyyy, mm, dd);
      console.log(`[workflow] Changelog written to ${OBSIDIAN_VAULT}/${dailyPath} for ${projectName} ${tag || ''}`);
    } catch (e) {
      console.warn(`[workflow] Failed to write changelog: ${e.message}`);
    }
  }

  function buildFeedbackHistory(wf) {
    if (!wf.feedback || wf.feedback.length === 0 || wf.round <= 1) return '';

    // Group by round
    const byRound = {};
    for (const fb of wf.feedback) {
      const r = fb.round || 1;
      if (!byRound[r]) byRound[r] = [];
      byRound[r].push(fb);
    }

    const rounds = Object.keys(byRound).map(Number).sort((a, b) => a - b);
    // Only include last 3 rounds to keep prompt size manageable
    const recentRounds = rounds.slice(-3);

    let history = '\n\n## Previous Feedback History\n\nThis is round ' + wf.round + '. Here is feedback from previous rounds — use this context to avoid repeating already-fixed issues and to verify that prior fixes actually worked.\n';

    for (const r of recentRounds) {
      history += `\n### Round ${r}\n`;
      for (const fb of byRound[r]) {
        // Truncate long feedback to keep prompt size reasonable
        const text = fb.feedback.length > 500 ? fb.feedback.slice(0, 500) + '... (truncated)' : fb.feedback;
        history += `**${fb.role}** (${fb.step}): ${text}\n\n`;
      }
    }

    return history;
  }

  // --- Knowledge compounding: learnings injection ---
  const ROLE_DOMAIN_MAP = {
    'architect': ['architecture'],
    'frontend dev': ['frontend'],
    'backend dev': ['backend'],
    // Monolithic builders own the whole change — give them the full dev-domain
    // union. These were MISSING until 2026-07-03: iOS Dev (example-ios's builder since
    // May) and Fullstack Dev silently received zero learnings because the
    // role lookup returned no domains.
    'fullstack dev': ['frontend', 'backend', 'architecture'],
    'ios dev': ['frontend', 'backend', 'architecture'],
    'android dev': ['frontend', 'backend', 'architecture'],
    'devops': ['devops'],
    'qa': ['qa'],
    'security': ['security'],
    'code reviewer': ['architecture', 'frontend', 'backend'],
    'designer': ['frontend'],
    'pm': ['workflow'],
    'ceo': [],
    'brand': [],
    'marketing': [],
    'ux': ['frontend'],
  };

  /**
   * Read a learning file with YAML frontmatter.
   * Returns { title, date, severity, tags, component, content } or null.
   */
  function readLearningFile(filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
      if (!fmMatch) return null;
      const fm = {};
      for (const line of fmMatch[1].split('\n')) {
        const m = line.match(/^(\w+):\s*(.*)$/);
        if (m) {
          let val = m[2].trim();
          if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
          if (val.startsWith('[') && val.endsWith(']')) val = val.slice(1, -1).split(',').map(s => s.trim());
          fm[m[1]] = val;
        }
      }
      return {
        title: fm.title || path.basename(filePath, '.md'),
        date: fm.date || '',
        severity: fm.severity || 'medium',
        tags: Array.isArray(fm.tags) ? fm.tags : [],
        component: fm.component || 'general',
        content: fmMatch[2].trim(),
        path: filePath,
      };
    } catch { return null; }
  }

  /**
   * Scan a learnings directory for all .md files in category subdirs.
   * Returns array of parsed learning objects.
   */
  function scanLearningsDir(baseDir, domains) {
    const results = [];
    for (const domain of domains) {
      const domainDir = path.join(baseDir, domain);
      if (!fs.existsSync(domainDir)) continue;
      try {
        for (const file of fs.readdirSync(domainDir)) {
          if (!file.endsWith('.md')) continue;
          const learning = readLearningFile(path.join(domainDir, file));
          if (learning) {
            learning.domain = domain;
            results.push(learning);
          }
        }
      } catch {}
    }
    return results;
  }

  /**
   * Score a learning's relevance to a task description.
   * Returns 0-100. Higher = more relevant.
   */
  function scoreLearningRelevance(learning, taskKeywords) {
    let score = 0;
    const tags = learning.tags.map(t => t.toLowerCase());
    const title = learning.title.toLowerCase();
    const content = learning.content.toLowerCase();

    for (const kw of taskKeywords) {
      if (tags.includes(kw)) score += 15;
      if (title.includes(kw)) score += 10;
      if (content.includes(kw)) score += 3;
    }

    // Severity boost
    if (learning.severity === 'high') score += 8;
    else if (learning.severity === 'medium') score += 4;

    return score;
  }

  /**
   * Extract search keywords from a task/PRD description.
   */
  function extractTaskKeywords(text) {
    if (!text) return [];
    const stop = new Set(['the', 'a', 'an', 'and', 'or', 'for', 'to', 'in', 'on', 'of', 'is', 'it', 'this', 'that', 'with', 'as', 'be']);
    const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stop.has(w));
    // Also extract technical terms
    const techTerms = text.toLowerCase().match(/\b(api|auth|cors|xss|csrf|test|ci|cd|deploy|database|db|sql|html|css|js|typescript|ts|node|react|svelte|vue|next|fastify|express|json|jwt|session|cookie|rate.limit|webhook|websocket|ssr|csr|cache|cdn|proxy|docker|redis|postgres|vitest|jest|playwright|e2e|unit.test)\b/g) || [];
    return [...new Set([...words, ...techTerms])];
  }

  function buildLearningsContext(role, taskDescription) {
    const domains = ROLE_DOMAIN_MAP[role.toLowerCase()] || [];
    if (domains.length === 0) return { text: '', injected: [] };

    // Injection cap — deliberately small. The old behavior used
    // max_entries_per_domain (25) as the injection cap and flooded every prompt
    // with ~25 mostly-irrelevant bullets (81k lifetime injections, effectiveness
    // unmeasurable). max_injected is the per-PROMPT budget; max_entries_per_domain
    // remains the curator's per-domain file cap.
    const maxEntries = (config.learnings && config.learnings.max_injected) || 6;
    const { LEARNINGS_DIR } = require('@build-studio/shared/constants');
    const builtinDir = path.join(__dirname, '../../docs/learnings');
    const crossProjectDir = LEARNINGS_DIR;
    const projectDir = path.join(projectRoot, 'docs/learnings');

    // Three-tier scan: project > cross-project (shared ~/.build-studio/learnings) > built-in
    const builtinLearnings = scanLearningsDir(builtinDir, domains);
    const crossProjectLearnings = scanLearningsDir(crossProjectDir, domains);
    const projectLearnings = scanLearningsDir(projectDir, domains);
    const allLearnings = [
      ...projectLearnings.map(l => ({ ...l, source: 'project' })),
      ...crossProjectLearnings.map(l => ({ ...l, source: 'cross-project' })),
      ...builtinLearnings.map(l => ({ ...l, source: 'builtin' })),
    ];

    if (allLearnings.length === 0) return '';

    // If we have a task description, score and rank by relevance
    // Otherwise, include all (capped)
    const keywords = extractTaskKeywords(taskDescription || '');
    let selected;

    if (keywords.length > 0) {
      // Score each learning
      for (const l of allLearnings) {
        l.relevance = scoreLearningRelevance(l, keywords);
      }
      // Relevance is the ONLY admission ticket. The old `|| severity === 'high'`
      // bypass admitted every high-severity entry in the role's domains
      // regardless of the task — the main source of prompt flooding.
      selected = allLearnings
        .filter(l => l.relevance > 0)
        .sort((a, b) => b.relevance - a.relevance)
        .slice(0, maxEntries);
      // Safety net: nothing matched → the 2 highest-severity entries only.
      if (selected.length === 0) {
        selected = allLearnings
          .filter(l => l.severity === 'high')
          .slice(0, 2);
      }
    } else {
      // No keywords — include all, prioritize high severity
      selected = allLearnings
        .sort((a, b) => {
          const sev = { high: 3, medium: 2, low: 1 };
          return (sev[b.severity] || 0) - (sev[a.severity] || 0);
        })
        .slice(0, maxEntries);
    }

    if (selected.length === 0) return { text: '', injected: [] };

    // Deduplicate by title (project entries take priority over global)
    const seen = new Set();
    const deduped = [];
    for (const l of selected) {
      const key = l.title.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(l);
      }
    }

    const MAX_CONTENT = 250;
    let ctx = '\n\n## Known Learnings — apply these, they are verified pitfalls\n\n';
    for (const l of deduped) {
      const sev = l.severity === 'high' ? '🔴' : l.severity === 'medium' ? '🟡' : '⚪';
      const body = l.content.length > MAX_CONTENT ? l.content.slice(0, MAX_CONTENT) + '…' : l.content;
      ctx += `${sev} **${l.title}** — ${body}\n\n`;
    }
    // Self-reported usage is the effectiveness signal that decides which
    // learnings survive (never-applied entries get archived). Honest "none" is
    // a valid and useful answer.
    ctx += `In your feedback POST, include the line \`**Learnings applied:** <exact titles of the entries above that materially changed what you did, comma-separated, or "none">\`. Only list a learning if it actually altered your approach — "none" is a perfectly good answer.\n`;
    return {
      text: ctx,
      injected: deduped.map(l => ({ title: l.title, tags: l.tags, severity: l.severity, domain: l.domain })),
    };
  }

  // --- Learnings effectiveness tracking ---
  const LEARNINGS_STATS_PATH = path.join(require('os').homedir(), '.build-studio', 'learnings-stats.json');

  function loadLearningsStats() {
    try {
      if (fs.existsSync(LEARNINGS_STATS_PATH)) return JSON.parse(fs.readFileSync(LEARNINGS_STATS_PATH, 'utf8'));
    } catch {}
    return { entries: {} };
  }

  function saveLearningsStats(stats) {
    try {
      const dir = path.dirname(LEARNINGS_STATS_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(LEARNINGS_STATS_PATH, JSON.stringify(stats, null, 2));
    } catch {}
  }

  // --- Project-state cost tracking ---

  function parseTok(s) {
    if (!s) return 0;
    const m = s.trim().replace(/\s*tok\s*$/i, '').match(/^([\d.]+)([kKmM]?)$/);
    if (!m) return 0;
    const n = parseFloat(m[1]);
    return m[2].toLowerCase() === 'm' ? Math.round(n * 1_000_000)
         : m[2].toLowerCase() === 'k' ? Math.round(n * 1000) : Math.round(n);
  }

  function fmtTok(n) {
    return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M`
         : n >= 1000 ? `${Math.round(n / 1000)}k`
         : String(n);
  }

  function sumWorkflowTokens(wf) {
    let t = 0;
    for (const step of Object.values(wf.steps || {})) {
      // Use cumulativeTokens if available (captures tokens across review/fix cycles)
      if (step.cumulativeTokens) {
        t += step.cumulativeTokens.inputTokens + step.cumulativeTokens.outputTokens;
      }
      // Also count current agents (not yet captured to cumulative)
      for (const a of (step.agents || [])) {
        if (a.tokenUsage) t += a.tokenUsage.inputTokens + a.tokenUsage.outputTokens;
      }
    }
    for (const ts of Object.values(wf.taskExecution?.taskStates || {})) {
      if (ts.cumulativeTokens) {
        t += ts.cumulativeTokens.inputTokens + ts.cumulativeTokens.outputTokens;
      }
      // Count current agents not yet captured
      for (const a of (ts.agents || [])) {
        if (a.tokenUsage) t += a.tokenUsage.inputTokens + a.tokenUsage.outputTokens;
      }
    }
    return t;
  }

  function updateProjectStateCost(wf) {
    const psFile = path.join(docsPath, 'project-state.md');
    if (!fs.existsSync(psFile)) return;

    const prdMatch = (wf.input || '').match(/PRD-\d+[a-z]*/i);
    if (!prdMatch) return;
    const prdId = prdMatch[0].toUpperCase();

    const wfTokens = sumWorkflowTokens(wf);
    if (wfTokens === 0) return;

    const lines = fs.readFileSync(psFile, 'utf8').split('\n');

    // Find the first table inside the ## Backlog section
    let headerIdx = -1;
    let inBacklog = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^## Backlog\b/i.test(lines[i])) { inBacklog = true; continue; }
      if (inBacklog && /^## /.test(lines[i])) break;
      if (inBacklog && /^\|.*\|.*\|/.test(lines[i]) && !/^[|\s-]+$/.test(lines[i])) {
        headerIdx = i;
        break;
      }
    }
    if (headerIdx === -1) return;
    const sepIdx = headerIdx + 1;

    // Add Cost column to header + separator if not present
    if (!/Cost/i.test(lines[headerIdx])) {
      lines[headerIdx] = lines[headerIdx].trimEnd().replace(/\|$/, '| Cost |');
      lines[sepIdx]    = lines[sepIdx].trimEnd().replace(/\|$/, '| --- |');
    }

    // Count data columns from (possibly updated) header
    const numCols = lines[headerIdx].split('|').length - 2;

    // Find PRD row and update cost cell
    for (let i = sepIdx + 1; i < lines.length; i++) {
      if (!lines[i].startsWith('|')) break;
      if (!new RegExp(`\\b${prdId}\\b`, 'i').test(lines[i])) continue;

      const cells = lines[i].split('|').map(c => c.trim());
      // Pad to numCols data cells (+ 2 for leading/trailing empty)
      while (cells.length - 2 < numCols) cells.splice(-1, 0, '—');

      const existing = parseTok(cells[numCols] === '—' || cells[numCols] === '-' ? '' : cells[numCols]);
      cells[numCols] = fmtTok(existing + wfTokens);
      lines[i] = '| ' + cells.slice(1, -1).join(' | ') + ' |';
      break;
    }

    // Recompute project total from all Cost column values
    let totalTokens = 0;
    for (let i = sepIdx + 1; i < lines.length; i++) {
      if (!lines[i].startsWith('|')) break;
      const cells = lines[i].split('|').map(c => c.trim());
      if (cells.length - 2 >= numCols) totalTokens += parseTok(cells[numCols]);
    }

    // Update or insert total line before the table
    const totalRe = /^\*\*Total AI usage:\*\*/;
    let totalIdx = -1;
    for (let i = headerIdx - 1; i >= 0; i--) {
      if (totalRe.test(lines[i])) { totalIdx = i; break; }
      if (/^## /.test(lines[i])) break;
    }
    const totalLine = `**Total AI usage:** ${fmtTok(totalTokens)} tokens`;
    if (totalIdx !== -1) {
      lines[totalIdx] = totalLine;
    } else {
      // Insert before the table with a blank line separator
      lines.splice(headerIdx, 0, totalLine, '');
    }

    fs.writeFileSync(psFile, lines.join('\n'), 'utf8');
    console.log(`[workflow] project-state.md: ${prdId} +${fmtTok(wfTokens)} tok, project total ${fmtTok(totalTokens)} tok`);
  }

  state.registerCompletionHook(updateProjectStateCost);

  // Cost per 1M tokens (USD) — Sonnet 4.x and Opus 4.x pricing
  const TOKEN_COSTS = {
    opus:   { input: 15, output: 75, cacheCreate: 18.75, cacheRead: 1.5 },
    sonnet: { input: 3,  output: 15, cacheCreate: 3.75,  cacheRead: 0.3 },
  };

  function computeTokenUsage(startedAt, completedAt, agentCwd, modelShortName) {
    try {
      const os = require('os');
      // Derive Claude project slug from cwd: replace leading '/' with '-', rest '/' → '-'
      const slug = agentCwd.replace(/\//g, '-');
      const claudeDir = path.join(os.homedir(), '.claude', 'projects', slug);
      if (!fs.existsSync(claudeDir)) return null;

      const start = new Date(startedAt).getTime();
      const end = new Date(completedAt).getTime();

      let inputTokens = 0, outputTokens = 0, cacheCreate = 0, cacheRead = 0;
      let found = false;

      for (const file of fs.readdirSync(claudeDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const filePath = path.join(claudeDir, file);
        const stat = fs.statSync(filePath);
        // Skip files not touched during the agent's run window
        if (stat.mtimeMs < start - 5000) continue;

        const lines = fs.readFileSync(filePath, 'utf8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const record = JSON.parse(line);
            const ts = record.timestamp ? new Date(record.timestamp).getTime() : 0;
            if (ts < start - 5000 || ts > end + 5000) continue;
            const usage = record.message?.usage;
            if (!usage) continue;
            inputTokens  += usage.input_tokens || 0;
            outputTokens += usage.output_tokens || 0;
            cacheCreate  += usage.cache_creation_input_tokens || 0;
            cacheRead    += usage.cache_read_input_tokens || 0;
            found = true;
          } catch (_) {}
        }
      }

      if (!found) return null;

      const rates = TOKEN_COSTS[modelShortName] || TOKEN_COSTS.sonnet;
      const costUSD = (
        inputTokens  * rates.input       +
        outputTokens * rates.output      +
        cacheCreate  * rates.cacheCreate +
        cacheRead    * rates.cacheRead
      ) / 1_000_000;

      return { inputTokens, outputTokens, cacheCreate, cacheRead, costUSD: Math.round(costUSD * 10000) / 10000 };
    } catch (_) {
      return null;
    }
  }

  function trackLearningsEffectiveness(injectedLearnings, feedbackText) {
    if (!injectedLearnings || injectedLearnings.length === 0 || !feedbackText) return;
    const stats = loadLearningsStats();

    // Self-reported usage: agents that received a Known Learnings block are asked
    // to include `**Learnings applied:** <titles | none>` in their feedback.
    // This replaces the old keyword-citation heuristic (≥2 title-word hits in
    // feedback prose), which "cited" 67% of 81k injections on coincidence and
    // made effectiveness unmeasurable.
    const appliedLine = feedbackText.match(/\*\*Learnings applied:\*\*\s*([^\n]+)/i);
    const appliedRaw = appliedLine ? appliedLine[1].toLowerCase() : '';
    const appliedIsNone = /^\s*[-"'`]*none/.test(appliedRaw);

    for (const l of injectedLearnings) {
      const key = l.title.toLowerCase();
      if (!stats.entries[key]) {
        stats.entries[key] = { title: l.title, severity: l.severity, domain: l.domain, timesInjected: 0, timesApplied: 0, injectionsSinceApplied: 0, lastSeen: null, lastApplied: null };
      }
      const entry = stats.entries[key];
      // Legacy fields from the keyword era (timesCited/recurrences) are left
      // untouched on old entries; new counters start from this deploy.
      if (entry.timesApplied === undefined) entry.timesApplied = 0;
      if (entry.injectionsSinceApplied === undefined) entry.injectionsSinceApplied = 0;
      entry.timesInjected++;
      entry.lastSeen = new Date().toISOString();

      // Match: the applied line names this learning (normalized substring either
      // direction, so truncated or slightly-reworded titles still count).
      const norm = (s) => s.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
      const normTitle = norm(key);
      const applied = !appliedIsNone && appliedRaw && (norm(appliedRaw).includes(normTitle) || normTitle.length > 20 && norm(appliedRaw).includes(normTitle.slice(0, 40)));
      if (applied) {
        entry.timesApplied++;
        entry.injectionsSinceApplied = 0;
        entry.lastApplied = entry.lastSeen;
      } else {
        entry.injectionsSinceApplied++;
      }
    }

    saveLearningsStats(stats);
  }

  // Archive learnings that keep being injected but never get applied. Runs when
  // capture_learnings completes — low frequency, and by then the run's feedback
  // has already updated the stats. Only project-tier and cross-project files are
  // eligible (builtins ship with the tool). Files move to <dir>/_archive/<domain>/
  // so nothing is lost — restore by moving back.
  const LEARNINGS_ARCHIVE_THRESHOLD = 30; // injections without a single "applied"
  function archiveStaleLearnings() {
    const moved = [];
    let movedInProject = false;
    try {
      const stats = loadLearningsStats();
      const { LEARNINGS_DIR } = require('@build-studio/shared/constants');
      const allDomains = Object.values(ROLE_DOMAIN_MAP).flat();
      const domains = [...new Set(allDomains)];
      const projectLearningsDir = path.join(projectRoot, 'docs/learnings');
      for (const baseDir of [projectLearningsDir, LEARNINGS_DIR]) {
        for (const l of scanLearningsDir(baseDir, domains)) {
          const entry = stats.entries[l.title.toLowerCase()];
          if (!entry || !entry.injectionsSinceApplied) continue;
          if (entry.injectionsSinceApplied < LEARNINGS_ARCHIVE_THRESHOLD) continue;
          const archiveDir = path.join(baseDir, '_archive', l.domain);
          fs.mkdirSync(archiveDir, { recursive: true });
          fs.renameSync(l.path, path.join(archiveDir, path.basename(l.path)));
          moved.push(`${l.domain}/${path.basename(l.path)}`);
          if (baseDir === projectLearningsDir) movedInProject = true;
        }
      }
      if (moved.length > 0) console.log(`[learnings] archived ${moved.length} stale entries (≥${LEARNINGS_ARCHIVE_THRESHOLD} injections, never applied): ${moved.join(', ')}`);
      // Commit the project-tier moves. renameSync alone leaves the project git
      // tree dirty (deletions + untracked _archive files) — it accumulates run
      // over run and reads as "learnings not getting checked in". The
      // cross-project LEARNINGS_DIR is not a git repo, so nothing to commit there.
      // Runs post-merge (capture_learnings is after merge_to_main), so the
      // checkout is on the default branch — the right place for these doc moves.
      if (movedInProject) {
        try {
          const { execFileSync } = require('child_process');
          execFileSync('git', ['add', '-A', 'docs/learnings'], { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] });
          execFileSync('git', ['commit', '-m', `docs(learnings): archive ${moved.length} stale never-applied entr${moved.length === 1 ? 'y' : 'ies'}`], { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] });
          console.log(`[learnings] committed archive moves to docs/learnings`);
        } catch (ce) {
          console.log(`[learnings] archive commit failed (moves left uncommitted): ${ce.message}`);
        }
      }
    } catch (e) {
      console.log(`[learnings] archive sweep failed (non-fatal): ${e.message}`);
    }
    return moved;
  }

  /**
   * Unified fix flow: collect feedback from a failing step, launch the planner
   * to create targeted fix tasks, then execute them one by one with code review.
   *
   * Used by: code_review, qa_validation, ac_verification, security_audit, demo_review
   * send_to_devs handlers.
   */
  function launchFixPlan(wf, sourceStep, feedback, notes, prdId) {
    wf.steps[sourceStep].status = 'completed';
    wf.currentStep = 'fix_plan';
    wf.fixSource = sourceStep; // track where the fix originated

    const roleList = (config.roles.execution || []).map(r => `- ${r.role} (/${r.skill})`).join('\n');
    const plannerAgent = [{
      role: 'Fix Planner', window: 'fix-planner', status: 'pending', reportFeedback: true,
      instruction: `## YOU ARE A FIX PLANNER — NOT A FIX EXECUTOR — READ THIS FIRST

**Your job is to produce a JSON plan of fix tasks based on the review feedback below. You do NOT write code. You do NOT fix bugs yourself. You do NOT run tests. Each task in your plan is dispatched to a separate Dev agent for execution.**

**FORBIDDEN FEEDBACK FORMAT** — your feedback will be REJECTED if you use any of these patterns:
- \`**All issues addressed:** yes|no\` / \`**Committed:** <hash>\` / \`### Changes\` (fix-report format — you plan fixes, you don't execute them)
- \`**Approved:** yes|no\` / \`**Blocking:** N\` / \`### Findings\` (review format — you are not re-reviewing; you trust the upstream review and plan against it)
- Any phrasing that implies you made code changes or ran tests

**REQUIRED FEEDBACK FORMAT** — your feedback MUST contain a \`\`\`json code block with a \`tasks\` array. Each task object specifies the fix to make + the role to assign it to. The workflow parses this JSON and launches one Dev agent per task. Plain text or prose-only feedback will be rejected.

**IF THE UPSTREAM FEEDBACK IS EMPTY OR AMBIGUOUS:** Output \`{ "tasks": [] }\` and explain in a short prose note why no fix tasks are needed (or why the feedback was unparseable). The workflow handles 0-task plans as "no fixes needed" and advances to the next step.

---

PRD path: ${wf.prdPath}

Use the /fix_planner skill. A post-implementation review step ("${sourceStep}") found blocking issues.

## Available execution roles:
${roleList}

**CHOOSING THE RIGHT ROLE PER TASK.** When multiple execution roles are
listed above, the right role for each task is determined by the FILES the
task will modify — NOT by which role ran the original task_execution.
Mapping:
- Swift / SwiftUI / iOS APIs / \`.xcodeproj\` / iOS test targets / \`.entitlements\` / \`PrivacyInfo.xcprivacy\` / \`Info.plist\` → \`/ios_dev\`
- HTML / CSS / JS / TS / React / Svelte / Vue / Astro / Vite / Tailwind / web frameworks → \`/frontend_dev\`
- Server code (Node/Go/Python backends), SQL migrations, API contracts, server-side auth → \`/backend_dev\`
- Kotlin / Jetpack Compose / Android Studio → \`/android_dev\`
- Infrastructure-as-code, CI YAML, Docker / Kubernetes → \`/devops\`

If a task touches files predominantly owned by one role, assign that role.
Cross-cutting work goes to the role whose conventions cover the MAJORITY
of the change. **Do not default to whichever role ran the previous
task_execution.** The fix loop is the right place to correct mis-assigned
work — if task_execution ran as Frontend Dev but the actual fix is in
Swift files, the fix task assignment is iOS Dev.

## Feedback from ${sourceStep}

${feedback}
${notes ? `\n## User Notes\n\n${notes}` : ''}

Analyze the feedback and produce a JSON fix plan. Your final output MUST include a \`\`\`json code block containing a "tasks" array — this is machine-parsed.

${EFFICIENCY_INSTRUCTIONS}`,
    }];
    wf.steps.fix_plan = { status: 'running', agents: launchWorkflowAgents(wf, plannerAgent, { useWorktrees: false }) };
    state.saveWorkflow(wf);
  }

  // Launcher artifacts (start-*.sh, prompt-*.txt, goal-*.txt) are written into
  // the agent's working directory, which is a git checkout — agents have
  // committed them by accident (EX-157's builder committed its goal file, then
  // spent a commit removing it). Register them in the repo-local exclude file
  // (.git/info/exclude — shared by all worktrees, never committed) instead of
  // the project's .gitignore. Patterns are root-anchored so a legitimate
  // project file like docs/prompt-library.txt is never masked.
  // Also exclude Build Studio's runtime state. It lives inside the repo
  // (.build-studio/ next to the tracked config.yaml), and a project whose
  // .gitignore doesn't cover it (onboarded repos, projects migrated from
  // older config-dir names) otherwise trips the merge gate — or worse, gets
  // snapshots committed by an agent's git add -A. Deliberately NOT the whole
  // .build-studio/ dir: config.yaml is tracked and its changes must stay
  // visible. Unanchored so the patterns hold in every worktree.
  const LAUNCHER_EXCLUDE_PATTERNS = [
    '/start-*.sh', '/prompt-*.txt', '/goal-*.txt',
    '.build-studio/workflow-state.json',
    '.build-studio/run-state.json',
    '.build-studio/snapshots/',
    '.build-studio/support/',
    '.build-studio/*.bak*',
  ];
  function ensureLauncherArtifactsIgnored(agentCwd) {
    try {
      const { execFileSync } = require('child_process');
      const excludeRel = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
        cwd: agentCwd, encoding: 'utf8', timeout: 5000,
      }).trim();
      const excludePath = path.isAbsolute(excludeRel) ? excludeRel : path.join(agentCwd, excludeRel);
      let current = '';
      try { current = fs.readFileSync(excludePath, 'utf8'); } catch (_) {}
      const lines = new Set(current.split('\n').map(l => l.trim()));
      const missing = LAUNCHER_EXCLUDE_PATTERNS.filter(p => !lines.has(p));
      if (missing.length === 0) return;
      fs.mkdirSync(path.dirname(excludePath), { recursive: true });
      const sep = current && !current.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(excludePath, `${sep}# build-studio launcher artifacts (auto-added)\n${missing.join('\n')}\n`);
    } catch (_) {
      // Best-effort: a non-git cwd or missing git must never block agent launch.
    }
  }

  function launchWorkflowAgents(wf, agents, { useWorktrees = false, allowAll = true, cwd = projectRoot, stepKey = null } = {}) {
    console.log(`[workflow] Launching ${agents.length} agents for step=${wf.currentStep} round=${wf.round} model=${resolveModel(stepKey || wf.currentStep, wf)}`);
    fs.mkdirSync(worktreesPath, { recursive: true });
    fs.mkdirSync(logsPath, { recursive: true });

    // Pre-launch guard: verify required CLI binaries are reachable from the same
    // env the spawned start-*.sh scripts will use (zsh + brew shellenv). Without
    // this, a missing binary makes the script die silently with "command not
    // found" and the agent sits in 'running' state until the 15-min idle
    // watchdog notices.
    //
    // For each binary: first try the same `zsh -c 'eval brew shellenv;
    // command -v <bin>'` the start scripts use. If that fails, fall back to a
    // direct existence check on known absolute paths — the project-server's
    // spawn env may not have zsh on PATH, but the start script itself is
    // invoked via `bash` + an explicit zsh shebang, so a literal binary is
    // enough to rule out a real install gap.
    const { execFileSync } = require('child_process');
    function probeBinary(bin, installHint) {
      let zshErrDetail = '';
      try {
        execFileSync('zsh', ['-c', `eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null; command -v ${bin} >/dev/null`], { stdio: 'pipe' });
        return null;
      } catch (e) {
        zshErrDetail = e && (e.stderr ? e.stderr.toString().trim() : '') || (e && e.message) || '';
      }
      const candidates = [
        `/opt/homebrew/bin/${bin}`,
        `/usr/local/bin/${bin}`,
        `${process.env.HOME || ''}/.npm-global/bin/${bin}`,
        `${process.env.HOME || ''}/.local/bin/${bin}`,
      ];
      const found = candidates.find(p => p && fs.existsSync(p));
      if (found) {
        console.warn(`[workflow] zsh pre-launch probe for ${bin} failed (${zshErrDetail || 'no detail'}), but binary present at ${found} — proceeding.`);
        return null;
      }
      return `${bin} binary not found. zsh check: ${zshErrDetail || 'failed (zsh may not be on PATH for this process)'}. Looked at: ${candidates.filter(Boolean).join(', ')}. ${installHint}`;
    }

    // Determine whether claude / codex are actually needed by this batch.
    const batchNeedsClaude = agents.some(a => {
      if (isDeveloperRole(a.role)) return wf.developerCli !== 'codex';
      if (isReviewerRole(a.role)) return !reviewerOnCodex(wf, a.role);
      return true; // every other role is always claude
    });
    const batchNeedsCodex = agents.some(a => {
      if (isDeveloperRole(a.role)) return wf.developerCli === 'codex';
      if (isReviewerRole(a.role)) return reviewerOnCodex(wf, a.role);
      return false;
    });

    let cliError = null;
    if (batchNeedsClaude) {
      cliError = probeBinary('claude', 'Install with `npm i -g @anthropic-ai/claude-code` or verify `which claude` from a normal shell.');
    }
    if (!cliError && batchNeedsCodex) {
      cliError = probeBinary('codex', 'Install with `npm i -g @openai/codex` or verify `which codex` from a normal shell.');
    }
    if (cliError) {
      console.error(`[workflow] Pre-launch check failed: ${cliError}`);
      const failed = agents.map(a => ({ ...a, status: 'error', error: cliError }));
      return failed;
    }

    let sessionCreated = tmuxOps.hasSession(wf.sessionName);
    const results = [];
    const dashboardPort = config.port;
    const { resolvePermissionMode, claudePermissionFlag } = require('../permission-mode');
    const permissionMode = resolvePermissionMode(config.agent_defaults);
    const unsetKey = config.agent_defaults.unset_api_key;
    const resolvedStep = stepKey || wf.currentStep;
    const modelShortName = (wf.stepModelOverrides && wf.stepModelOverrides[resolvedStep])
      || (config.step_models && config.step_models[resolvedStep])
      || config.agent_defaults.model || 'opus';
    const modelId = MODEL_IDS[modelShortName] || modelShortName;

    // Effort level for Claude's adaptive thinking. Valid CLI values: low,
    // medium, high (default), xhigh (Opus-only deep-reasoning mode), max.
    // Configure via `step_efforts: { task_execution: xhigh }` for per-step
    // control, or `agent_defaults.effort` for a global default. Omit to use
    // Claude Code's own default (high). See docs/experiments/prd-009-
    // orchestration-model-matrix.md for the use case driving this.
    const effortLevel = (wf.stepEffortOverrides && wf.stepEffortOverrides[resolvedStep])
      || (config.step_efforts && config.step_efforts[resolvedStep])
      || (config.agent_defaults && config.agent_defaults.effort)
      || null;

    for (const agent of agents) {
      const branch = agent.branch;
      let agentCwd = cwd;

      if (useWorktrees && branch) {
        try {
          agentCwd = gitOps.createWorktree(branch);
        } catch (e) {
          agent.status = 'error';
          agent.error = `Worktree: ${e.message}`;
          results.push(agent);
          continue;
        }
      }

      const taskIndexParam = agent.taskIndex !== undefined ? `,"taskIndex":${agent.taskIndex}` : '';
      const isPlanner = ['Planner', 'Fix Planner'].includes(agent.role);
      const isFixPlanner = agent.role === 'Fix Planner';
      const plannerFeedbackHint = isFixPlanner
        ? `the feedback field must contain your complete \`\`\`json code block — this is machine-parsed`
        : `the feedback field must contain your FULL task plan output — either the complete \`\`\`json code block OR the full markdown task list with ### Role headers and numbered tasks. Do NOT summarise — paste the actual plan`;
      const feedbackCurl = agent.reportFeedback
        ? isPlanner
          ? `\n\nWhen you are done, report your feedback by running (${plannerFeedbackHint}):\ncurl -s -X POST http://localhost:${dashboardPort}/api/workflow/feedback -H 'Content-Type: application/json' -d '{"role":"${agent.role}"${taskIndexParam},"feedback":"<paste full plan here>"}'`
          : `\n\nWhen you are done, report your feedback by running:\ncurl -s -X POST http://localhost:${dashboardPort}/api/workflow/feedback -H 'Content-Type: application/json' -d '{"role":"${agent.role}"${taskIndexParam},"feedback":"<your structured feedback here>"}'`
        : '';

      // Build feedback history from previous rounds
      const history = buildFeedbackHistory(wf);

      // Inject known learnings for this role, scored by relevance to current task
      const taskDesc = `${wf.input || ''} ${agent.instruction || ''}`;
      const learningsResult = (config.learnings && config.learnings.enabled === false)
        ? { text: '', injected: [] }
        : buildLearningsContext(agent.role, taskDesc);

      const useCodex =
        (isDeveloperRole(agent.role) && wf.developerCli === 'codex') ||
        reviewerOnCodex(wf, agent.role);
      // Claude gets --permission-mode (default resolves to 'auto': no routine
      // prompts, classifier-reviewed). Codex has no classifier equivalent, so
      // for the never-prompt intents (auto/bypassPermissions) it keeps its
      // bypass flag; restrictive modes leave Codex prompting (attended only).
      const dangerFlag = useCodex
        ? (['auto', 'bypassPermissions'].includes(permissionMode) ? ' --dangerously-bypass-approvals-and-sandbox' : '')
        : claudePermissionFlag(permissionMode);
      // Append efficiency + structured feedback instructions to ALL agents
      // (skip if already present in the instruction to avoid duplication)
      const hasEfficiency = agent.instruction.includes('CONTEXT BUDGET');
      const hasFeedback = agent.instruction.includes('FEEDBACK FORMAT');
      // Planner and fix_planner output JSON — don't inject the review feedback format
      const extraInstructions = `${hasEfficiency ? '' : EFFICIENCY_INSTRUCTIONS}${(hasFeedback || isPlanner) ? '' : STRUCTURED_FEEDBACK_INSTRUCTIONS}`;
      // Replace the {{CONTEXT_BUDGET}} / {{SOFT_THRESHOLD}} placeholders with
      // values resolved from the actual model assigned to this agent — keeps
      // the prompts accurate when a project bumps to opus[1m] / sonnet[1m] or
      // when Codex (which has its own ~258K window) is the implementer.
      const ctx = contextBudgetFor(modelId, useCodex);
      const interpolate = (s) => s.replace(/\{\{CONTEXT_BUDGET\}\}/g, ctx.budget).replace(/\{\{SOFT_THRESHOLD\}\}/g, ctx.softThreshold);
      const prompt = interpolate(`${agent.instruction}${extraInstructions}${learningsResult.text}${history}${feedbackCurl}`);

      const baseWindow = (agent.window || agent.role).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 12).replace(/-+$/, '');
      const windowName = wf.round > 1 ? `${baseWindow}-r${wf.round}` : baseWindow;

      const scriptName = `start-${windowName}.sh`;
      const promptFileName = `prompt-${windowName}.txt`;
      // Codex chooses its own model — only Claude takes --model from step_models.
      const modelFlag = (!useCodex && modelId) ? ` --model ${modelId}` : '';
      // Codex has no effort-equivalent CLI flag; only Claude takes --effort.
      const effortFlag = (!useCodex && effortLevel) ? ` --effort ${effortLevel}` : '';
      const cliBin = useCodex ? 'codex' : 'claude';
      // Pin the Claude session id at launch so a killed agent process can be
      // auto-resumed WITH its context (`claude --resume <id>` — see the
      // agent-recovery monitor in server.js). Codex has no resume equivalent.
      const cliSessionId = useCodex ? null : require('crypto').randomUUID();
      const cliInvocation = useCodex
        ? `codex exec${dangerFlag} "$(cat '${promptFileName}')"`
        : `claude --session-id ${cliSessionId}${dangerFlag}${modelFlag}${effortFlag} "$(cat '${promptFileName}')"`;
      // Write prompt to a separate file to avoid shell escaping issues with backticks, quotes, etc.
      fs.writeFileSync(path.join(agentCwd, promptFileName), prompt, 'utf-8');
      ensureLauncherArtifactsIgnored(agentCwd);

      // builder_strategy=goal: /goal has no CLI flag — it must be typed into
      // the live session. The start script backgrounds a delayed tmux paste of
      // the goal file: by then the CLI has booted and is processing the initial
      // prompt, and the pasted line queues as the next input. The goal file has
      // NO trailing newline — the explicit Enter keypress submits it. Failure
      // mode is benign: if the paste ever lands as plain text instead of a
      // command, the agent just reads the done condition as one more instruction.
      let goalArmLine = '';
      if (agent.goalCondition && !useCodex) {
        const goalFileName = `goal-${windowName}.txt`;
        fs.writeFileSync(path.join(agentCwd, goalFileName), `/goal ${agent.goalCondition}`, 'utf-8');
        goalArmLine = `( sleep 25; tmux load-buffer -b goal-${windowName} '${goalFileName}'; tmux paste-buffer -d -b goal-${windowName} -t "$TMUX_PANE"; sleep 1; tmux send-keys -t "$TMUX_PANE" Enter ) &\n`;
      }
      // Resolve CLI binary defensively: try `brew shellenv` first, then fall
      // back to the literal absolute path if PATH still doesn't contain it.
      // This avoids "<cli>: command not found" when the spawning shell inherits
      // a sanitized PATH (intermittent under Electron + tmux windows that don't
      // load the user's interactive shell config).
      //
      // G3: For iOS projects with `simulator.destination` in config, export
      // BUILD_STUDIO_SIMULATOR_DESTINATION so the agent uses a single stable sim
      // across tasks. Stable destination = booted-sim reuse = warm
      // DerivedData = ~3x faster xcodebuild runs. Variable name is project-
      // generic on purpose (any simulator-bearing project picks the same
      // convention).
      const simDest = config.simulator && config.simulator.destination;
      // For iOS projects, also expose the concurrency-safe XCTest clone reaper so
      // the QA agent can clean up leaked parallel-testing clones (see the
      // iOS-SPECIFIC PROTECTIONS block). Reaper only touches Shutdown+idle clones,
      // so it's safe to run while another project is mid-test.
      const xctestCleanScript = path.join(__dirname, '..', 'xctest-clean.js');
      const simEnvLine = simDest
        ? `export BUILD_STUDIO_SIMULATOR_DESTINATION=${JSON.stringify(simDest)}\n` +
          `export XCTEST_CLEAN=${JSON.stringify(xctestCleanScript)}\n`
        : '';
      // Unset PORT before launching the agent. The Electron hub runs on
      // PORT=18080; that value propagates hub → project-server → tmux server →
      // agent shell. If an agent then starts a project dev server to test its
      // work (e.g. `tsx src/index.ts`, whose port is `process.env.PORT ?? 4000`),
      // it inherits PORT=18080 and binds the HUB's port — colliding on IPv4
      // 127.0.0.1:18080 and serving JSON where the renderer expects the hub
      // (the "Pretty print" black screen). The workflow's own dev servers set
      // PORT explicitly and are unaffected; this only stops the stray
      // inheritance for agent-started processes.
      const startScript = `#!/bin/zsh
eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null
unset PORT
if ! command -v ${cliBin} >/dev/null 2>&1; then
  for p in /opt/homebrew/bin /usr/local/bin "$HOME/.npm-global/bin" "$HOME/.local/bin"; do
    if [ -x "$p/${cliBin}" ]; then PATH="$p:$PATH"; break; fi
  done
fi
${simEnvLine}${goalArmLine}${cliInvocation}
`;
      // Pre-trust project-scoped MCP servers so Claude Code's interactive
      // "New MCP server found in this project" prompt can't stall the agent.
      require('../claude-settings').ensureMcpAutoApprove(agentCwd);
      fs.writeFileSync(path.join(agentCwd, scriptName), startScript, { mode: 0o755 });

      // Agent-recovery artifacts (claude only): a pre-written resume script the
      // monitor (server.js) fires into the pane's surviving shell when the
      // agent PROCESS dies (SIGKILL under memory pressure, daemon-crash
      // fallout, CLI update — launch-studio PRD-010 qa_validation, 2026-07-17).
      // Everything recovery needs is captured here at launch; the pane's shell
      // keeps sitting in agentCwd after the process dies, so `bash <script>`
      // resolves relative paths, and --resume restores the pinned session's
      // full conversation context.
      if (!useCodex) {
        const resumePromptFile = `prompt-resume-${windowName}.txt`;
        const resumeScriptName = `start-${windowName}-resume.sh`;
        fs.writeFileSync(path.join(agentCwd, resumePromptFile),
          'Your CLI process was killed mid-run by an external event (system pressure, a crash, or an update) and this session has been resumed automatically with your context intact. Re-establish your bearings first: check the working tree and the outcome of whatever command was running when you were killed (it may have been interrupted or may have completed), then continue your assigned task from where you left off. Your original instructions — including reporting your structured feedback via the curl POST at the end — still apply in full.', 'utf-8');
        const resumeScript = `#!/bin/zsh
eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null
unset PORT
${unsetKey ? 'unset ANTHROPIC_API_KEY\n' : ''}if ! command -v claude >/dev/null 2>&1; then
  for p in /opt/homebrew/bin /usr/local/bin "$HOME/.npm-global/bin" "$HOME/.local/bin"; do
    if [ -x "$p/claude" ]; then PATH="$p:$PATH"; break; fi
  done
fi
${simEnvLine}claude --resume ${cliSessionId}${dangerFlag}${modelFlag}${effortFlag} "$(cat '${resumePromptFile}')"
`;
        fs.writeFileSync(path.join(agentCwd, resumeScriptName), resumeScript, { mode: 0o755 });
        agent.cliSessionId = cliSessionId;
        agent.resumeScript = resumeScriptName;
      }

      const logFile = path.join(logsPath, `${windowName}-${wf.id}.log`);
      const keyUnset = unsetKey ? 'unset ANTHROPIC_API_KEY && ' : '';

      try {
        let target;
        if (!sessionCreated) {
          tmuxOps.createSession(wf.sessionName, windowName, projectRoot);
          sessionCreated = true;
          target = `${wf.sessionName}:${windowName}`;
        } else {
          const idx = tmuxOps.createWindow(wf.sessionName, windowName, projectRoot);
          target = `${wf.sessionName}:${idx}`;
        }
        tmuxOps.sendKeys(target, `cd '${agentCwd}' && ${keyUnset}bash ${scriptName}`, projectRoot);
        tmuxOps.pipePaneToLog(target, logFile, projectRoot);
      } catch (e) {
        agent.status = 'error';
        agent.error = `tmux: ${e.message}`;
        results.push(agent);
        continue;
      }

      agent.window = windowName;
      agent.status = 'running';
      agent.model = useCodex ? 'codex' : modelShortName;
      agent.startedAt = new Date().toISOString();
      agent.agentCwd = agentCwd;
      agent.injectedLearnings = learningsResult.injected;
      results.push(agent);

      // Stagger launches to avoid simultaneous API cold-start collisions
      if (agents.indexOf(agent) < agents.length - 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
      }
    }

    return results;
  }

  // --- Helpers ---

  // Walk the Companion Specs table in a PRD and mark rows as Done when their
  // spec file exists on disk. Locates the section by heading text (any
  // "## … Companion Spec[s] …" heading), regardless of section number — example-site
  // PRDs put it at §6, example-web at §10, others may differ.
  function updateCompanionSpecsInPrd(prdAbsPath) {
    if (!fs.existsSync(prdAbsPath)) return;
    try {
      const content = fs.readFileSync(prdAbsPath, 'utf8');
      let csMatch = content.match(/^##\s+[^\n]*\bcompanion\s+specs?\b[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/im);
      if (!csMatch) csMatch = content.match(/## 10[.\s].*?\n([\s\S]*?)(?=\n## \d|$)/m);
      if (!csMatch) return;

      let changed = false;
      const updatedContent = content.replace(
        /(\|[^|\n]+\|[^|\n]+\|)(\s*`?([^`|\n]+)`?\s*)(\|\s*\*{0,2}(?:pending|required)\*{0,2}\s*\|)/gi,
        (match, specOwner, fileCell, filePath, statusCell) => {
          const trimmed = filePath.trim();
          if (!trimmed) return match;
          const absFile = path.join(projectRoot, trimmed);
          if (fs.existsSync(absFile)) {
            changed = true;
            return `${specOwner}${fileCell}| Done |`;
          }
          return match;
        }
      );

      if (changed) {
        fs.writeFileSync(prdAbsPath, updatedContent, 'utf8');
        console.log(`[workflow] Updated §10 companion spec statuses in ${path.basename(prdAbsPath)}`);
        try {
          const { execFileSync } = require('child_process');
          execFileSync('git', ['add', prdAbsPath], { cwd: projectRoot });
          execFileSync('git', ['commit', '-m', `docs: mark companion specs as Done in ${path.basename(prdAbsPath)} §10`], { cwd: projectRoot });
        } catch (e) {
          console.log(`[workflow] Could not commit §10 update: ${e.message}`);
        }
      }
    } catch (e) {
      console.log(`[workflow] updateCompanionSpecsInPrd failed: ${e.message}`);
    }
  }

  function markPrdDone(prdInput) {
    const psFile = path.join(docsPath, 'project-state.md');
    if (!fs.existsSync(psFile)) return;
    const original = fs.readFileSync(psFile, 'utf8');
    let content = original;
    const prdId = prdInput.replace(/\s+/g, '-');
    const today = new Date().toISOString().slice(0, 10);

    // ---- Backlog table row update ----
    // The previous regex assumed a specific column order (PRD column immediately
    // followed by status column with one of `**Active**` / `**In Progress**` /
    // `**PRD Ready**` / `Pending`). Real projects vary: Status usually comes
    // BEFORE the PRD column, and some projects (e.g. example-ios) use narrative
    // status text like `**Active — Preparation.** PRD-002 drafted ...`.
    //
    // New approach: walk rows under `## Backlog`, find any row containing the
    // PRD ID with word-boundary, then locate its status cell by scanning for
    // an "active-status" keyword regardless of column position. Replace that
    // cell with a compact "Done" line.
    const ACTIVE_PATTERNS = [
      /\*\*Active\b/i,            // **Active**, **Active — Preparation**, etc.
      /\*\*In Progress\*\*/i,
      /\*\*PRD Ready\*\*/i,
      /\*\*Preparation\b/i,
      /\bPending\b/,
    ];
    const lines = content.split('\n');
    const prdIdRe = new RegExp(`\\b${prdId}\\b`, 'i');
    let inBacklog = false;
    let backlogRowChanged = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^##\s+Backlog\b/i.test(lines[i])) { inBacklog = true; continue; }
      if (inBacklog && /^##\s+/.test(lines[i]) && !/^##\s+Backlog\b/i.test(lines[i])) {
        inBacklog = false;
      }
      if (!inBacklog) continue;
      if (!lines[i].startsWith('|')) continue;
      // Skip header + separator lines
      if (/^\|\s*[-:|\s]+\s*$/.test(lines[i])) continue;
      if (!prdIdRe.test(lines[i])) continue;

      // Split into cells. A line like `| a | b | c |` yields ['', ' a ', ' b ', ' c ', ''].
      const cells = lines[i].split('|');
      let statusIdx = -1;
      for (let c = 1; c < cells.length - 1; c++) {
        if (ACTIVE_PATTERNS.some(p => p.test(cells[c]))) { statusIdx = c; break; }
      }
      if (statusIdx === -1) continue;
      cells[statusIdx] = ` **Done.** ${prdId} shipped ${today}. `;
      lines[i] = cells.join('|');
      backlogRowChanged = true;
    }
    if (backlogRowChanged) content = lines.join('\n');

    // ---- Active PRD section update ----
    // Replace the first bullet under `## Active PRD`. If that section is
    // structured with multiple paragraphs (example-ios), only the lead bullet is
    // touched — subsections like "Completed prep work" and "Deferred" stay.
    const activePrdPattern = /^(## Active PRD\n+)(.*)$/m;
    if (activePrdPattern.test(content)) {
      content = content.replace(activePrdPattern, `$1None — ${prdId} complete. Next: scope next PRD.`);
    }

    // ---- Phase line + Last updated ----
    content = content.replace(
      /- \*\*Phase:\*\* Phase (\d+) — Iteration (\d+) complete\..*/,
      (match, phase, iter) => `- **Phase:** Phase ${phase} — Iteration ${parseInt(iter, 10) + 1} complete. ${prdId} done.`
    );
    content = content.replace(/- \*\*Last updated:\*\* \d{4}-\d{2}-\d{2}/, `- **Last updated:** ${today}`);

    if (content === original) {
      console.log(`[workflow] markPrdDone(${prdId}): no changes to project-state.md (no active row matched + no Active PRD/Phase update applied)`);
      return;
    }
    fs.writeFileSync(psFile, content);

    // Commit the change so it lands on main alongside the merge.
    try {
      const { execFileSync } = require('child_process');
      execFileSync('git', ['add', psFile], { cwd: projectRoot });
      execFileSync('git', [
        'commit',
        '-m',
        `chore(${prdId.toLowerCase()}): mark ${prdId} done in project-state.md`,
      ], { cwd: projectRoot });
      console.log(`[workflow] markPrdDone(${prdId}): backlog${backlogRowChanged ? ' row updated' : ' row unchanged'}, project-state.md committed`);
    } catch (e) {
      console.log(`[workflow] markPrdDone(${prdId}): wrote project-state.md but commit failed: ${e.message}`);
    }
  }

  // --- Orchestrator/Sequential review mode ---
  function launchOrchestratorReview(wf, reviewRoles, prdPath, feedbackDir) {
    const mode = wf.reviewMode || config.review_mode || 'parallel';
    fs.mkdirSync(feedbackDir, { recursive: true });

    const roleList = reviewRoles.map(r =>
      `- **${r.role}**: Read .claude/commands/${r.command}, review from this perspective, write feedback to ${feedbackDir}/${r.role.toLowerCase().replace(/\s+/g, '-')}-feedback.md`
    ).join('\n');

    const docRef = prdPath
      ? `Read the PRD at ${prdPath}.`
      : `Read docs/vision.md and any PRDs in docs/prds/.`;

    const companionScopeNote = `\n\n## SCOPE NOTE — pass this to every subagent/perspective\n\nCompanion-spec files (UX-XXX, ADRs, copy specs, anything in docs/ux/, docs/brand/, docs/adrs/, etc.) are written and refined in the dedicated \`companion_specs\` step that runs AFTER this PRD review approves. Reviewers must NOT raise BLOCKING findings about missing or incomplete content inside companion-spec files — those gaps will be closed by the spec owner in the next step. Surface them as NON-BLOCKING action items targeted at the \`companion_specs\` step.`;
    let instruction;
    if (mode === 'orchestrator') {
      instruction = `You are a review orchestrator. ${docRef}\n\nLaunch parallel subagents (using the Agent tool) for each reviewer role below. Each subagent should read its role command file, review the document, and write structured feedback to its feedback file.\n\nRoles:\n${roleList}${companionScopeNote}\n\nAfter all subagents complete, report a summary of all feedback via curl:\ncurl -s -X POST http://localhost:${config.port}/api/workflow/feedback -H 'Content-Type: application/json' -d '{"role":"Orchestrator","feedback":"<combined summary of all role feedback>"}'`;
    } else {
      // Sequential mode
      instruction = `You are reviewing a document from multiple perspectives. ${docRef}\n\nFor EACH role below, in order:\n1. Read the role command file at .claude/commands/<command>\n2. Review the document from that role's perspective\n3. Write structured feedback to the specified file\n\nRoles:\n${roleList}${companionScopeNote}\n\nAfter completing all reviews, report a combined summary via curl:\ncurl -s -X POST http://localhost:${config.port}/api/workflow/feedback -H 'Content-Type: application/json' -d '{"role":"Reviewer","feedback":"<combined summary of all role feedback>"}'`;
    }

    const agent = [{
      role: mode === 'orchestrator' ? 'Orchestrator' : 'Reviewer',
      window: 'review',
      status: 'pending',
      reportFeedback: true,
      instruction,
    }];

    return launchWorkflowAgents(wf, agent, { useWorktrees: false });
  }

  // Port offset for worktree dev servers to avoid conflicting with main branch dev servers.
  // Main branch uses default ports (e.g., backend:4000, frontend:5173).
  // Worktree servers use default + offset (e.g., backend:4100, frontend:5273).
  const WORKTREE_PORT_OFFSET = 100;

  function startDevServers(wf, worktreePath) {
    const devCmds = config.dev_commands || [];
    if (devCmds.length === 0) return;

    console.log(`[workflow] Starting ${devCmds.length} dev server(s) from ${worktreePath} (port offset: +${WORKTREE_PORT_OFFSET})`);
    let sessionExists = tmuxOps.hasSession(wf.sessionName);

    // Kill any existing dev server windows from a previous round — they may be
    // serving the wrong worktree and holding the port.
    // IMPORTANT: kill-window only kills the shell, not child processes. We must
    // also kill by port so the new server can actually bind.
    const { execFileSync: execKill } = require('child_process');
    if (sessionExists) {
      for (const dev of devCmds) {
        const windowName = `dev-${dev.name}`;
        const portMatch = dev.port || (dev.name === 'backend' ? 4000 : dev.name === 'frontend' ? 5173 : null);
        const wtPort = portMatch ? portMatch + WORKTREE_PORT_OFFSET : null;
        // killWindowAndChildren kills the tmux window AND any processes still holding the port
        tmuxOps.killWindowAndChildren(`${wf.sessionName}:${windowName}`, wtPort);
        if (wtPort) console.log(`[workflow] Killed dev server window ${windowName} and port ${wtPort}`);
      }
    } else {
      // Session doesn't exist yet but orphaned processes from a crashed previous run
      // may still hold the offset ports. Kill by port directly.
      for (const dev of devCmds) {
        const portMatch = dev.port || (dev.name === 'backend' ? 4000 : dev.name === 'frontend' ? 5173 : null);
        if (!portMatch) continue;
        const wtPort = portMatch + WORKTREE_PORT_OFFSET;
        tmuxOps.killWindowAndChildren(null, wtPort);
      }
    }
    // Brief pause for ports to be released
    try { execKill('sleep', ['1']); } catch (_) {}

    // Track the worktree ports so we can pass them to agents.
    // Two-pass: first compute all port assignments, then start servers so that
    // the frontend server can reference the backend worktree URL (BACKEND_URL).
    wf.devServerPorts = wf.devServerPorts || {};

    // Pass 1: compute all offset ports
    for (const dev of devCmds) {
      const portMatch = dev.port || (dev.name === 'backend' ? 4000 : dev.name === 'frontend' ? 5173 : null);
      if (portMatch) {
        wf.devServerPorts[dev.name] = portMatch + WORKTREE_PORT_OFFSET;
      }
    }

    // Pass 2: start each server with full env (PORT + BACKEND_URL for frontend)
    for (const dev of devCmds) {
      const windowName = `dev-${dev.name}`;
      const cwd = dev.cwd ? path.join(worktreePath, dev.cwd) : worktreePath;
      const target = `${wf.sessionName}:${windowName}`;

      let cmd = dev.cmd;
      const wtPort = wf.devServerPorts[dev.name];
      if (wtPort) {
        // Determine how to inject the port.
        // Vite ignores PORT= env var and requires --port CLI flag.
        // Other servers (node, tsx, next custom server) read PORT= env var.
        //
        // Priority: explicit config `type` field > package.json script resolution > command pattern.
        let isViteBased = false;
        if (dev.type === 'vite') {
          isViteBased = true;
        } else if (dev.type === 'node' || dev.type === 'custom') {
          isViteBased = false;
        } else {
          // Auto-detect: direct vite invocations
          if (/\bvite\b/.test(cmd) || /\bnpx vite\b/.test(cmd)) {
            isViteBased = true;
          } else {
            // npm run <script> or yarn <script> → resolve actual command via package.json
            const npmMatch = cmd.match(/^(?:npm run|yarn) (\S+)/);
            if (npmMatch) {
              try {
                const pkgPath = path.join(cwd, 'package.json');
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                const resolved = (pkg.scripts || {})[npmMatch[1]] || '';
                isViteBased = /\bvite\b/.test(resolved);
              } catch (_) {
                console.warn(`[workflow] warning: cannot read ${cwd}/package.json to resolve script "${npmMatch[1]}", defaulting to PORT= prefix`);
              }
            } else if (!/\b(node|tsx|ts-node|deno|bun|python|ruby|php)\b/.test(cmd)) {
              console.warn(`[workflow] warning: cannot determine server type for "${cmd}", defaulting to PORT= prefix`);
            }
          }
        }

        if (isViteBased) {
          cmd = `${cmd} -- --port ${wtPort}`;
        } else {
          cmd = `PORT=${wtPort} ${cmd}`;
        }
        console.log(`[workflow] ${dev.name} worktree port: ${wtPort} (${isViteBased ? '--port flag' : 'PORT= env'})`);
      }

      // Inject BACKEND_URL so vite's proxy target points to the worktree backend,
      // not the hardcoded main-branch port. Affects browser-initiated /api/* fetches.
      const backendPort = wf.devServerPorts.backend;
      if (dev.name === 'frontend' && backendPort) {
        cmd = `BACKEND_URL=http://localhost:${backendPort} ${cmd}`;
        console.log(`[workflow] frontend BACKEND_URL → http://localhost:${backendPort}`);
      }

      // Force development mode unless the command sets NODE_ENV itself. The tmux
      // server (and thus every window shell) can inherit NODE_ENV=production from
      // the packaged Electron/hub chain that spawned it — which flips QA worktree
      // backends into production mode (EX-159: prod-only guards 500'd registration,
      // session cookies got Domain=vlkmn.se and never returned on localhost).
      if (!/\bNODE_ENV=/.test(cmd)) {
        cmd = `NODE_ENV=development ${cmd}`;
      }

      try {
        if (!sessionExists) {
          tmuxOps.createSession(wf.sessionName, windowName, projectRoot);
          sessionExists = true;
        } else {
          tmuxOps.createWindow(wf.sessionName, windowName, projectRoot);
        }
        tmuxOps.sendKeys(target, `cd '${cwd}' && ${cmd}`, projectRoot);
      } catch (e) {
        console.error(`[workflow] Failed to start dev server ${dev.name}: ${e.message}`);
      }
    }

    // Wait a few seconds for servers to start
    const { execFileSync } = require('child_process');
    try { execFileSync('sleep', ['3']); } catch (_) {}
  }

  /**
   * Get the cwd for post-execution review agents.
   * In sequential execution, code is on the main branch — no review worktree exists yet.
   * Falls back to projectRoot if the review branch doesn't exist.
   */
  function resolveReviewCwd(prdId, reviewBranch) {
    try {
      const { execFileSync } = require('child_process');
      execFileSync('git', ['rev-parse', '--verify', reviewBranch], { cwd: projectRoot, stdio: 'ignore' });
      return ensureReviewWorktree(prdId, reviewBranch);
    } catch (_) {
      return projectRoot;
    }
  }

  function ensureReviewWorktree(prdId, reviewBranch) {
    const wtName = `review-${prdId}`;
    const wtPath = path.join(worktreesPath, wtName);
    if (!fs.existsSync(wtPath)) {
      fs.mkdirSync(worktreesPath, { recursive: true });
      const { execFileSync } = require('child_process');
      // The branch name has a slash (review/PRD-008) which may have created
      // a wrong worktree path. Remove any existing checkout of this branch first.
      try {
        execFileSync('git', ['worktree', 'remove', '--force', path.join(worktreesPath, reviewBranch)], { cwd: projectRoot, stdio: 'ignore' });
      } catch (_) {}
      // Also try pruning stale worktree entries
      try {
        execFileSync('git', ['worktree', 'prune'], { cwd: projectRoot, stdio: 'ignore' });
      } catch (_) {}
      try {
        execFileSync('git', ['worktree', 'add', wtPath, reviewBranch], { cwd: projectRoot, stdio: 'ignore' });
      } catch (e) {
        console.error(`[workflow] Failed to create review worktree: ${e.message}`);
      }
    }
    return wtPath;
  }

  // Stop agents without deleting branches — safe for cancel
  function stopWorkflow(wf) {
    if (wf.sessionName) tmuxOps.killSessionAndDevPorts(wf.sessionName, wf.devServerPorts);
    // Clean up generated start scripts from project root
    try {
      const files = fs.readdirSync(projectRoot);
      for (const f of files) {
        if ((f.startsWith('start-') && f.endsWith('.sh')) || (f.startsWith('prompt-') && f.endsWith('.txt'))) {
          fs.unlinkSync(path.join(projectRoot, f));
        }
      }
    } catch (_) {}
    // New branching strategy: if the run was on its own branch, return the checkout to
    // the default branch so it's never stranded on an abandoned run branch (and so the
    // branch can be deleted). Only when the tree is clean — never clobber uncommitted work.
    if (wf.branch) {
      try {
        const { execFileSync } = require('child_process');
        const run = (args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        const def = wf.defaultBranch || 'main';
        const cur = run(['branch', '--show-current']);
        const dirty = run(['status', '--porcelain']);
        if (cur === wf.branch && cur !== def && !dirty) run(['checkout', def]);
      } catch (e) { console.error('[workflow] stopWorkflow return-to-default:', e.message); }
    }
    state.deleteWorkflow();
  }

  // Full cleanup: remove worktrees and branches — only safe after merge to main
  function cleanupBranches(wf) {
    const branches = new Set();
    for (const step of Object.values(wf.steps || {})) {
      for (const agent of step.agents || []) {
        if (agent.branch) branches.add(agent.branch);
      }
    }
    // Sequential task execution — no per-task branches to clean up
    for (const branch of branches) gitOps.removeWorktree(branch);
    if (wf.reviewBranch) {
      try { gitOps.removeWorktree(`review-${wf.input.replace(/\s+/g, '-')}`); } catch (_) {}
      gitOps.deleteBranch(wf.reviewBranch, true);
    }
  }

  // Scan test files in `cwd` (committed diff vs `baseBranch`) for forbidden
  // patterns that would cause paid or networked LLM calls at test time.
  // Returns { violations: string[] } — caller decides how to surface.
  // Used by both the qa_tests approval gate and the merge_for_review gate so
  // task-execution tests can't bypass the check that only ran pre-implementation.
  function scanTestFilesForLlmViolations(cwd, baseBranch = 'main') {
    const violations = [];
    try {
      const { execFileSync } = require('child_process');
      const diffOutput = execFileSync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
        cwd, encoding: 'utf8', timeout: 10000,
      }).trim();
      const untrackedOutput = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd, encoding: 'utf8', timeout: 10000,
      }).trim();
      const allFiles = [...new Set([...diffOutput.split('\n'), ...untrackedOutput.split('\n')])].filter(f => f.trim());
      const testFiles = allFiles.filter(f => /\.(test|spec)\.(ts|js|tsx|jsx|mjs|cjs|mts|cts)$/.test(f));

      for (const relPath of testFiles) {
        const fullPath = path.join(cwd, relPath);
        let content;
        try { content = fs.readFileSync(fullPath, 'utf8'); } catch (_) { continue; }

        // BLOCK: Real LLM API URLs — unless the file is tagged @llm-url-fixture.
        // Legitimate exception: tests that assert a real endpoint is REJECTED
        // (e.g. an EU-residency guard test sets LLM_ENDPOINT=api.anthropic.com
        // and expects validateEndpoint to throw). The URL is the fixture for
        // the forbidden value; no network call occurs. The tag is a visible,
        // reviewable waiver — reviewers should verify the file truly never
        // reaches the network (same trust model as the @real-llm tag below).
        if (/api\.anthropic\.com|api\.openai\.com|generativelanguage\.googleapis\.com/i.test(content)) {
          if (/@llm-url-fixture/.test(content)) {
            console.log(`[workflow] llm-gate: ${relPath} contains a real LLM URL but is tagged @llm-url-fixture (URL asserted as rejected, not called) — allowed`);
          } else {
            violations.push(`${relPath}: contains real LLM API URL. Tests must NOT call paid external APIs. (If the URL is a fixture asserted as REJECTED — e.g. a residency-guard test — tag the file with @llm-url-fixture and explain why.)`);
          }
        }
        // BLOCK: LLM SDK imports without a mock
        if (/from\s+['"](@anthropic-ai\/sdk|openai|@google\/generative)['"]/.test(content) || /require\s*\(\s*['"](@anthropic-ai\/sdk|openai)['"]\s*\)/.test(content)) {
          const hasMock = /vi\.mock|jest\.mock/i.test(content);
          if (!hasMock) {
            violations.push(`${relPath}: imports LLM SDK without mocking — would call real API. Forbidden in automated tests.`);
          }
        }
        // BLOCK: leaky LLM-via-backend tests. Count only ACTIONS that actually
        // invoke generate/refine — clicks on Generera/Skapa buttons and direct
        // .post() / .fetch() to /api/(generate|refine). Discount any file that
        // installs a top-level page.route() mock (which would intercept all
        // such calls) or tags every leaky test with @real-llm.
        // Pattern observed in example-web's prd-010a: 17 untagged Generera-clicks
        // billed real Anthropic tokens for ~4 days because the backend's
        // LLM_PROVIDER defaulted to 'anthropic'.
        const clickTriggers = (content.match(/\.click\s*\(\s*[^)]*?(Generera|Skapa|generate-btn)/gi) || []).length;
        const directApiCalls = (content.match(/\.(post|fetch|get|put)\s*\(\s*[^,)]*\/api\/(generate|refine)/gi) || []).length;
        const triggers = clickTriggers + directApiCalls;
        if (triggers > 0) {
          const realLlmTagCount = (content.match(/@real-llm/g) || []).length;
          // Treat ANY presence of these as evidence the file knows about
          // mocking. We deliberately don't require per-trigger 1:1 coverage
          // because mocks are commonly factored into helper functions that
          // call page.route() once per file but apply per test.
          const hasAnyRouteMock = /page\.route\s*\(\s*['"`][^'"`]*\/api\/(generate|refine)/i.test(content);
          // Match an actual function reference like `mockGenerateRoute(`,
          // not constant names like `MOCK_GENERATE_SSE` that just spell those words.
          const hasMockHelper = /\bmock\w*(Generate|Refine|Llm|Anthropic)\w*\s*\(/i.test(content);
          // Pass when the file installs a route mock (beforeEach or per-test)
          // OR uses a mock helper — any one of these covers all triggers.
          // Otherwise, every trigger must be matched by a @real-llm tag —
          // intentional opt-in, one tag per trigger.
          const hasMockingEvidence = hasAnyRouteMock || hasMockHelper;
          if (!hasMockingEvidence && triggers > realLlmTagCount) {
            const leakCount = triggers - realLlmTagCount;
            violations.push(
              `${relPath}: ${leakCount} of ${triggers} interaction(s) with /api/(generate|refine) lack LLM-guarding. ` +
              `Found ${realLlmTagCount} @real-llm tag(s) but no page.route() mock or mockGenerate/mockRefine helper. ` +
              `Each unguarded interaction can invoke the real Anthropic backend and bill tokens. ` +
              `Fix one of: (a) add a top-level test.beforeEach with page.route('**/api/generate*'), ` +
              `(b) add per-test page.route() mocks, or (c) tag every leaky test with @real-llm.`
            );
          }
        }
      }
    } catch (e) {
      console.log(`[workflow] LLM test scan failed in ${cwd}: ${e.message}`);
    }
    return { violations };
  }

  // Mechanical pre-merge hygiene gate (#3): scan PRODUCTION source (non-test)
  // files added/modified on the branch for test scaffolding that must never
  // ship — env-based failure/behavior hooks and ungated test seams. Near-zero
  // cost, permanent. Defaults are deliberately tight (high precision) to avoid
  // blocking merges spuriously; projects extend via config.hygiene.extra_patterns
  // and exempt files via config.hygiene.allow.
  function scanSourceForTestScaffolding(cwd, baseBranch = 'main', hygiene = {}) {
    const violations = [];   // blocking — fail the merge gate
    const advisories = [];   // non-blocking — surfaced as notes only
    if (hygiene.enabled === false) return { violations, advisories };
    // High-precision defaults. Each entry: { re, msg }. The env `=== 'fail'`
    // family is the exact class that shipped a live test hook in a prod handler.
    // Blocking patterns = actual MECHANISMS that gate/backdoor production
    // behavior. Advisory patterns = documentation markers that only *describe* a
    // seam — surfaced as a note, never block the merge. Rationale (2026-07-05):
    // three consecutive merge blocks (example-web ADR-033 module, example-ios XCTest
    // markers, example-graph test-fixtures) were ALL honest `// TEST-ONLY` comments
    // on properly-guarded seams — zero real catches. The mechanism patterns below
    // still block; a comment alone no longer does.
    const patterns = [
      { severity: 'blocking', re: /process\.env\.\w+\s*===?\s*['"](fail|error|throw|crash|break|force[-_]?\w*)['"]/i,
        msg: "env-based failure/behavior hook (process.env.X === 'fail'-style) — test scaffolding must not gate production behavior" },
      { severity: 'blocking', re: /\b(globalThis|window|global)\.__(TEST|MOCK|E2E|DEBUG)\w*/,
        msg: 'global test/mock backdoor (__TEST__/__MOCK__/…) reachable in production' },
      { severity: 'blocking', re: /\b__(TEST|E2E)_HOOK__\b/,
        msg: 'test-hook backdoor identifier reachable in production' },
      { severity: 'advisory', re: /\/\/\s*@?test[-_]?only\b/i,
        msg: 'test-only comment marker in production source — verify the seam it documents is production-guarded and unreachable from prod (advisory: does not block merge)' },
    ];
    // Project extra_patterns are blocking by default (the project opted into
    // them deliberately).
    for (const p of (hygiene.extra_patterns || [])) {
      try { patterns.push({ severity: 'blocking', re: new RegExp(p, 'i'), msg: `matched project hygiene pattern: ${p}` }); }
      catch (_) { /* skip invalid project regex rather than crash the gate */ }
    }
    const allow = hygiene.allow || [];
    try {
      const { execFileSync } = require('child_process');
      const diffOutput = execFileSync('git', ['diff', '--name-only', `${baseBranch}...HEAD`], {
        cwd, encoding: 'utf8', timeout: 10000,
      }).trim();
      const untrackedOutput = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
        cwd, encoding: 'utf8', timeout: 10000,
      }).trim();
      const allFiles = [...new Set([...diffOutput.split('\n'), ...untrackedOutput.split('\n')])].filter(f => f.trim());
      // Production source only: skip test files and test/e2e directories.
      // Covers web conventions (.test.ts, tests/, fixtures/, test-fixtures/) AND
      // XCTest/Kotlin naming (FooTests.swift, MyAppTests/, MyAppUITests/). Test
      // directories missed here get scanned as production source and false-flag
      // their legitimate test-only markers: iOS naming until 2026-07-02, and
      // hyphenated test dirs (`test-fixtures/`, example-graph) until 2026-07-05.
      const isTest = f => /\.(test|spec)\.(ts|js|tsx|jsx|mjs|cjs|mts|cts|swift|kt)$/.test(f)
        || /Tests\.(swift|kt)$/.test(f)
        || /(^|\/)(__tests__|__mocks__|__fixtures__|tests?|e2e|fixtures|mocks|test-fixtures|test-utils|test-helpers|test-data|testdata)\//.test(f)
        || /(^|\/)[^/]*Tests\//.test(f);
      const isSource = f => /\.(ts|js|tsx|jsx|mjs|cjs|mts|cts|swift|kt|go|py)$/.test(f);
      const srcFiles = allFiles.filter(f => isSource(f) && !isTest(f));
      for (const relPath of srcFiles) {
        if (allow.some(a => relPath.includes(a))) continue;
        let content;
        try { content = fs.readFileSync(path.join(cwd, relPath), 'utf8'); } catch (_) { continue; }
        for (const { re, msg, severity } of patterns) {
          const m = content.match(re);
          if (!m) continue;
          const line = `${relPath}: ${msg} — found \`${m[0].slice(0, 80)}\``;
          (severity === 'advisory' ? advisories : violations).push(line);
        }
      }
    } catch (e) {
      console.log(`[workflow] hygiene scan failed in ${cwd}: ${e.message}`);
    }
    return { violations, advisories };
  }

  function mergeDevBranches(wf, res) {
    const prdId = wf.input.replace(/\s+/g, '-');

    try {
      // New branching strategy: the run owns `wf.branch`, checked out in the main dir,
      // and task_execution already committed the work there. Do NOT recreate an
      // integration branch from main (that orphans the work) and do NOT make a review
      // worktree (the branch is checked out in the main dir). Merge only the
      // fix_execution worktree branches into wf.branch in place. Legacy runs with no
      // wf.branch keep the original review/<id>-from-main behaviour.
      let reviewBranch, reviewWtPath, devBranches;
      if (wf.branch) {
        reviewBranch = wf.branch;
        wf.reviewBranch = reviewBranch;
        reviewWtPath = projectRoot;
        devBranches = [...new Set(wf.fixBranches || [])];
      } else {
        reviewBranch = `review/${prdId}`;
        wf.reviewBranch = reviewBranch;
        // Round 1: (re)create review branch fresh from main; round 2+: keep it.
        if (wf.round <= 1 || !gitOps.branchExists(reviewBranch)) {
          if (gitOps.branchExists(reviewBranch)) {
            try { gitOps.deleteBranch(reviewBranch, true); } catch (_) {}
          }
          gitOps.createBranchFromMain(reviewBranch);
        }
        reviewWtPath = resolveReviewCwd(prdId, reviewBranch);
        devBranches = [...new Set([
          ...(config.roles.execution || []).map(r => `${r.branch_prefix}-${prdId}`),
          ...(wf.fixBranches || []),
        ])];
      }
      const mergeResults = [];
      const { execFileSync } = require('child_process');
      for (const branch of devBranches) {
        try {
          const ahead = gitOps.commitsAhead(branch, reviewBranch);
          console.log(`[workflow] ${branch}: ${ahead} commits ahead of ${reviewBranch}`);
          if (ahead === 0) { mergeResults.push({ branch, status: 'empty' }); continue; }
          try {
            // Try clean merge first
            gitOps.mergeBranch(branch, reviewWtPath, `Merge ${branch} for review`);
            mergeResults.push({ branch, status: 'merged' });
          } catch (_) {
            // Conflict — abort and mark as conflict (do NOT auto-resolve: -X theirs silently
            // drops changes from previously-merged tasks that modified the same file)
            gitOps.abortMerge(reviewWtPath);
            mergeResults.push({ branch, status: 'conflict', error: 'Merge conflict — task branch must be rebased onto the review branch before it can be merged' });
            console.log(`[workflow] ${branch}: merge conflict, marking as conflict (manual rebase required)`);
          }
        } catch (e) {
          mergeResults.push({ branch, status: 'error', error: e.message });
        }
      }

      const conflictedBranches = mergeResults.filter(r => r.status === 'conflict');
      if (conflictedBranches.length > 0) {
        wf.steps.merge_for_review = { status: 'error', mergeResults, error: `${conflictedBranches.length} task branch(es) have merge conflicts and must be rebased: ${conflictedBranches.map(r => r.branch).join(', ')}` };
        state.saveWorkflow(wf);
        return res.json({ workflow: wf, mergeResults });
      }

      // LLM test gate: scan EVERY test file added/modified by task_execution or
      // fix_execution agents — the pre-implementation qa_tests gate only saw
      // tests written up front. Without this, a specialist-QA task could commit
      // tests that hit api.anthropic.com / api.openai.com / etc. and slip by.
      const llmScan = scanTestFilesForLlmViolations(reviewWtPath, wf.defaultBranch || 'main');
      if (llmScan.violations.length > 0) {
        wf.steps.merge_for_review = {
          status: 'error',
          mergeResults,
          error: `${llmScan.violations.length} test file(s) in the review branch would call real LLM APIs. Fix the test files on their source branches, re-merge, and retry.\n\n${llmScan.violations.join('\n')}`,
          violations: llmScan.violations,
        };
        state.saveWorkflow(wf);
        return res.status(400).json({ workflow: wf, mergeResults, violations: llmScan.violations });
      }

      // Hygiene gate (#3): block test scaffolding leaked into production source.
      const hygieneScan = scanSourceForTestScaffolding(reviewWtPath, wf.defaultBranch || 'main', config.hygiene || {});
      const hygieneAdvisories = hygieneScan.advisories || [];
      if (hygieneAdvisories.length > 0) {
        console.log(`[workflow] hygiene advisories (non-blocking): ${hygieneAdvisories.length}\n  ${hygieneAdvisories.join('\n  ')}`);
      }
      if (hygieneScan.violations.length > 0) {
        wf.steps.merge_for_review = {
          status: 'error',
          mergeResults,
          error: `${hygieneScan.violations.length} production source file(s) contain test scaffolding that must not ship (env failure hooks / test seams). Remove them on the source branch, re-merge, and retry. If a match is legitimate, exempt it via config.hygiene.allow.\n\n${hygieneScan.violations.join('\n')}`,
          violations: hygieneScan.violations,
          advisories: hygieneAdvisories,
        };
        state.saveWorkflow(wf);
        return res.status(400).json({ workflow: wf, mergeResults, violations: hygieneScan.violations, advisories: hygieneAdvisories });
      }

      // Advisories surfaced on the completed step (visible in the UI / API) but
      // never block — e.g. a `// test-only` comment on a properly-guarded seam.
      wf.steps.merge_for_review = { status: 'completed', mergeResults, advisories: hygieneAdvisories };
      const nextStep = wf.returnTo || 'code_review';
      wf.currentStep = nextStep;
      wf.returnTo = null;

      if (nextStep === 'code_review') {
        const crAgent = [{
          role: 'Code Reviewer', window: 'code-review', status: 'pending', reportFeedback: true,
          instruction: (() => {
            // Build context about what triggered this review round
            const prevFixStep = wf.steps.fix_execution || wf.steps.fix_review || wf.steps.fix_qa || wf.steps.fix_security;
            const prevQA = wf.steps.qa_validation;
            const prevSecurity = wf.steps.security_audit;
            let reviewContext = '';
            if (wf.round > 1 && prevFixStep) {
              const fixFeedback = (prevFixStep.agents || []).filter(a => a.feedback).map(a => `${a.role}: ${a.feedback}`).join('\n\n');
              reviewContext = `\n\n## THIS IS A RE-REVIEW (Round ${wf.round})\nFocus on verifying the fixes from the previous round. Do not re-raise issues that were already fixed.\n\n### Previous fix reports:\n${fixFeedback}`;
              if (prevQA && prevQA.agents) {
                const qaFb = prevQA.agents.filter(a => a.feedback).map(a => a.feedback).join('\n');
                if (qaFb) reviewContext += `\n\n### QA issues that prompted the fixes:\n${qaFb}`;
              }
              if (prevSecurity && prevSecurity.agents) {
                const secFb = prevSecurity.agents.filter(a => a.feedback).map(a => a.feedback).join('\n');
                if (secFb) reviewContext += `\n\n### Security issues that prompted the fixes:\n${secFb}`;
              }
            }
            // Add design conformance check if a Pencil design file exists in
            // the Companion Specs section. Locates by heading text (handles
            // any section number — example-site §6, example-web §10, etc.).
            let designCheck = '';
            try {
              const prdContent = fs.readFileSync(path.join(docsPath, wf.prdPath || ''), 'utf8');
              let csMatch = prdContent.match(/^##\s+[^\n]*\bcompanion\s+specs?\b[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/im);
              if (!csMatch) csMatch = prdContent.match(/## §?10[.\s].*?\n([\s\S]*?)(?=\n## §?\d|$)/m);
              if (csMatch) {
                const penFiles = [];
                for (const line of csMatch[1].split('\n')) {
                  if (/\|\s*Done\s*\|/i.test(line) && /\.pen\b|pencil|visual design/i.test(line)) {
                    const cells = line.split('|').map(c => c.trim()).filter(c => c);
                    if (cells.length >= 3) penFiles.push(cells[cells.length - 1]);
                  }
                }
                if (penFiles.length > 0) {
                  const pwCliAvail = config.features && config.features.playwright_cli;
                  const screenshotHint = pwCliAvail ? ` If the match % is borderline or missing, take an independent screenshot with \`playwright-cli\` and re-run the heatmap diff yourself.` : '';
                  const pencilHalt = ` If you need to read .pen files directly, first call \`get_editor_state\` to verify the Pencil MCP is available. If it fails, **STOP** and report: "BLOCKED: Pencil MCP unavailable — please start the Pencil app and re-run this step." Do NOT skip design verification.`;
                  designCheck = `\n6. **DESIGN CONFORMANCE** — A Pencil visual design was approved for this PRD (${penFiles.join(', ')}). Verify that frontend code matches the approved design. Check: colors, spacing, typography, layout, component structure. If the implementation deviates from the design without justification, mark it BLOCKING. Check the dev's fix report for a heatmap match % — if missing, that is BLOCKING.${screenshotHint}${pencilHalt}`;
                }
              }
            } catch {}

            if (wf.round > 1 && reviewContext) {
              // Re-review: targeted single-pass, no parallel sub-agents
              return `## YOU ARE A CODE REVIEWER — NOT A FIX AGENT — READ THIS FIRST\n\n**Your job is to review code changes and report findings. You do NOT write code. You do NOT fix bugs. You do NOT modify files. You read the diff, identify issues, and submit a structured review.**\n\n**FORBIDDEN FEEDBACK FORMAT** — your feedback will be REJECTED if you use any of these patterns (FIX-REPORT format used by Dev agents — wrong for reviewers):\n- \`**All issues addressed:** yes|no\` / \`**Committed:** <hash>\` / \`### Changes\` listing files you modified\n- Any phrasing that implies you made code changes\n\n**REQUIRED FEEDBACK FORMAT** — your feedback MUST contain:\n- \`**Approved:** yes | no\`\n- \`**Blocking:** N  |  **Medium:** N  |  **Low:** N\`\n- \`### Summary\`, \`### Findings\`, \`### Action Items\` sections\n\n**IF YOU SEE A BUG:** REPORT it as a finding with severity (BLOCKING / MEDIUM / LOW) and an Action Item naming the role responsible. DO NOT fix it yourself.\n\n---\n\nYou are a Code Reviewer doing a targeted re-review.\n\nDo NOT use the /code-review skill and do NOT launch parallel sub-agents. Do a single-pass focused review.\n\nPRD path: ${wf.prdPath}\n${reviewContext}\n\n## YOUR TASK\nVerify that each fix listed above actually resolves the issue it claims to fix. Read the relevant changed files directly. Check for regressions introduced by the fixes. Do not re-audit code that was already approved in round 1.\n\n## OUTPUT FORMAT (machine-parsed — use exactly)\n\n## Review: Code Reviewer\n\n**Approved:** yes | no\n**Blocking:** N  |  **Medium:** N  |  **Low:** N\n\n### Summary\n[1-3 sentences]\n\n### Findings\n[Only issues with the fixes. If fixes are clean, say "All blocking issues from round 1 are resolved."]\n\n### Action Items\n- [ ] [role] — description`;
            }
            return `## YOU ARE A CODE REVIEWER — NOT A FIX AGENT — READ THIS FIRST\n\n**Your job is to review code changes and report findings. You do NOT write code. You do NOT fix bugs. You do NOT modify files. You read the diff, identify issues, and submit a structured review.**\n\n**FORBIDDEN FEEDBACK FORMAT** — your feedback will be REJECTED if you use any of these patterns (FIX-REPORT format used by Dev agents — wrong for reviewers):\n- \`**All issues addressed:** yes|no\` / \`**Committed:** <hash>\` / \`### Changes\` listing files you modified\n- Any phrasing that implies you made code changes\n\n**REQUIRED FEEDBACK FORMAT** — your feedback MUST contain:\n- \`**Approved:** yes | no\`\n- \`**Blocking:** N  |  **Medium:** N  |  **Low:** N\`\n- \`### Summary\`, \`### Findings\`, \`### Action Items\` sections\n\n**IF YOU SEE A BUG:** REPORT it as a finding with severity (BLOCKING / MEDIUM / LOW) and an Action Item naming the role responsible. DO NOT fix it yourself. The fix happens in a separate fix_execution step by Dev agents.\n\n---\n\nYou are a Code Reviewer. Review the code changes in this branch.\n\nPRD path: ${wf.prdPath}\nUse the /code-review skill at ${(config.code_review && config.code_review.effort) || 'high'} effort — a multi-angle, recall-biased pass: surface every plausible issue then verify, don't stop at the first few. Review all changes, check for quality, correctness, and adherence to project standards.\n\n## REVIEW SCOPE RULES\n1. **Only review code changes in this branch** — do not review pre-existing code or suggest refactors outside the PRD scope.\n2. **Check the PRD's "Out of scope" section** — do not raise issues about excluded items.\n3. **Classify findings** as BLOCKING or NON-BLOCKING. Be conservative with BLOCKING.\n4. **If code is correct, say "APPROVE."** Do not invent concerns.\n5. **Use the structured review format** from CLAUDE.md.${designCheck}\n7. **ACCEPTANCE CRITERIA COVERAGE** — Read the PRD and verify that EVERY acceptance criterion has corresponding code changes. If an AC has no implementation at all, mark it BLOCKING. Include an "AC Coverage" section in your review listing each AC and whether it's covered by the code changes.\n8. **MOCK-ONLY COVERAGE** — Check if any acceptance criteria that depend on external services (LLM calls, third-party APIs, hardware) are only tested with mocked responses. Flag these as "MOCK-ONLY — real integration unverified" in your review so they are flagged for manual testing during demo review. Not all projects use mocks — only flag this when the project's tests actually mock external dependencies.\n9. **MULTI-ANGLE RECALL** — cover these angles explicitly (each has shipped real merged defects): (a) correctness across ALL entity/type variants the spec covers and BOTH directions of every toggle — not just the path the implementation took; (b) silent fail-safe drops (returns 200 while quietly discarding an invalid field); (c) removed or weakened prior behavior; (d) cross-file / contract drift; (e) altitude — a third copy of logic that will drift; (f) dead / unused error contracts; (g) test scaffolding leaked into production (env hooks, ungated test seams).\n\nThis is round ${wf.round}.${reviewContext}`;
          })(),
        }];
        wf.steps.code_review = { status: 'running', agents: launchWorkflowAgents(wf, crAgent, { useWorktrees: false, cwd: projectRoot }) };
      } else if (nextStep === 'qa_validation') {
        // Extract test file list from qa_tests feedback to focus validation
        const qaTestFeedback = (wf.steps.qa_tests?.agents || []).map(a => a.feedback || '').join('\n');
        const testFileMatches = qaTestFeedback.match(/`([^`]+\.test\.[^`]+)`/g) || [];
        const testFiles = testFileMatches.map(m => m.replace(/`/g, ''));
        const testFileList = testFiles.length > 0
          ? `\n\n## TEST FILES TO RUN\nThese unit test files were written by the QA step for this PRD:\n${testFiles.map(f => `- ${f}`).join('\n')}\n\nRun these FIRST. If they all pass, run the broader unit test suite (vitest/jest) to check for regressions. Then run any E2E/Playwright .spec.* files written for this PRD.`
          : '';

        let qaRoundContext = '';
        if (wf.round > 1) {
          const prevFix = wf.steps.fix_execution || wf.steps.fix_plan;
          const fixFeedback = prevFix ? (prevFix.agents || []).filter(a => a.feedback).map(a => a.feedback).join('\n') : '';
          if (fixFeedback) qaRoundContext = `\n\n## THIS IS RE-VALIDATION (Round ${wf.round})\nFixes were applied. Focus on verifying the fixes resolved the failures from the previous round.\n\n### Fix reports:\n${fixFeedback}`;
        }

        // Check if PRD has visual designs and playwright-cli is enabled
        let qaVisualSection = '';
        const hasBrowserTesting = config.features && config.features.playwright_cli;
        if (hasBrowserTesting) {
          try {
            const qaPrdContent = fs.readFileSync(path.join(docsPath, wf.prdPath || ''), 'utf8');
            const qaS10 = qaPrdContent.match(/## 10[.\s].*?\n([\s\S]*?)(?=\n## \d|$)/);
            if (qaS10 && /\.pen\b|pencil|visual design/i.test(qaS10[1])) {
              qaVisualSection = `\n\n## VISUAL VERIFICATION — REQUIRED\nThis PRD has an approved Pencil design. After running tests, use the \`qa-browser-testing\` skill to screenshot key pages and verify visual correctness.\nUse \`playwright-cli\` to screenshot at desktop (1440×900) and mobile (390×844) viewports. Verify all key states: default, error, empty, loading.\nInclude screenshot paths in your feedback as evidence.\n\n### PENCIL MCP — CHECK FIRST\nIf you need to export or read .pen design files for heatmap comparison, first call \`get_editor_state\` to verify the Pencil MCP is available. If it fails, **STOP IMMEDIATELY** and report: "BLOCKED: Pencil MCP unavailable — please start the Pencil app and re-run this step." Do NOT skip visual verification.`;
            }
          } catch {}
        }
        const browserSkillRef = hasBrowserTesting ? ' Use the `qa-browser-testing` skill for any browser-based verification.' : '';

        const qaAgent = [{
          role: 'QA', window: 'qa-validate', status: 'pending', reportFeedback: true,
          instruction: `You are QA. Validate that the implementation passes all tests.\n\nPRD path: ${wf.prdPath}\nUse the /qa_review skill.${browserSkillRef}${testFileList}${qaRoundContext}\n\n## VALIDATION STEPS\n\n1. Run the PRD-specific unit tests listed above\n2. If they pass, run the full unit test suite (e.g. \`npx vitest run\`) to check for regressions\n3. Run any E2E/Playwright .spec.* files written for this PRD\n4. Report results using the structured QA feedback format\n\n## TEST DATA CLEANUP — MANDATORY\nAfter ALL tests finish (pass or fail), delete every test record created during this run.\n- Test users (emails matching \`test-*@example.com\` or \`preflight@example.com\`)\n- Test events, sessions, and any other DB rows created by tests\n- Use the project's delete endpoints or direct DB queries\n- Verify cleanup: query the DB and confirm test records are gone\n- Report cleanup status in your feedback (e.g., "Cleaned up 12 test users, 3 test events")\nDo NOT leave test data behind — it accumulates across runs and pollutes the database.\n\n## IMPORTANT\n- If tests fail, report the EXACT failure output — do not summarize\n- Distinguish between PRD test failures (blocking) and pre-existing failures (non-blocking)\n- Do NOT fix code — only report what fails${qaVisualSection}`,
        }];
        wf.steps.qa_validation = { status: 'running', agents: launchWorkflowAgents(wf, qaAgent, { useWorktrees: false, cwd: projectRoot }) };
      } else if (nextStep === 'security_audit') {
        // Capped loop — skip to security audit after merge
        wf.steps.security_audit = { status: 'pending', agents: [] };
      }

      state.saveWorkflow(wf);
      return res.json({ workflow: wf, mergeResults, ...(nextStep === 'security_audit' ? { needsAdvance: true } : {}) });
    } catch (e) {
      wf.steps.merge_for_review = { status: 'error', error: e.message };
      state.saveWorkflow(wf);
      return res.status(500).json({ workflow: wf, error: e.message });
    }
  }

  // Scan a task agent's log file for API error patterns (last ~4KB).
  function detectLogError(wf, windowName) {
    try {
      const logFile = path.join(logsPath, `${windowName}-${wf.id}.log`);
      if (!fs.existsSync(logFile)) return null;
      const size = fs.statSync(logFile).size;
      const buf = Buffer.alloc(Math.min(4096, size));
      const fd = fs.openSync(logFile, 'r');
      fs.readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
      fs.closeSync(fd);
      const tail = buf.toString('utf8');
      if (/API Error: 5\d\d|"type":"api_error"|Internal server error|Claude AI error/i.test(tail)) return 'api_error';
    } catch (_) {}
    return null;
  }

  // --- Routes ---
  router.get('/workflow', (req, res) => {
    const wf = state.loadWorkflow();
    // Enrich running task agents with log error flags (in-memory only — not persisted)
    if (wf?.currentStep === 'task_execution' && wf.taskExecution) {
      for (const ts of Object.values(wf.taskExecution.taskStates)) {
        for (const a of (ts.agents || [])) {
          if (a.status === 'running' && a.window) {
            const err = detectLogError(wf, a.window);
            if (err) a.logError = err;
          }
        }
      }
    }
    // Expose the project's resolved workflow step lists so the UI can render
    // the correct timeline per project (e.g. static-site projects don't have
    // device_testing, iOS projects do). The UI previously used a hardcoded
    // full step list which showed steps that this project never runs.
    const projectWorkflowSteps = config.workflow ? {
      kickoff: config.workflow.kickoff || [],
      review: config.workflow.review || [],
      execution: config.workflow.execution || [],
      onboarding: config.workflow.onboarding || [],
      // Resolved server-side (config.workflow.bugfix override or DEFAULT_BUGFIX_STEPS)
      // so the hub can render the bugfix timeline the same way it does the others.
      bugfix: bugfixSequence(config),
    } : null;
    // PRD-001 pathology signals — surfaces "is this monolithic run healthy?" signals.
    const pathologySignals = computePathologySignals(wf);
    // PRD-001 findings — parsed from code_review / qa_validation feedback. Read-only.
    const findings = extractFindings(wf);
    res.json({ workflow: wf, projectWorkflowSteps, preset: config.preset, pathologySignals, findings, maxReviewRounds: config.max_review_rounds || 4 });
  });

  // PRD-001 pathology signals — pure function, derives "is this run healthy?"
  // hints from current workflow state + running agents' tmux pane output.
  // Returns null when there's no monolithic task agent to monitor.
  function computePathologySignals(wf) {
    if (!wf || wf.currentStep !== 'task_execution' || !wf.taskExecution) return null;
    const states = wf.taskExecution.taskStates || {};
    const stateList = Object.values(states);
    // Only meaningful when monolithic — fine-grained has its own task ticker
    const taskCount = (wf.taskPlan && wf.taskPlan.tasks || []).length;
    if (taskCount !== 1) return null;
    const ts = stateList[0];
    if (!ts) return null;
    const startedAt = ts.startedAt ? new Date(ts.startedAt).getTime() : null;

    // Time since last commit (uses gitOps so it sees the same git state as the ribbon)
    let minutesSinceLastCommit = null;
    if (startedAt) {
      try {
        const commits = gitOps.commitsSince(new Date(startedAt).toISOString(), 5);
        if (commits.length > 0) {
          minutesSinceLastCommit = Math.floor((Date.now() - new Date(commits[0].isoDate).getTime()) / 60_000);
        } else {
          // No commits yet — "minutes since start" is the meaningful number for the stale-commit signal
          minutesSinceLastCommit = Math.floor((Date.now() - startedAt) / 60_000);
        }
      } catch (_) {}
    }

    // Pane-text heuristics — cheap, requires the agent's tmux window
    const runningAgent = (ts.agents || []).find(a => a.status === 'running' && a.window);
    let compactionDetected = false;
    let secondsSincePaneActivity = null;
    let building = false;
    if (runningAgent && wf.sessionName) {
      try {
        const pane = require('child_process').execFileSync('tmux',
          ['capture-pane', '-t', `${wf.sessionName}:${runningAgent.window}`, '-p', '-S', '-200'],
          { encoding: 'utf8', timeout: 3000 });
        // Compaction marker (both Claude and Codex produce one when context fills)
        // Match both past-tense ("Conversation compacted" — visible after the
        // compaction completes) and in-progress ("Compacting conversation…" —
        // visible while the agent is actively compacting). Both states are
        // useful operator signals; pane checks may catch either depending on
        // when the polling interval samples the agent.
        compactionDetected = /Conversation compacted|Compacting conversation|context_compacted|context compacted/i.test(pane);
        // Build-success heuristic: recent xcodebuild/swift build line ending in BUILD SUCCEEDED, or `npm run build` exit 0
        building = /\*\*\s*(?:TEST\s+)?BUILD\s+SUCCEEDED\s*\*\*|Build succeeded|build successful/i.test(pane);
        // Activity: roughly approximate via the tmux pane's display-time — we don't have a true "last update" tmux signal
        // exposed cheaply, so default to "active" if pane is non-empty and the agent is running.
        secondsSincePaneActivity = pane.trim().length > 0 ? 0 : null;
      } catch (_) {}
    }

    // Format-POST retry: any intervention referencing the agent's window
    const formatPostRetried = (wf.overseer && (wf.overseer.interventions || [])
      .some(i => /format|forgot.*feedback|nudge/i.test(i.symptom || i.action || ''))) || false;

    return {
      minutesSinceLastCommit,
      compactionDetected,
      building,
      secondsSincePaneActivity,
      formatPostRetried,
    };
  }

  /**
   * PRD-001: parse structured findings from the most recent code_review and
   * qa_validation agent feedback. Read-only — doesn't alter fix_execution.
   *
   * Returns [{ id, severity, source, label, body, status, matchedBy }] when
   * fix_execution is active or has completed; [] otherwise.
   */
  function extractFindings(wf) {
    if (!wf || !wf.steps) return [];
    const fe = wf.steps.fix_execution;
    if (!fe) return [];

    const out = [];

    // Code review: matches both **BLOCKING-N — ...** style and abbreviated
    // **B1 — ...** / **M5 — ...** / **L1 — ...** style. Different reviewers
    // use different conventions; the dashboard normalizes them.
    const cr = wf.steps.code_review;
    if (cr && cr.agents) {
      for (const a of cr.agents) {
        if (!a.feedback) continue;
        const seen = new Set();
        // Group 1: severity tag (BLOCKING|MEDIUM|LOW|B|M|L). Group 2: number. Group 3: label.
        const rx = /\*\*\s*(BLOCKING|MEDIUM|LOW|B|M|L)[-\s]*(\d+)\s*[—\-:]\s*([^\n*]+?)\s*\*\*/gi;
        let m;
        while ((m = rx.exec(a.feedback)) !== null) {
          const raw = m[1].toUpperCase();
          const severity = raw === 'B' ? 'BLOCKING' : raw === 'M' ? 'MEDIUM' : raw === 'L' ? 'LOW' : raw;
          const num = m[2];
          const label = m[3].trim();
          const id = `code_review-r${wf.round || 1}-${severity.toLowerCase()}-${num}`;
          if (seen.has(id)) continue;
          seen.add(id);
          out.push({
            id, severity, source: `code_review-r${wf.round || 1}`,
            label, body: extractBodyAfter(a.feedback, m.index, m[0].length),
            status: 'pending', matchedBy: null,
          });
        }
      }
    }

    // QA validation: numbered list items under ### Failures
    const qv = wf.steps.qa_validation;
    if (qv && qv.agents) {
      for (const a of qv.agents) {
        if (!a.feedback) continue;
        const failuresMatch = a.feedback.match(/### Failures\s*\n([\s\S]*?)(?=\n###|\n$|$)/);
        if (!failuresMatch) continue;
        const block = failuresMatch[1];
        const rx = /^\s*(\d+)\.\s+(.+?)(?=\n\s*\d+\.|\n###|$)/gms;
        let m;
        while ((m = rx.exec(block)) !== null) {
          const num = m[1];
          const text = m[2].trim();
          const label = text.split('\n')[0].slice(0, 200);
          const id = `qa_validation-r${wf.round || 1}-failure-${num}`;
          out.push({
            id, severity: 'BLOCKING', source: `qa_validation-r${wf.round || 1}`,
            label, body: text,
            status: 'pending', matchedBy: null,
          });
        }
      }
    }

    // Status inference: in_progress if currentTask matches, done if completed
    function tailToken(id) {
      const parts = id.split('-');
      return parts[parts.length - 1];
    }
    function looseMatch(findingId, taskId) {
      const tail = tailToken(findingId);
      return tail && taskId && taskId.includes(tail);
    }

    const currentTaskId = fe.currentTask && typeof fe.currentTask === 'object' ? fe.currentTask.id : null;
    const completedIds = (fe.completedTasks || []).map(t => t.id).filter(Boolean);
    const completedCommits = (fe.completedTasks || []).map(t => t.commit).filter(Boolean);

    for (const f of out) {
      if (currentTaskId && looseMatch(f.id, currentTaskId)) {
        f.status = 'in_progress';
        f.matchedBy = currentTaskId;
        continue;
      }
      const hit = completedIds.find(cid => looseMatch(f.id, cid));
      if (hit) {
        f.status = 'done';
        const idx = completedIds.indexOf(hit);
        f.matchedBy = completedCommits[idx] || hit;
      }
    }
    return out;
  }

  function extractBodyAfter(text, startIdx, headerLen) {
    const after = text.slice(startIdx + headerLen);
    const stop = after.search(/\n\s*\n\s*\*\*/);
    return (stop > 0 ? after.slice(0, stop) : after.slice(0, 500)).trim();
  }

  router.post('/workflow/start', (req, res) => {
    const { type, input, reviewMode: startReviewMode, autoIterateRemaining: startAutoIterate, developerCli: startDeveloperCli, reviewerCli: startReviewerCli } = req.body;
    if (!type) return res.status(400).json({ error: 'type required' });
    if (!['review', 'execution', 'kickoff', 'onboarding', 'bugfix'].includes(type)) return res.status(400).json({ error: 'type must be review, execution, kickoff, onboarding, or bugfix' });
    if (startDeveloperCli && !['claude', 'codex'].includes(startDeveloperCli)) {
      return res.status(400).json({ error: "developerCli must be 'claude' or 'codex'" });
    }
    if (startReviewerCli && !['claude', 'codex'].includes(startReviewerCli)) {
      return res.status(400).json({ error: "reviewerCli must be 'claude' or 'codex'" });
    }
    // PRD-001: onboarding needs no input (the project itself is the input).
    // kickoff/review/execution still require input as today.
    if (type !== 'onboarding' && !input) return res.status(400).json({ error: 'input required' });

    const existing = state.loadWorkflow();
    if (existing) return res.status(409).json({ error: 'workflow already active', workflow: existing });

    const activeRun = state.loadRun();
    if (activeRun && activeRun.state === 'executing') {
      return res.status(409).json({ error: 'execution tab has an active run — cancel it first' });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let prdPath = null;
    let itemId = null; // set when `input` named a backlog user story / task
    let steps, currentStep;
    let taskPlan = null; // bugfix synthesizes its single-task plan up front (no planning step)

    if (type === 'kickoff') {
      steps = {
        ceo_synthesis: { status: 'pending', agents: [] },
        pm_scoping: { status: 'pending', agents: [] },
        owner_consultations: { status: 'pending', agents: [] },
        team_review: { status: 'pending', agents: [] },
        pm_revision: { status: 'pending', agents: [] },
        companion_specs: { status: 'pending', agents: [] },
        devops_init: { status: 'pending', agents: [] },
      };
      currentStep = 'ceo_synthesis';
    } else if (type === 'onboarding') {
      // PRD-001 v1: only available when docs/onboarding/inventory.json exists
      // (the button has run) AND docs/vision.md does not (workflow hasn't completed yet).
      const inventoryPath = path.join(projectRoot, 'docs', 'onboarding', 'inventory.json');
      const visionPath = path.join(docsPath, 'vision.md');
      if (!fs.existsSync(inventoryPath)) {
        return res.status(400).json({ error: 'No docs/onboarding/inventory.json — run Onboard project from the home screen first.' });
      }
      if (fs.existsSync(visionPath)) {
        return res.status(400).json({ error: 'docs/vision.md already exists — onboarding has already run for this project.' });
      }
      steps = {
        discovery:           { status: 'pending', agents: [] },
        ceo_synthesis:       { status: 'pending', agents: [] },
        architect_backfill:  { status: 'pending', agents: [] },
        pm_synthesis:        { status: 'pending', agents: [] },
        devops_detect:       { status: 'pending', agents: [] },
        team_review:         { status: 'pending', agents: [] },
        pm_revision:         { status: 'pending', agents: [] },
        owner_signoff:       { status: 'pending', agents: [] },
      };
      currentStep = 'discovery';
    } else if (type === 'bugfix') {
      // Bugfix: a lean execution flow driven by a single Bug backlog item. No
      // PRD, no planning, no review panel — the bug file is the spec. `input` is
      // the bug id (e.g. LS-029). Validate the item, synthesize a one-task plan,
      // and build the bugfix step dict. The Fixing status flip + fix/<id> branch
      // happen below (after the clean-tree guard, so they land on the run branch).
      const relDocsPath = config.docs_path || './docs';
      const bugId = input.trim().toUpperCase().replace(/\s+/g, '-');
      if (!isValidId(bugId)) {
        return res.status(400).json({ error: `bugfix input must be a backlog item id (e.g. LS-029), got "${input}".` });
      }
      let bug = null;
      try {
        bug = readItem(projectRoot, relDocsPath, bugId);
      } catch (e) {
        return res.status(400).json({ error: `Could not read backlog item ${bugId}: ${e.message}` });
      }
      const invalid = validateBugfixStart(bug, bugId);
      if (invalid) return res.status(invalid.status).json({ error: invalid.error });

      const builderRole = resolveBuilderRole(config, bug);
      if (!builderRole) {
        return res.status(400).json({ error: `No execution role configured to build the fix for ${bugId}. Add at least one role under roles.execution in .build-studio/config.yaml.` });
      }

      itemId = bugId;
      // wf.prdPath points downstream prompts at the bug file (derived the same way
      // readItem locates it) — "PRD path: X" then hands agents the bug as the spec.
      const docsRel = relDocsPath.replace(/^\.\//, '');
      prdPath = path.posix.join(docsRel, 'backlog', `${bugId}.md`);
      taskPlan = { tasks: [buildBugfixTask(bugId, bug, builderRole)] };

      const bugfixSteps = bugfixSequence(config);
      const BUGFIX_MANUAL_GATES = new Set(['merge_to_main']);
      const BUGFIX_PER_STEP_EXTRAS = { task_execution: { completedTasks: [] } };
      steps = {};
      for (const stepKey of bugfixSteps) {
        const base = BUGFIX_MANUAL_GATES.has(stepKey) ? { status: 'pending' } : { status: 'pending', agents: [] };
        steps[stepKey] = { ...base, ...(BUGFIX_PER_STEP_EXTRAS[stepKey] || {}) };
      }
      currentStep = bugfixSteps[0] || 'task_execution';
    } else {
      // Resolve the PRD path. `input` is either a PRD name/description OR a
      // backlog user story / task ID (e.g. EX-001). When it names a backlog
      // item we pull the PRD from that item's `prd:` field and gate on its
      // lifecycle status. Disambiguation is unambiguous: PRDs live in
      // docs/prds/, never docs/backlog/, so a PRD name never resolves to an
      // item file (and vice versa).
      const relDocsPath = config.docs_path || './docs';
      const storyId = input.trim().toUpperCase().replace(/\s+/g, '-');
      let story = null;
      if (isValidId(storyId)) {
        try {
          story = readItem(projectRoot, relDocsPath, storyId);
        } catch (e) {
          return res.status(400).json({ error: `Could not read backlog item ${storyId}: ${e.message}` });
        }
      }

      if (story) {
        // Gate 1 — the story/task must reference a PRD.
        const prdRef = typeof story.prd === 'string' ? story.prd.trim() : '';
        if (!prdRef) {
          return res.status(400).json({ error: `${story.type || 'Item'} ${storyId} has no PRD. Add a "prd:" field linking it to its PRD before running a ${type} workflow.` });
        }
        // readItem normalises `prd:` to a repo-relative docs/prds/<file>.md path
        // when it can resolve it; an unresolved ref stays verbatim and won't exist.
        if (!fs.existsSync(path.join(projectRoot, prdRef))) {
          return res.status(404).json({ error: `${storyId} references a PRD ("${story.prd}") that does not exist on disk.` });
        }
        // Gate 2 — status must match the stage this workflow operates on.
        const requiredStatus = type === 'review' ? 'Drafted' : 'Reviewed';
        if (story.status !== requiredStatus) {
          return res.status(409).json({ error: `${storyId} is "${story.status || 'unset'}", but a ${type} run requires status "${requiredStatus}". Move the item to ${requiredStatus} first.` });
        }
        prdPath = prdRef;
        itemId = storyId;
      } else {
        const prdsDir = path.join(docsPath, 'prds');
        if (fs.existsSync(prdsDir)) {
          const match = fs.readdirSync(prdsDir).find(f => f.toUpperCase().includes(input.toUpperCase().replace(/\s+/g, '-')));
          if (match) prdPath = `docs/prds/${match}`;
        }
        if (!prdPath) return res.status(404).json({ error: `PRD not found matching "${input}"` });
      }

      const prdExists = fs.existsSync(path.join(projectRoot, prdPath));

      if (type === 'review') {
        steps = {
          pm_draft: { status: prdExists ? 'completed' : 'pending' },
          reviewing: { status: 'pending', agents: [] },
          pm_fix: { status: 'pending' },
        };
        currentStep = prdExists ? 'reviewing' : 'pm_draft';
      } else {
        // Execution workflow: the qa_tests / task_execution / etc. steps create
        // git worktrees that only contain committed content. An untracked PRD is
        // invisible inside those worktrees, which makes agents report "PRD not
        // found" and waste a full round. Fail fast with a clear message.
        if (prdExists) {
          try {
            const { execFileSync } = require('child_process');
            execFileSync('git', ['ls-files', '--error-unmatch', prdPath], {
              cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'],
            });
          } catch (_) {
            return res.status(400).json({
              error: `PRD exists on disk but is not tracked in git: ${prdPath}. Execution agents run in isolated worktrees that only contain committed content, so an untracked PRD is invisible to them. Commit the PRD first:\n\n  git add ${prdPath} && git commit -m "docs: add ${path.basename(prdPath, '.md')}"\n\nThen re-start the execution workflow.`,
              prdUntracked: true,
              prdPath,
            });
          }
        }
        // Build steps from the resolved preset sequence so preset-specific
        // steps (e.g. mobile-app's device_testing between security_audit and
        // demo_review) actually exist in the workflow state. Previously this
        // dict was hardcoded, so any step the preset added beyond the default
        // web-app sequence was silently dropped — example-ios's PRD-001 surfaced this
        // when device_testing was missing entirely from the workflow.
        const PER_STEP_EXTRAS = {
          task_execution: { completedTasks: [] },
        };
        const MANUAL_GATES = new Set(['merge_for_review', 'demo_review', 'merge_to_main']);
        const executionSequence = (config.workflow && config.workflow.execution) || [
          'qa_tests', 'planning', 'task_execution', 'merge_for_review',
          'coverage_matrix', 'qa_validation', 'ac_verification', 'security_audit',
          'final_review', 'demo_review', 'merge_to_main', 'capture_learnings',
        ];
        steps = {};
        for (const stepKey of executionSequence) {
          const base = MANUAL_GATES.has(stepKey) ? { status: 'pending' } : { status: 'pending', agents: [] };
          steps[stepKey] = { ...base, ...(PER_STEP_EXTRAS[stepKey] || {}) };
        }
        currentStep = executionSequence[0] || 'qa_tests';
      }
    }

    // PRD branching strategy (2026-06-03) — guardrail: a review/execution run may
    // only start from a clean default branch. This alone prevents a new run from
    // stacking on a previous run's leftover branch (the PRD-025-on-PRD-024 failure)
    // or sweeping unrelated uncommitted work into the run. Deterministic per-run
    // branch CREATION + merge/delete lifecycle is staged separately — it requires
    // rewiring merge_for_review (which builds its integration branch from main and
    // is entangled with the worktree flow), so it must be validated on both an iOS
    // and a web run before shipping.
    // PRD branching strategy (2026-06-03): every review/execution run works on its
    // OWN branch (review/<id> or exec/<id>), created fresh from the default branch,
    // surfaced in the UI, and merged + deleted + returned-to-default when the run
    // ends. Deterministic — no agent-freelanced branches, and the guardrail blocks
    // a run from stacking on a previous run's leftover branch / a dirty tree.
    let runBranch = null;
    let runDefaultBranch = 'main';
    if (type === 'review' || type === 'execution' || type === 'bugfix') {
      const { execFileSync } = require('child_process');
      const g = (args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      try { runDefaultBranch = (g(['rev-parse', '--abbrev-ref', 'origin/HEAD']) || '').replace(/^origin\//, '') || 'main'; } catch {}
      let curBranch = '';
      try { curBranch = g(['branch', '--show-current']); } catch {}
      if (curBranch !== runDefaultBranch) {
        return res.status(409).json({ error: `Cannot start a ${type} run: the working tree is on "${curBranch || '(detached HEAD)'}", not ${runDefaultBranch}. Finish, merge, or abort that branch first so the run starts from a clean ${runDefaultBranch}.`, currentBranch: curBranch });
      }
      // Dirty-tree check applies to branch-creating runs (execution + bugfix):
      // both do `checkout -b <run>/<id>`, which carries uncommitted changes onto
      // the run branch and would block the final merge_to_main (which refuses a
      // dirty tree). Review creates no branch and commits to the default branch
      // directly, so working with uncommitted drafts present is fine (and matches
      // how the owner works — parallel PRD drafting).
      if (type === 'execution' || type === 'bugfix') {
        let dirty = '';
        try { dirty = g(['status', '--porcelain']); } catch {}
        if (dirty) {
          return res.status(409).json({ error: `Cannot start a ${type} run: ${runDefaultBranch} has uncommitted changes — they'd be carried onto the run branch and block the final merge. Commit, stash, or discard them first.` });
        }
      }
      // Branch CREATION is scoped to execution + bugfix (the runs whose code lands
      // on the default branch). The review WF only refines docs and has multiple
      // completion points, so its branch+merge lifecycle is a separate follow-up;
      // for now it commits to the (guardrail-clean) default branch directly.
      if (type === 'execution' || type === 'bugfix') {
        runBranch = type === 'bugfix' ? `fix/${itemId.toLowerCase()}` : `exec/${input.replace(/\s+/g, '-')}`;
        try { g(['rev-parse', '--verify', runBranch]); return res.status(409).json({ error: `Branch ${runBranch} already exists from a previous run. Merge or delete it first.` }); } catch (_) { /* good — does not exist */ }
        try {
          g(['checkout', '-b', runBranch, runDefaultBranch]);
        } catch (e) {
          return res.status(500).json({ error: `Failed to create run branch ${runBranch}: ${e.message}` });
        }
      }
    }

    // Bugfix flips the bug's status to Fixing AFTER the run branch is checked out,
    // so the status write lands on fix/<id> (not the default branch) and gets
    // captured by the pre-merge docs auto-commit. Doing it before the clean-tree
    // guard above would make the tree dirty and abort the run.
    if (type === 'bugfix' && itemId) {
      try { setBugItemStatus(itemId, 'Fixing'); }
      catch (e) { console.warn(`[bugfix] failed to flip ${itemId} → Fixing:`, e.message); }
    }

    const wf = {
      id: `${type}-${timestamp}`,
      type, input, prdPath, itemId, currentStep, steps,
      // Bugfix synthesizes its single-task plan at start (no planning step). Left
      // undefined for other types, which build taskPlan during their planning step.
      ...(taskPlan ? { taskPlan } : {}),
      round: 1, feedback: [],
      sessionName: `wf-${timestamp}`,
      // The run's working branch (checked out in the main dir). Everything commits
      // here; merge_to_main / review-end merges it to `defaultBranch` then deletes it.
      branch: runBranch,
      defaultBranch: runDefaultBranch,
      reviewBranch: (type === 'execution' || type === 'bugfix') ? runBranch : null,
      returnTo: null,
      reviewMode: startReviewMode || config.review_mode || 'parallel',
      autoIterateRemaining: startAutoIterate || 0,
      developerCli: startDeveloperCli || 'claude',
      // No auto-flip: reviewers default to the developer CLI (claude). Cross-model
      // review is opt-in per execution run via the UI reviewer-CLI control, and the
      // flip only takes effect in execution workflows (see reviewerOnCodex).
      reviewerCli: startReviewerCli || startDeveloperCli || 'claude',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Bugfix enters at task_execution with its plan already synthesized — mirror
    // the taskExecution shape the monolithic execution path builds after planning
    // so advancing the pending task_execution step launches the fix task normally.
    if (type === 'bugfix' && wf.taskPlan) initTaskExecution(wf);

    state.saveWorkflow(wf);
    res.json({ workflow: wf });
  });

  router.post('/workflow/feedback', (req, res) => {
    const { role, feedback, taskIndex } = req.body;
    if (!role || !feedback) return res.status(400).json({ error: 'role and feedback required' });
    const wf = state.loadWorkflow();
    if (!wf) return res.status(404).json({ error: 'no active workflow' });

    // Route per-task feedback during wave-based task_execution.
    // Recovery: if the agent forgot `taskIndex` (common after context
    // compaction — agent reconstructs the curl from memory and drops the
    // field), find the unique running task whose agent matches this role.
    // Without this recovery the request falls through to the step-level
    // branch below, where `step.agents` doesn't hold per-task agents, and
    // the POST is rejected with "agent <role> not found in current step",
    // leaving the workflow stalled.
    if (wf.currentStep === 'task_execution') {
      let idx = taskIndex;
      if (idx === undefined && wf.taskExecution && wf.taskExecution.taskStates) {
        const matches = [];
        for (const [k, ts] of Object.entries(wf.taskExecution.taskStates)) {
          if (ts.status !== 'running') continue;
          const has = (ts.agents || []).some(a => normalizeRole(a.role) === normalizeRole(role));
          if (has) matches.push(Number(k));
        }
        if (matches.length === 1) {
          idx = matches[0];
          console.log(`[workflow] feedback recovery: routed role=${role} → taskIndex=${idx} (POST omitted taskIndex)`);
        }
      }
      if (idx !== undefined) {
        return handleTaskFeedback(wf, idx, role, feedback, res);
      }
    }

    const step = wf.steps[wf.currentStep];
    if (!step || !step.agents) return res.status(400).json({ error: 'current step has no agents' });

    const agent = step.agents.find(a => normalizeRole(a.role) === normalizeRole(role));
    if (!agent) return res.status(404).json({ error: `agent ${role} not found in current step` });

    agent.feedback = feedback;
    agent.status = 'done';
    agent.completedAt = new Date().toISOString();
    if (agent.startedAt && agent.agentCwd) {
      agent.tokenUsage = computeTokenUsage(agent.startedAt, agent.completedAt, agent.agentCwd, agent.model);
    }
    const feedbackEntry = { role, feedback, round: wf.round, step: wf.currentStep, at: new Date().toISOString() };
    wf.feedback.push(feedbackEntry);

    state.saveWorkflow(wf);

    // Track whether injected learnings were cited or recurred
    trackLearningsEffectiveness(agent.injectedLearnings, feedback);

    // Append to telemetry log
    appendTelemetryLog(wf, feedbackEntry);

    // Auto-iterate: if all agents done and auto-iterate budget remains, auto-advance
    const allDone = step.agents.every(a => a.status === 'done' || a.status === 'error');
    const hasFeedback = step.agents.some(a => a.feedback && a.feedback.trim().length > 0);
    const autoRemaining = wf.autoIterateRemaining || 0;

    if (allDone && hasFeedback && wf.autoAdvance) {
      // Checkbox auto-advance (wf.autoAdvance) is normally driven by the 8s
      // server-side timer, which macOS App Nap throttles/suspends when this
      // project-server isn't the foregrounded tab — so the workflow stalls on
      // an approval step until the owner switches to it (foregrounding wakes
      // the process, the client-side effect then fires the advance). The
      // feedback POST already woke the (possibly napped) server, so kick the
      // tick the instant the last agent finishes — RUN IT SYNCHRONOUSLY in this
      // wake window, NOT via setTimeout: a deferred timer is throttled exactly
      // like the 8s interval (the process naps the moment this response is sent,
      // before the timer fires — the original intermittent-stall bug). The
      // outbound /workflow/advance request the tick issues is active I/O that
      // keeps the process awake through the advance. Respond first so the agent
      // is unblocked promptly, then run the tick.
      // Mutually exclusive with the autoIterate budget path below.
      console.log(`[workflow] Auto-advance (checkbox): agents done, kicking tick synchronously for step=${wf.currentStep}`);
      res.json({ ok: true });
      try { serverSideAutoAdvanceTick(); } catch (e) { console.error('[workflow] Auto-advance tick failed:', e.message); }
      return;
    } else if (allDone && hasFeedback && autoRemaining > 0) {
      wf.autoIterateRemaining = autoRemaining - 1;
      state.saveWorkflow(wf);
      console.log(`[workflow] Auto-iterate: ${autoRemaining - 1} remaining, auto-advancing step=${wf.currentStep}`);
      // Same App-Nap reasoning as above — run synchronously, not on a timer.
      res.json({ ok: true });
      try { autoAdvanceWorkflow(state.loadWorkflow()); } catch (e) { console.error('[workflow] Auto-advance failed:', e.message); }
      return;
    }

    res.json({ ok: true });
  });

  router.post('/workflow/cancel', (req, res) => {
    const wf = state.loadWorkflow();
    if (!wf) return res.status(404).json({ error: 'no active workflow' });
    const deleteWorktrees = req.body?.deleteWorktrees === true;
    // Cancelling a bugfix run releases the bug back to Backlog so it can be
    // re-run later. Do this BEFORE stopWorkflow: if the Fixing flip was still
    // uncommitted, reverting it makes the tree clean again so stopWorkflow can
    // return the checkout to the default branch. Only touch an in-flight Fixing
    // bug — never a bug that already reached Done via a completed merge.
    if (wf.type === 'bugfix' && wf.itemId) {
      try {
        const bug = readItem(projectRoot, config.docs_path || './docs', wf.itemId);
        if (bug && bug.status === 'Fixing') setBugItemStatus(wf.itemId, 'Backlog');
      } catch (e) { console.error('[bugfix] cancel status revert failed:', e.message); }
    }
    stopWorkflow(wf);
    if (deleteWorktrees) {
      try { cleanupBranches(wf); } catch (e) { console.error('[workflow] cancel cleanup error:', e.message); }
    }
    broadcast('worktrees-updated', {});
    res.json({ ok: true, deletedBranches: deleteWorktrees });
  });

  router.post('/workflow/open', (req, res) => {
    const wf = state.loadWorkflow();
    if (!wf) return res.status(404).json({ error: 'no active workflow' });
    tmuxOps.openTerminal(wf.sessionName);
    res.json({ ok: true });
  });

  router.post('/workflow/finish', (req, res) => {
    const wf = state.loadWorkflow();
    if (!wf) return res.status(404).json({ error: 'no active workflow' });
    if (wf.currentStep !== 'completed') return res.status(400).json({ error: 'workflow not completed yet' });
    // Branches already cleaned by merge_to_main — just stop tmux and clear state
    stopWorkflow(wf);
    broadcast('worktrees-updated', {});
    res.json({ ok: true });
  });

  router.post('/workflow/model-override', (req, res) => {
    const wf = state.loadWorkflow();
    if (!wf) return res.status(404).json({ error: 'no active workflow' });
    const { stepModelOverrides, reviewMode, autoIterateRemaining } = req.body;
    if (stepModelOverrides) wf.stepModelOverrides = { ...(wf.stepModelOverrides || {}), ...stepModelOverrides };
    if (reviewMode) wf.reviewMode = reviewMode;
    if (autoIterateRemaining !== undefined) wf.autoIterateRemaining = autoIterateRemaining;
    state.saveWorkflow(wf);
    res.json({ ok: true });
  });

  router.get('/workflow/snapshots', (req, res) => {
    res.json({ snapshots: state.listSnapshots() });
  });

  // PRD-001: commits since an ISO timestamp on the project's HEAD.
  // Powers the monolithic-task commit ribbon UI.
  router.get('/workflow/branch-commits', (req, res) => {
    const since = String(req.query.since || '');
    const max = req.query.max ? parseInt(String(req.query.max)) : 50;
    if (!since) return res.json({ commits: [] });
    const commits = gitOps.commitsSince(since, max);
    res.json({ commits });
  });

  router.get('/workflow/token-stats', (req, res) => {
    // Collect token usage per PRD across all snapshots + current workflow
    const byPrd = {}; // prdId → { tokens, costUSD, snapshots: [] }

    function sumWorkflow(wf) {
      if (!wf) return;
      const prdId = wf.input || wf.id || 'unknown';
      if (!byPrd[prdId]) byPrd[prdId] = { prdId, tokens: 0, costUSD: 0 };
      for (const step of Object.values(wf.steps || {})) {
        // Accumulated tokens from previous agent cycles
        if (step.cumulativeTokens) {
          byPrd[prdId].tokens  += step.cumulativeTokens.inputTokens + step.cumulativeTokens.outputTokens;
          byPrd[prdId].costUSD += step.cumulativeTokens.costUSD;
        }
        // Current agents not yet captured
        for (const agent of (step.agents || [])) {
          if (agent.tokenUsage) {
            byPrd[prdId].tokens  += agent.tokenUsage.inputTokens + agent.tokenUsage.outputTokens;
            byPrd[prdId].costUSD += agent.tokenUsage.costUSD;
          }
        }
      }
      // task_execution agents live under wf.taskExecution.taskStates
      for (const ts of Object.values(wf.taskExecution?.taskStates || {})) {
        if (ts.cumulativeTokens) {
          byPrd[prdId].tokens  += ts.cumulativeTokens.inputTokens + ts.cumulativeTokens.outputTokens;
          byPrd[prdId].costUSD += ts.cumulativeTokens.costUSD;
        }
        for (const agent of (ts.agents || [])) {
          if (agent.tokenUsage) {
            byPrd[prdId].tokens  += agent.tokenUsage.inputTokens + agent.tokenUsage.outputTokens;
            byPrd[prdId].costUSD += agent.tokenUsage.costUSD;
          }
        }
      }
    }

    // Scan all snapshots — deduplicate by prdId (only count each workflow run once
    // by using the latest snapshot per workflow id)
    const seenWfIds = new Set();
    for (const snap of state.listSnapshots()) {
      try {
        const wf = state.restoreSnapshot(snap.name);
        if (!wf || seenWfIds.has(wf.id)) continue;
        seenWfIds.add(wf.id);
        sumWorkflow(wf);
      } catch (_) {}
    }

    // Also include current workflow (may not be snapshotted yet)
    const current = state.loadWorkflow();
    if (current && !seenWfIds.has(current.id)) sumWorkflow(current);

    const prds = Object.values(byPrd)
      .filter(p => p.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens);

    const projectTokens  = prds.reduce((s, p) => s + p.tokens,  0);
    const projectCostUSD = prds.reduce((s, p) => s + p.costUSD, 0);

    res.json({ prds, projectTokens, projectCostUSD: Math.round(projectCostUSD * 10000) / 10000 });
  });

  router.post('/workflow/restore', (req, res) => {
    const { snapshotFile } = req.body;
    if (!snapshotFile) return res.status(400).json({ error: 'snapshotFile is required' });
    try {
      const wf = state.restoreSnapshot(snapshotFile);
      res.json({ workflow: wf, restored: snapshotFile });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.get('/workflow/log', (req, res) => {
    const { window } = req.query;
    const lines = Math.min(parseInt(req.query.lines || '80', 10), 300);
    const wf = state.loadWorkflow();
    if (!wf || !window) return res.json({ log: '' });
    const target = `${wf.sessionName}:${window}`;
    res.json({ log: stripAnsi(tmuxOps.capturePane(target, lines)) });
  });

  // --- Server-side auto-advance ---
  // Controlled by wf.autoAdvance flag (set via POST /workflow/auto-advance).
  // Runs on a timer, checking workflow state and advancing when appropriate.
  let _autoAdvanceTimer = null;

  // Track consecutive auto-advance rejections (HTTP 4xx from /workflow/advance). A gate
  // that keeps refusing — e.g. qa_tests with no committed tests, or qa_validation.strict
  // with failing tests — used to loop every 8s with no signal ("approved but stuck"). After
  // a small ceiling we stash the gate error on the step (wf.steps[x].autoAdvanceError) and
  // stop hammering, so it surfaces instead of spinning silently. Reset on success, on a
  // step change, or when auto-advance is re-enabled.
  let _aaReject = { step: null, count: 0, error: null };
  const AUTO_ADVANCE_MAX_REJECTS = 3;

  function startAutoAdvanceTimer() {
    if (_autoAdvanceTimer) return;
    _autoAdvanceTimer = setInterval(() => {
      try { serverSideAutoAdvanceTick(); } catch (e) { console.error('[auto-advance] tick error:', e.message); }
    }, 8000);
    // Also run immediately
    setTimeout(() => {
      try { serverSideAutoAdvanceTick(); } catch (e) { console.error('[auto-advance] tick error:', e.message); }
    }, 500);
  }

  function stopAutoAdvanceTimer() {
    if (_autoAdvanceTimer) { clearInterval(_autoAdvanceTimer); _autoAdvanceTimer = null; }
  }

  function serverSideAutoAdvanceTick() {
    const wf = state.loadWorkflow();
    if (!wf || !wf.autoAdvance || wf.currentStep === 'completed') {
      stopAutoAdvanceTimer();
      return;
    }

    const step = wf.steps[wf.currentStep];
    if (!step) return;

    // Don't keep hammering a step the gate has repeatedly rejected — it's surfaced via
    // step.autoAdvanceError and needs manual attention (fix + re-enable, override, or skip).
    if (_aaReject.step === wf.currentStep && _aaReject.count >= AUTO_ADVANCE_MAX_REJECTS) return;

    const agents = step.agents || [];
    const allDone = agents.length > 0 && agents.every(a => a.status === 'done' || a.status === 'error');
    const isPending = step.status === 'pending' && agents.length === 0;

    // Steps that always require manual intervention — owner_consultations is
    // the manual gate where the owner reviews PM output and provides notes;
    // demo_review and device_testing need a human in front of the device.
    const alwaysManual = ['demo_review', 'device_testing', 'owner_consultations'];
    if (alwaysManual.includes(wf.currentStep)) return;

    // Review steps used below for verdict-based routing (send_to_devs on blocking).
    // coverage_matrix is intentionally NOT here — it is advisory (its findings are
    // surfaced but never auto-route to a fix loop; the spec-derived matrix is now
    // enforced up front at qa_tests). So it always auto-approves when its agent is done.
    const reviewSteps = ['code_review', 'qa_validation', 'ac_verification', 'security_audit', 'final_review'];

    // Don't auto-advance blocked steps
    if (step.status === 'blocked') return;

    // A step where EVERY agent errored without producing feedback has nothing
    // to advance on. Approving it forward walks a dead workflow to 'completed'
    // with zero output (finance-studio kickoff 2026-07-15: all agents stalled
    // at Claude's folder-trust dialog and auto-advance marched all seven steps
    // to a green "completed"). Halt loudly instead — the hub's paused banner
    // surfaces autoAdvanceError; the owner fixes the cause and relaunches.
    // Manual actions (approve/override/skip) stay available.
    const allErrored = agents.length > 0 && agents.every(a => a.status === 'error');
    if (allErrored && agents.every(a => !a.feedback)) {
      if (!step.autoAdvanceError) {
        step.autoAdvanceError = `all ${agents.length} agent(s) errored with no output — halted instead of advancing past a dead step; fix the cause (see agent errors) and relaunch`;
        state.saveWorkflow(wf);
        console.warn(`[auto-advance] halted on step=${wf.currentStep} — all agents errored with no output`);
      }
      return;
    }

    let action = null;

    if (isPending) {
      const manualSteps = ['merge_to_main', 'capture_learnings'];
      action = manualSteps.includes(wf.currentStep) ? 'approve' : 'launch';
    } else if (allDone) {
      // Detect verdict from agent feedback (server-side detectVerdict)
      const qaStrict = (config.qa_validation && config.qa_validation.strict) !== false;
      const hasBlocking = wf.currentStep === 'qa_tests' ? false : agents.some(a => {
        if (!a.feedback) return false;
        const fb = a.feedback;
        // PRD-002: qa_validation strict mode treats ANY failing test as blocking,
        // overriding the agent's verdict. Only applies to qa_validation step.
        if (wf.currentStep === 'qa_validation' && qaStrict) {
          // Strict mode forces a fix route on any failing test — UNLESS the agent
          // explicitly certified a clean verdict (Approved: yes + Blocking: 0),
          // meaning it triaged every failure as non-blocking (pre-existing / flaky
          // / out of PRD scope). Honour that structured verdict; otherwise a green
          // PRD run with known pre-existing failures spawns a phantom fix round the
          // fix_planner can't satisfy (example-ios PRD-025, 2026-06-03).
          const cleanApproval = /\*\*Approved:\*\*\s*yes\b/i.test(fb)
            && /\*\*Blocking:\*\*\s*0\b/i.test(fb);
          if (!cleanApproval) {
            const failMatch = fb.match(/(\d+)\s+(?:failed|failures)\b/i)
              || fb.match(/\*\*Failures:\*\*\s*(\d+)/i)
              || fb.match(/\((\d+)\s+failed/i);
            if (failMatch && parseInt(failMatch[1]) > 0) return true;
          }
        }
        const approvedMatch = fb.match(/\*\*Approved:\*\*\s*(yes|no)/i);
        if (approvedMatch) {
          if (approvedMatch[1].toLowerCase() === 'yes') return false;
          const blockingMatch = fb.match(/\*\*Blocking:\*\*\s*(\d+)/i);
          const failuresMatch = fb.match(/\*\*Failures:\*\*\s*(\d+)/i);
          return (blockingMatch && parseInt(blockingMatch[1]) > 0) || (failuresMatch && parseInt(failuresMatch[1]) > 0);
        }
        const fixMatch = fb.match(/\*\*All issues addressed:\*\*\s*(yes|no)/i);
        if (fixMatch) return fixMatch[1].toLowerCase() !== 'yes';
        const verdictMatch = fb.match(/\*\*Verdict:\*\*\s*(.*)/i);
        if (verdictMatch) {
          const v = verdictMatch[1].toLowerCase();
          if (/approve/i.test(v)) return false;
          if (/changes requested|blocking/i.test(v)) return true;
        }
        return false;
      });

      const isReviewStep = reviewSteps.includes(wf.currentStep);
      const isReviewFlowStep = ['reviewing', 'team_review'].includes(wf.currentStep);

      // Strict auto-advance (review workflows, opt-in checkbox): ANY reported
      // finding — medium/low included, or a non-approval — sends the round back
      // to PM instead of approving. Default behavior only bounces on blocking.
      // Capped by max_review_rounds so persistent low-severity nitpicks can't
      // loop forever: at the cap it falls back to the default (approve unless
      // blocking). Scoped to the 'reviewing' step — that's where send_to_pm lives.
      let strictEscalate = false;
      if (wf.autoAdvanceStrict && wf.currentStep === 'reviewing' && !hasBlocking) {
        const maxRounds = config.max_review_rounds || 4;
        const anyFindings = agents.some(a => {
          const fb = a.feedback;
          if (!fb) return false;
          if (/\*\*Approved:\*\*\s*no\b/i.test(fb)) return true;
          return [/\*\*Blocking:\*\*\s*(\d+)/i, /\*\*Medium:\*\*\s*(\d+)/i, /\*\*Low:\*\*\s*(\d+)/i]
            .some(re => { const m = fb.match(re); return m && parseInt(m[1]) > 0; });
        });
        strictEscalate = anyFindings && (wf.round || 1) < maxRounds;
        if (anyFindings && !strictEscalate) {
          console.log(`[auto-advance] strict: findings remain but round cap reached (${wf.round}/${maxRounds}) — approving`);
        }
      }

      if (hasBlocking && isReviewStep) {
        action = 'send_to_devs';
      } else if ((hasBlocking || strictEscalate) && isReviewFlowStep) {
        action = 'send_to_pm';
      } else {
        action = 'approve';
      }
    }

    if (!action) return;

    console.log(`[auto-advance] step=${wf.currentStep} action=${action}`);

    const http = require('http');
    const body = JSON.stringify({ action });
    const advReq = http.request({
      hostname: 'localhost',
      port: config.port,
      path: '/api/workflow/advance',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (advRes) => {
      let data = '';
      advRes.on('data', c => data += c);
      advRes.on('end', () => {
        let result = {};
        try { result = JSON.parse(data) || {}; } catch (_) {}

        // Gate rejected the action (4xx). Don't swallow it silently — count consecutive
        // rejections for this step, and once over the ceiling stash the reason on the step
        // and stop retrying so it stops looping invisibly.
        if (advRes.statusCode >= 400) {
          const errMsg = result.error || `HTTP ${advRes.statusCode}`;
          _aaReject = _aaReject.step === wf.currentStep
            ? { step: wf.currentStep, count: _aaReject.count + 1, error: errMsg }
            : { step: wf.currentStep, count: 1, error: errMsg };
          console.warn(`[auto-advance] ${wf.currentStep} ${action} rejected (#${_aaReject.count}): ${errMsg}`);
          if (_aaReject.count >= AUTO_ADVANCE_MAX_REJECTS) {
            try {
              const w = state.loadWorkflow();
              if (w && w.steps && w.steps[wf.currentStep]) {
                w.steps[wf.currentStep].autoAdvanceError = errMsg;
                state.saveWorkflow(w);
              }
            } catch (_) {}
            console.warn(`[auto-advance] paused on step=${wf.currentStep} after ${_aaReject.count} rejections — needs manual attention (fix + re-enable, override, or skip)`);
          }
          return;
        }

        // Success — clear any rejection state for this step and continue the chain.
        if (_aaReject.step === wf.currentStep) _aaReject = { step: null, count: 0, error: null };
        if (result.needsAdvance) {
          // Fire the follow-up launch IMMEDIATELY, not on a timer. A backgrounded
          // project-server naps the instant this response socket closes, and a
          // setTimeout(1500) would then fire late/never (leaving e.g. qa_tests
          // approved but task_execution unlaunched until foregrounded). Issuing
          // the outbound request now keeps active I/O and completes the chain in
          // the same wake window. The advance already persisted state, so there's
          // nothing to wait for.
          const launchBody = JSON.stringify({ action: 'launch' });
          const launchReq = http.request({
            hostname: 'localhost', port: config.port,
            path: '/api/workflow/advance', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(launchBody) },
          }, () => {});
          launchReq.on('error', () => {});
          launchReq.write(launchBody);
          launchReq.end();
        }
      });
    });
    advReq.on('error', e => console.error('[auto-advance] HTTP error:', e.message));
    advReq.write(body);
    advReq.end();
  }

  // Toggle auto-advance on/off — persisted in workflow state
  router.post('/workflow/auto-advance', (req, res) => {
    const wf = state.loadWorkflow();
    if (!wf) return res.status(404).json({ error: 'no active workflow' });
    // Only touch what the request carries: a strict-only toggle must not flip
    // the enabled state (enabled used to default to true when omitted).
    if (req.body.enabled !== undefined) wf.autoAdvance = req.body.enabled !== false;
    // Strict mode (review workflows): ANY reported finding — medium/low included —
    // sends the round back to PM instead of approving; capped by max_review_rounds.
    if (req.body.strict !== undefined) wf.autoAdvanceStrict = !!req.body.strict;
    const enabled = !!wf.autoAdvance;
    if (enabled) {
      // Re-enabling is the owner's "try again" — clear any prior rejection pause + stashed
      // error so a step that previously stalled gets a fresh attempt.
      _aaReject = { step: null, count: 0, error: null };
      const cur = wf.steps && wf.steps[wf.currentStep];
      if (cur && cur.autoAdvanceError) delete cur.autoAdvanceError;
    }
    state.saveWorkflow(wf);
    if (enabled) startAutoAdvanceTimer();
    else stopAutoAdvanceTimer();
    console.log(`[auto-advance] ${enabled ? 'enabled' : 'disabled'}${wf.autoAdvanceStrict ? ' (strict)' : ''}`);
    return res.json({ autoAdvance: enabled, autoAdvanceStrict: !!wf.autoAdvanceStrict });
  });

  // Resume auto-advance timer on server start if workflow has it enabled
  {
    const wf = state.loadWorkflow();
    if (wf?.autoAdvance && wf.currentStep !== 'completed') {
      console.log('[auto-advance] Resuming auto-advance timer from saved state');
      startAutoAdvanceTimer();
    }
  }

  router.post('/workflow/advance', (req, res) => {
    const { action, notes } = req.body;
    const wf = state.loadWorkflow();
    if (!wf) return res.status(404).json({ error: 'no active workflow' });

    // --- Relaunch: reset current step and re-enter it ---
    if (action === 'relaunch') {
      const step = wf.steps[wf.currentStep];
      if (!step) return res.status(400).json({ error: 'no step to relaunch' });
      console.log(`[workflow] Relaunching step=${wf.currentStep}`);
      // Kill any running agent windows for this step (including duplicates from failed relaunches)
      if (step.agents) {
        const { execFileSync } = require('child_process');
        const windowNames = new Set(step.agents.filter(a => a.window).map(a => a.window));
        // List all windows and kill any matching the agent window names
        try {
          const windowList = execFileSync('tmux', ['list-windows', '-t', wf.sessionName, '-F', '#{window_index} #{window_name}'], { encoding: 'utf8' }).trim();
          const toKill = [];
          for (const line of windowList.split('\n')) {
            const [idx, name] = line.split(' ', 2);
            // Match exact name or name with tmux suffix (design, design-, design~)
            const baseName = name.replace(/[-~*]$/, '');
            if (windowNames.has(name) || windowNames.has(baseName)) {
              toKill.push(idx);
            }
          }
          // Kill in reverse order to avoid index shifting
          for (const idx of toKill.reverse()) {
            try { execFileSync('tmux', ['kill-window', '-t', `${wf.sessionName}:${idx}`], { stdio: 'ignore' }); } catch {}
          }
        } catch {}
      }
      // Reset step to pending so the step-specific handler re-launches it
      wf.steps[wf.currentStep] = { status: 'pending', agents: [] };
      state.saveWorkflow(wf);
      // Re-enter the advance handler with 'launch' action
      req.body.action = 'launch';
      // Fall through to the step-specific handlers below
    }

    // Use the potentially-updated action (relaunch sets req.body.action = 'launch' above)
    const effectiveAction = req.body.action;

    try {
      // --- Kickoff workflow transitions ---
      if (wf.type === 'kickoff') {
        return handleKickoffAdvance(wf, effectiveAction, notes, res);
      }

      // --- Review workflow transitions ---
      if (wf.type === 'review') {
        return handleReviewAdvance(wf, effectiveAction, notes, res);
      }

      // --- Execution + bugfix workflow transitions ---
      // Bugfix reuses the execution engine (task_execution → qa_validation →
      // code_review → merge_to_main → capture_learnings); the handler branches on
      // wf.type where the bugfix step sequence diverges from execution's.
      if (wf.type === 'execution' || wf.type === 'bugfix') {
        return handleExecutionAdvance(wf, effectiveAction, notes, res, req.body);
      }

      // --- Onboarding workflow transitions (PRD-001) ---
      if (wf.type === 'onboarding') {
        return handleOnboardingAdvance(wf, effectiveAction, notes, res);
      }

      res.status(400).json({ error: `unknown workflow type: ${wf.type}` });
    } catch (e) {
      console.error('[workflow] advance error:', e);
      if (!res.headersSent) res.status(500).json({ error: e.message || 'Internal error in advance handler' });
    }
  });

  // --- Sequential task execution helpers ---
  const MAX_FIX_CYCLES = 3;

  function initTaskExecution(wf) {
    const tasks = wf.taskPlan.tasks;
    wf.taskExecution = {
      currentTaskIndex: 0,
      taskStates: Object.fromEntries(tasks.map((_, i) => [String(i), {
        status: 'pending',
        startedAt: null,
        completedAt: null,
        tokenUsage: null,
        agentSummary: null,
        agents: [],
        fixCycles: 0,
        fixHistory: [],
      }])),
    };
  }

  function buildTaskContext(wf) {
    const prdPath = wf.prdPath;
    let companionContext = '';
    let penFiles = [];
    try {
      const prdContent = fs.readFileSync(path.join(docsPath, prdPath || ''), 'utf8');
      // Match the Companion Specs section by heading NAME first — PRD formats
      // drifted per project (example-web "## 6. Companion specs", example-ios
      // "## Companion Specs", legacy "## §10 …"); the number-anchored regex
      // silently matched nothing on newer formats, dropping companion-spec
      // pointers AND the .pen design context from builder prompts.
      let m = prdContent.match(/^##\s+[^\n]*\bcompanion\s+specs?\b[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/im);
      if (!m) m = prdContent.match(/## §?10[.\s].*?\n([\s\S]*?)(?=\n## §?\d|$)/);
      if (m) {
        const doneSpecs = [];
        for (const line of m[1].split('\n')) {
          if (/\|\s*Done\s*\|/i.test(line)) {
            const cells = line.split('|').map(c => c.trim()).filter(c => c);
            if (cells.length >= 3) {
              doneSpecs.push(`- ${cells[0]}: \`${cells[cells.length - 1]}\``);
              if (/\.pen\b|pencil|visual design/i.test(line)) penFiles.push(cells[cells.length - 1]);
            }
          }
        }
        if (doneSpecs.length > 0) companionContext = `\n\n## Companion Specs (read these):\n${doneSpecs.join('\n')}`;
      }
    } catch {}
    return { companionContext, penFiles };
  }

  function launchTaskImpl(wf, taskIdx) {
    const task = wf.taskPlan.tasks[taskIdx];
    const n = wf.taskPlan.tasks.length;
    const prdPath = wf.prdPath;
    const { companionContext, penFiles } = buildTaskContext(wf);
    // Accept both `roles` (plural array) and `role` (singular string) from the planner.
    // The planner prompt's JSON schema isn't strictly documented; observed plans use
    // either shape. Falling back silently to "no roles" caused all PRD-009 tasks to
    // skip with status=done + 0 agents (2026-05-22) — never run, never built.
    const taskRoles = Array.isArray(task.roles) && task.roles.length > 0
      ? task.roles
      : (task.role ? [task.role] : []);
    const taskState = wf.taskExecution.taskStates[String(taskIdx)];

    // Pick only the first matching role
    const firstRoleName = taskRoles[0];
    const role = firstRoleName
      ? (require('../config').findRole(config, firstRoleName) || (config.roles.execution || []).find(r => r.role.toLowerCase() === firstRoleName.toLowerCase()))
      : null;

    if (!role) {
      taskState.status = 'done'; // skip — no matching roles
      taskState.completedAt = new Date().toISOString();
      return [];
    }

    const isFrontend = role.role.toLowerCase().includes('frontend');
    const usePlaywright = config.features && config.features.playwright_cli;

    // Test-impact pre-analysis for regression-smoke tasks. Catches the
    // PRD-008 t39/t40 class: "run all PRD-005 tests to verify nothing broke"
    // is structurally wasteful when only 3 of 46 files were touched. Compute
    // the affected test files once at task-launch time and hand the list to
    // the agent. Falls back to no-op if git diff fails or no test files match.
    let testImpactContext = '';
    try {
      const taskText = `${task.name || ''} ${task.description || ''}`;
      const isRegressionSmoke = /regression\s+smoke|smoke\s+test|verify.*nothing\s+broke|regression\s+(?:check|verification)/i.test(taskText);
      // iOS test-impact analysis is driven entirely by the project's Xcode scheme
      // (config.simulator.scheme); all paths/target names derive from that scheme.
      // Without a scheme configured, the block no-ops.
      const iosScheme = config.simulator && config.simulator.scheme;
      const iosSourceDir = (config.simulator && config.simulator.source_dir) || (iosScheme && `ios/${iosScheme}`);
      if (isRegressionSmoke && iosScheme) {
        const { execFileSync: ex } = require('child_process');
        let base = '';
        try {
          base = ex('git', ['merge-base', 'origin/main', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim();
        } catch { /* no origin/main — try main */ }
        if (!base) {
          try { base = ex('git', ['merge-base', 'main', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' }).trim(); } catch {}
        }
        if (base) {
          const changed = ex('git', ['diff', '--name-only', `${base}...HEAD`], { cwd: projectRoot, encoding: 'utf8' })
            .split('\n').filter(l => l.trim() && /\.swift$/.test(l));
          // Map source files to candidate test files by naming convention.
          // <Name>.swift → <Name>Tests.swift OR Tests/.../<Name>*Tests.swift
          const sourceBasenames = changed
            .filter(p => p.startsWith(`${iosSourceDir}/`))
            .map(p => p.split('/').pop().replace(/\.swift$/, ''))
            .filter(Boolean);
          const allTestFiles = ex('find', [`ios/${iosScheme}Tests`, `ios/${iosScheme}UITests`, '-name', '*Tests.swift'], { cwd: projectRoot, encoding: 'utf8' })
            .split('\n').filter(Boolean);
          const relevant = new Set();
          for (const src of sourceBasenames) {
            for (const tf of allTestFiles) {
              if (tf.includes(src + 'Tests') || tf.includes(src + 'UITests') || tf.includes(src + 'SnapshotTests')) {
                relevant.add(tf);
              }
            }
          }
          // Foundation file → widen scope (signal to agent to run target instead of cherry-picking)
          const foundationFiles = [`${iosScheme}Schema.swift`, 'Constants.swift', 'Theme.swift', `${iosScheme}App.swift`, 'AppRoot.swift'];
          const touchedFoundation = changed.some(p => foundationFiles.some(f => p.endsWith(f)) || p.startsWith(`${iosSourceDir}/Data/Models/`));
          if (touchedFoundation) {
            testImpactContext = `\n\n## TEST IMPACT — foundation file touched\n\nThe diff (${base.slice(0,7)}…HEAD) touches a foundation file (schema, Constants, Theme, or Data/Models/). Blast radius is unknowable — run the full test target rather than cherry-picking. Changed files (truncated):\n\n${changed.slice(0, 30).map(f => `- ${f}`).join('\n')}\n`;
          } else if (relevant.size > 0) {
            const list = [...relevant].sort();
            testImpactContext = `\n\n## TEST IMPACT — pre-computed for this regression smoke\n\nThe diff (${base.slice(0,7)}…HEAD) touches ${sourceBasenames.length} source file(s). Tests covering those files (by naming convention):\n\n${list.map(f => `- ${f}`).join('\n')}\n\nRun ONLY these via \`-only-testing\`. Do NOT run unrelated tests. If you suspect the convention-based mapping missed a relevant test, name the specific test (not the whole target) and justify in your feedback.\n`;
          } else {
            testImpactContext = `\n\n## TEST IMPACT — no test files match changed sources\n\nThe diff (${base.slice(0,7)}…HEAD) touches ${sourceBasenames.length} source file(s) but none have matching \`*Tests.swift\` files by naming convention. Either: (a) the changed code is genuinely untested (raise this as a finding), or (b) tests use a non-standard naming scheme — locate them manually before running. Do NOT default to running the full target.\n`;
          }
        }
      }
    } catch (e) {
      // Test-impact analysis is best-effort; don't fail the task launch.
      console.log(`[workflow] test-impact analysis skipped: ${e.message}`);
    }

    const pencilMcpCheck = `\n\n### PENCIL MCP — CHECK BEFORE READING .pen FILES\nBefore reading any .pen design file, call \`get_editor_state\` to verify the Pencil MCP is available.\nIf the call fails (tool not found, connection refused, timeout), **STOP IMMEDIATELY**.\nDo NOT skip design verification. Do NOT proceed without reading the design.\nReport in your feedback: "BLOCKED: Pencil MCP unavailable — please start the Pencil app and re-run this step."`;
    const designContext = isFrontend && penFiles.length > 0
      ? `\n\n## VISUAL DESIGN — MANDATORY\nFollow the Pencil design: ${penFiles.join(', ')}\nRead the .pen file before coding. Match it pixel-for-pixel.${pencilMcpCheck}${usePlaywright ? `\n\n### Self-verification with playwright-cli (REQUIRED before reporting done)\n1. Export the design: Pencil MCP \`export_nodes\` → PNG at 2x scale → \`/tmp/design.png\`\n2. Screenshot your implementation:\n\`\`\`bash\nplaywright-cli open http://localhost:${config.port || 3000}/<path>\nplaywright-cli resize 1440 900\nplaywright-cli screenshot --filename /tmp/impl.png --full-page\nplaywright-cli close\n\`\`\`\n3. Run the heatmap diff (see docs/wow/web-design-workflow.md)\n4. Fix if < 85% match, report match % in feedback` : ' Run heatmap verification before reporting done.'}`
      : '';

    // builder_strategy: 'goal' arms Claude Code's native /goal harness on the
    // monolithic builder session — the CLI re-checks the objective after every
    // response and keeps the session working until it is met, so a premature
    // "done" declaration doesn't end the run. There is no CLI flag for /goal;
    // launchWorkflowAgents schedules a tmux paste of the goal line shortly
    // after session start. Scoped to monolithic Claude sessions: fine-grained
    // tasks are small enough that the harness adds nothing, and Codex has no
    // /goal equivalent.
    // A maintained repo map (component locations, guardrails, test infra) cuts
    // the builder's initial exploration cost — point at it when it exists, and
    // make keeping it current part of the change.
    const archNote = fs.existsSync(path.join(projectRoot, 'ARCHITECTURE.md'))
      ? `\nBefore exploring the codebase, read ARCHITECTURE.md at the repo root — the maintained component map, guardrails, and test-infrastructure notes. Don't re-derive what it already tells you. If your changes alter the component map (new module, moved responsibility, new seam), update ARCHITECTURE.md in the same commit.\n`
      : '';

    const useGoalHarness = (config.builder_strategy || 'role') === 'goal'
      && wf.taskPlan && wf.taskPlan.monolithic
      && wf.developerCli !== 'codex';
    const goalCondition = useGoalHarness
      ? `Every acceptance criterion of the PRD at ${prdPath} is implemented; the COMPLETE test suite (including the pre-implementation tests committed before this session started) has been run and passes; all work is committed on the current branch; and the feedback POST from the prompt file has been sent successfully, including a per-AC evidence table.`
      : null;
    const goalContext = useGoalHarness
      ? `\n\n## GOAL HARNESS — /goal IS ARMED ON THIS SESSION\nShortly after this session starts, the dashboard sets a native /goal objective on it:\n\n> ${goalCondition}\n\nClaude Code re-checks that objective after every response and keeps the session working until it is met — declaring "done" early will not end the session. Two consequences for how you work:\n- The objective requires the COMPLETE test suite, not a relevant subset. Iterate on targeted tests while implementing, but the final verification run is the full suite.\n- Your feedback POST must include a per-AC evidence table: \`| AC | Implemented | Tested | Evidence |\`, one row per acceptance criterion, with the test name or commit as evidence.`
      : '';

    const devAgents = [{
      goalCondition,
      role: role.role,
      window: `t${taskIdx + 1}-${role.role.toLowerCase().replace(/\s+/g, '-').slice(0, 8)}`,
      status: 'pending',
      reportFeedback: true,
      taskIndex: taskIdx,
      instruction: `## REQUIRED FEEDBACK POST FORMAT — READ THIS FIRST

The feedback POST at the end of this task is HOW THE WORKFLOW KNOWS YOU ARE DONE. If it fails silently the workflow stalls until a human intervenes.

**Copy the curl VERBATIM from the bottom of this prompt. Do NOT reconstruct it from memory** (especially after a context-compaction event — agents recreate the curl wrong and lose two fields):
- \`role\` MUST be \`"${role.role}"\` exactly — case-sensitive, with spaces. NOT \`"${role.role.toLowerCase().replace(/\s+/g, '_')}"\`, NOT \`"${role.role.toLowerCase().replace(/\s+/g, '')}"\`, NOT any other variation.
- \`taskIndex\` MUST be the integer \`${taskIdx}\` (zero-indexed: this is Task ${taskIdx + 1}, index ${taskIdx}). Required field. Not a string.

If you have been compacted and lost this prompt, the original is in your current working directory as \`prompt-*.txt\` — \`ls prompt-*.txt\` then read it to recover the exact curl line.

---

You are a ${role.role}. Read your role definition at .claude/commands/${role.command} first.
${archNote}
Implement TASK ${taskIdx + 1} of ${n} for this PRD.
${wf.branch ? `\n**Branch discipline:** the workflow has already checked out this run's branch (\`${wf.branch}\`) in your working directory. Commit your work directly on the CURRENT branch — do NOT create, switch, or rename branches, and do NOT open a PR. The workflow merges \`${wf.branch}\` into \`${wf.defaultBranch || 'main'}\` and deletes it when the run ends.\n` : ''}
PRD path: ${prdPath}

## YOUR TASK (${taskIdx + 1}/${n})

**${task.name}**

${task.description}

ACs covered: ${(task.acs_covered || []).join(', ') || 'see task description'}

## CONTEXT
${taskIdx > 0 ? `Tasks 1–${taskIdx} are already implemented and committed. Your task builds on that work.` : 'This is the first task.'}

## SCOPE — CRITICAL
Only implement what this task describes. Do NOT implement other tasks.
Do NOT refactor code outside this task scope.${companionContext}${designContext}${testImpactContext}${goalContext}

Use the /${role.skill} skill. Commit your changes when done. ${COMMIT_ON_CURRENT_BRANCH}`,
    }];

    taskState.status = 'running';
    taskState.startedAt = new Date().toISOString();
    taskState.agents = launchWorkflowAgents(wf, devAgents, { useWorktrees: false, stepKey: 'task_execution' });
    return taskState.agents;
  }

  function launchNextTask(wf) {
    const tasks = wf.taskPlan.tasks;
    const tex = wf.taskExecution;
    // Find first pending task
    const idx = tasks.findIndex((_, i) => tex.taskStates[String(i)]?.status === 'pending');
    if (idx === -1) {
      wf.steps.task_execution.status = 'completed';
      const fakeRes = { json: () => {}, status: () => ({ json: () => {} }) };
      // Bugfix has no merge_for_review step and runs the single fix task directly
      // on wf.branch (no worktree dev branches to integrate). Advance to the next
      // step in ITS sequence (qa_validation) and launch it, rather than the
      // execution-only merge_for_review path below.
      if (wf.type === 'bugfix') {
        const next = nextStepInSequence(wf, config, 'task_execution') || 'qa_validation';
        console.log(`[workflow] Bugfix task complete. Advancing to ${next}.`);
        wf.currentStep = next;
        if (!wf.steps[next]) wf.steps[next] = { status: 'pending', agents: [] };
        state.saveWorkflow(wf);
        try { handleExecutionAdvance(wf, 'launch', null, fakeRes, {}); } catch (e) {
          console.error(`[workflow] bugfix advance to ${next} failed:`, e.message);
        }
        return;
      }
      // All tasks done — merge any worktree branches, then advance to code_review
      console.log('[workflow] All tasks complete. Merging branches for final review.');
      wf.currentStep = 'merge_for_review';
      state.saveWorkflow(wf);
      try { mergeDevBranches(wf, fakeRes); } catch (e) {
        console.error('[workflow] merge after task execution failed:', e.message);
      }
      return;
    }
    launchTaskImpl(wf, idx);
    state.saveWorkflow(wf);
  }

  function launchTaskReview(wf, taskIdx) {
    const task = wf.taskPlan.tasks[taskIdx];
    const n = wf.taskPlan.tasks.length;
    const prdId = wf.input.replace(/\s+/g, '-');
    const taskState = wf.taskExecution.taskStates[String(taskIdx)];

    // Run reviewer in the task's impl worktree (first branch)
    const implBranch = (taskState.branches || [])[0];
    const reviewCwd = implBranch ? path.join(worktreesPath, implBranch) : projectRoot;

    const crAgent = [{
      role: 'Code Reviewer',
      window: `cr-t${taskIdx + 1}`,
      status: 'pending',
      reportFeedback: true,
      taskIndex: taskIdx,
      instruction: `Quick code review of TASK ${taskIdx + 1} of ${n}: "${task.name}".

PRD path: ${wf.prdPath}

Use the /code_reviewer skill. Review only the changes introduced by this task (git diff main...HEAD). Focused review — not a full audit.`,
    }];

    taskState.status = 'reviewing';
    taskState.agents = launchWorkflowAgents(wf, crAgent, { useWorktrees: false, cwd: reviewCwd, stepKey: 'code_review' });
    return taskState.agents;
  }

  function launchTaskFix(wf, taskIdx, reviewFeedback) {
    const task = wf.taskPlan.tasks[taskIdx];
    const n = wf.taskPlan.tasks.length;
    const prdId = wf.input.replace(/\s+/g, '-');
    const prdPath = wf.prdPath;
    const taskState = wf.taskExecution.taskStates[String(taskIdx)];
    const cycle = taskState.fixCycles;

    // Build prior fix history so agent doesn't repeat failed approaches
    let priorFixContext = '';
    if (cycle > 1 && taskState.fixHistory && taskState.fixHistory.length > 0) {
      priorFixContext = '\n\n## Prior Fix Attempts (did NOT resolve all issues — try a different approach)\n\n' +
        taskState.fixHistory.map((h, i) =>
          `### Attempt ${i + 1}\nReview feedback: ${h.reviewFeedback?.slice(0, 500) || 'n/a'}\nFix agent summary: ${h.fixSummary?.slice(0, 300) || 'n/a'}`
        ).join('\n\n');
    }

    const fixAgents = (task.roles || []).map(roleName => {
      const role = require('../config').findRole(config, roleName) || (config.roles.execution || []).find(r => r.role.toLowerCase() === roleName.toLowerCase());
      if (!role) return null;
      const branch = `${role.branch_prefix}-${prdId}-t${taskIdx + 1}`;
      return {
        role: role.role,
        branch,
        window: `t${taskIdx + 1}-fix${cycle}-${role.role.toLowerCase().replace(/\s+/g, '-').slice(0, 5)}`,
        status: 'pending',
        reportFeedback: true,
        taskIndex: taskIdx,
        instruction: `You are a ${role.role}. Read your role definition at .claude/commands/${role.command} first.

Fix the code review issues for TASK ${taskIdx + 1} of ${n}: "${task.name}".

PRD path: ${prdPath}

## Code Review Feedback (fix cycle ${cycle}/${MAX_FIX_CYCLES}):
${reviewFeedback}
${priorFixContext}
Fix only the issues raised. Commit your changes.`,
      };
    }).filter(Boolean);

    taskState.status = 'fixing';
    taskState.agents = launchWorkflowAgents(wf, fixAgents, { useWorktrees: true, stepKey: 'task_execution' });
    return taskState.agents;
  }

  function updateStepAgents(wf) {
    const allAgents = [];
    for (const [idx, ts] of Object.entries(wf.taskExecution.taskStates)) {
      if (ts.status === 'running') {
        for (const a of (ts.agents || [])) allAgents.push({ ...a, taskIndex: Number(idx) });
      }
    }
    if (wf.steps.task_execution) wf.steps.task_execution.agents = allAgents;
  }

  // Accumulate token usage from current agents onto ts.cumulativeTokens
  // before the agents array is overwritten by the next phase.
  function captureAgentTokens(ts) {
    if (!ts.cumulativeTokens) {
      ts.cumulativeTokens = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, costUSD: 0 };
    }
    for (const a of (ts.agents || [])) {
      if (a.tokenUsage) {
        ts.cumulativeTokens.inputTokens  += a.tokenUsage.inputTokens  || 0;
        ts.cumulativeTokens.outputTokens += a.tokenUsage.outputTokens || 0;
        ts.cumulativeTokens.cacheRead    += a.tokenUsage.cacheRead    || 0;
        ts.cumulativeTokens.cacheCreate  += a.tokenUsage.cacheCreate  || 0;
        ts.cumulativeTokens.costUSD      += a.tokenUsage.costUSD      || 0;
      }
    }
  }

  // Same for non-task steps (code_review, qa_validation, etc.)
  function captureStepAgentTokens(step) {
    if (!step.cumulativeTokens) {
      step.cumulativeTokens = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0, costUSD: 0 };
    }
    for (const a of (step.agents || [])) {
      if (a.tokenUsage) {
        step.cumulativeTokens.inputTokens  += a.tokenUsage.inputTokens  || 0;
        step.cumulativeTokens.outputTokens += a.tokenUsage.outputTokens || 0;
        step.cumulativeTokens.cacheRead    += a.tokenUsage.cacheRead    || 0;
        step.cumulativeTokens.cacheCreate  += a.tokenUsage.cacheCreate  || 0;
        step.cumulativeTokens.costUSD      += a.tokenUsage.costUSD      || 0;
      }
    }
  }

  function handleTaskFeedback(wf, taskIdx, role, feedback, res) {
    const tex = wf.taskExecution;
    if (!tex) return res.status(400).json({ error: 'task execution not initialized' });
    const taskState = tex.taskStates[String(taskIdx)];
    if (!taskState) return res.status(400).json({ error: `task ${taskIdx} not found` });

    // Record feedback on the matching agent
    const agent = (taskState.agents || []).find(a => normalizeRole(a.role) === normalizeRole(role));
    if (agent) {
      agent.feedback = feedback;
      agent.status = 'done';
      agent.completedAt = new Date().toISOString();
      if (agent.startedAt && agent.agentCwd) {
        agent.tokenUsage = computeTokenUsage(agent.startedAt, agent.completedAt, agent.agentCwd, agent.model);
      }
    }

    // Evidence sanity-check: agents sometimes claim to have committed files or
    // produced screenshots that don't exist (T18 on example-ios PRD-001 wrote a PR-
    // evidence doc claiming "screenshot confirms all elements match" with no
    // screenshot file in git). Scan for `Committed: <sha>` and "Created `path`"
    // patterns; verify each. Non-blocking — just attach warnings to the task
    // state so the AC verifier / merge gate can see them.
    const evidenceWarnings = [];
    const shaMatches = feedback.match(/\*\*Committed:\*\*\s*`?([0-9a-f]{7,40})`?/gi) || [];
    for (const m of shaMatches) {
      const sha = m.match(/([0-9a-f]{7,40})/i)?.[1];
      if (!sha) continue;
      try {
        const { execFileSync } = require('child_process');
        execFileSync('git', ['rev-parse', '--verify', sha], { cwd: projectRoot, stdio: 'ignore' });
      } catch {
        evidenceWarnings.push(`Claimed commit ${sha} not reachable from ${projectRoot}`);
      }
    }
    // Find Markdown-backticked paths that look like committed artifacts.
    const pathRe = /`((?:docs|src|ios|android|packages|scripts|tests|e2e|tmp|public)\/[A-Za-z0-9_\/.\-]+\.(?:md|png|jpg|jpeg|svg|txt|html|json|swift|ts|tsx|js|jsx|kt|java|py|go|rs|yml|yaml))`/g;
    const claimed = new Set();
    for (const p of feedback.matchAll(pathRe)) claimed.add(p[1]);
    for (const rel of claimed) {
      const abs = path.join(projectRoot, rel);
      if (!fs.existsSync(abs)) evidenceWarnings.push(`Claimed file does not exist: ${rel}`);
    }
    if (evidenceWarnings.length > 0) {
      taskState.evidenceWarnings = (taskState.evidenceWarnings || []).concat(evidenceWarnings);
      console.warn(`[workflow] task ${taskIdx + 1} feedback contains ${evidenceWarnings.length} unverifiable artifact reference(s): ${evidenceWarnings.join('; ')}`);
    }

    // Log to global feedback list
    const feedbackEntry = { role, feedback, taskIndex: taskIdx, step: 'task_execution', round: wf.round, at: new Date().toISOString() };
    wf.feedback.push(feedbackEntry);
    appendTelemetryLog(wf, feedbackEntry);

    // Track learnings effectiveness
    if (agent) trackLearningsEffectiveness(agent.injectedLearnings, feedback);

    state.saveWorkflow(wf);
    res.json({ ok: true });

    // Check if all agents for this task are done
    const allDone = (taskState.agents || []).every(a => a.status === 'done' || a.status === 'error');
    if (!allDone) return;

    // Run the per-task state machine asynchronously (after response returns)
    setTimeout(() => {
      const wf2 = state.loadWorkflow();
      if (!wf2 || wf2.currentStep !== 'task_execution') return;
      const tex2 = wf2.taskExecution;
      if (!tex2) return;
      const ts2 = tex2.taskStates[String(taskIdx)];
      if (!ts2) return;

      if (ts2.status === 'running') {
        // Implementation phase done → capture tokens before transition
        captureAgentTokens(ts2);
        ts2.status = 'done';
        ts2.completedAt = new Date().toISOString();

        // Legacy ts.tokenUsage — keep for backward compat but cumulativeTokens is authoritative
        const agent = (ts2.agents || []).find(a => a.status === 'done');
        if (agent?.startedAt && agent?.agentCwd) {
          ts2.tokenUsage = computeTokenUsage(agent.startedAt, agent.completedAt, agent.agentCwd, agent.model);
        }
        // Agent summary: first non-empty line of feedback
        const rawFeedback = (ts2.agents || []).find(a => a.feedback)?.feedback || '';
        ts2.agentSummary = rawFeedback.replace(/^#+\s*/gm, '').split('\n').find(l => l.trim().length > 10)?.slice(0, 120) || null;

        updateStepAgents(wf2);
        state.saveWorkflow(wf2);
        console.log(`[workflow] Task ${taskIdx + 1} done. Launching next task.`);
        launchNextTask(wf2);
      } else if (ts2.status === 'reviewing') {
        // Code review done → capture tokens before potential fix/done transition
        captureAgentTokens(ts2);
        const reviewFeedback = (ts2.agents || []).filter(a => a.feedback).map(a => a.feedback).join('\n\n');
        const hasBlockingIssues = reviewFeedback && (
          /blocking/i.test(reviewFeedback) &&
          !(/no blocking/i.test(reviewFeedback) || /0 blocking/i.test(reviewFeedback))
        );

        if (hasBlockingIssues && (ts2.fixCycles || 0) < MAX_FIX_CYCLES) {
          // Record fix history for context in next cycle
          if (!ts2.fixHistory) ts2.fixHistory = [];
          ts2.fixHistory.push({
            reviewFeedback: reviewFeedback.slice(0, 800),
            fixSummary: (ts2.agents || []).find(a => a.feedback && a.status === 'done')?.feedback?.slice(0, 400) || null,
          });
          ts2.fixCycles = (ts2.fixCycles || 0) + 1;
          console.log(`[workflow] Task ${taskIdx + 1} has blocking issues. Fix cycle ${ts2.fixCycles}/${MAX_FIX_CYCLES}.`);
          launchTaskFix(wf2, taskIdx, reviewFeedback);
          state.saveWorkflow(wf2);
        } else {
          // No blocking issues or max fix cycles reached → mark task done
          if ((ts2.fixCycles || 0) >= MAX_FIX_CYCLES) {
            console.log(`[workflow] Task ${taskIdx + 1} hit max fix cycles (${MAX_FIX_CYCLES}). Marking done.`);
            ts2.status = 'blocked';
          } else {
            ts2.status = 'done';
          }
          ts2.completedAt = new Date().toISOString();
          updateStepAgents(wf2);
          state.saveWorkflow(wf2);
          launchNextTask(wf2);
        }
      } else if (ts2.status === 'fixing') {
        // Fix done → capture tokens before re-launching review
        captureAgentTokens(ts2);
        const fixSummary = (ts2.agents || []).filter(a => a.feedback).map(a => a.feedback).join('\n');
        // Update fix history with the fix agent's summary
        if (ts2.fixHistory && ts2.fixHistory.length > 0) {
          ts2.fixHistory[ts2.fixHistory.length - 1].fixSummary = fixSummary.slice(0, 400);
        }
        console.log(`[workflow] Task ${taskIdx + 1} fix done. Re-launching review.`);
        launchTaskReview(wf2, taskIdx);
        state.saveWorkflow(wf2);
      }
    }, 1000);
  }

  // --- Auto-iterate ---
  // Cap at 2 rounds: by round 3 agents tend to fight each other (reviewer keeps
  // finding the same issue, fixer keeps applying the wrong fix). Human triage
  // after round 2 is faster than another autonomous cycle.
  const MAX_REVIEW_ROUNDS = config.max_review_rounds || 2;

  function autoAdvanceWorkflow(wf) {
    // Re-load to get latest state
    wf = state.loadWorkflow();
    if (!wf || wf.currentStep === 'completed') return;

    const step = wf.steps[wf.currentStep];
    const allDone = step && step.agents && step.agents.length > 0 && step.agents.every(a => a.status === 'done' || a.status === 'error');
    if (!allDone) return;

    // Hard cap: stop auto-iterating after MAX_REVIEW_ROUNDS
    if (wf.round >= MAX_REVIEW_ROUNDS) {
      console.log(`[workflow] Auto-iterate: reached max rounds (${MAX_REVIEW_ROUNDS}), stopping. Manual approval required.`);
      wf.autoIterateRemaining = 0;
      state.saveWorkflow(wf);
      return;
    }

    // Convergence detection for review workflows: if all reviewers approve
    // with zero blocking AND zero medium findings, mark as completed instead of looping.
    // Medium findings indicate actionable issues the PM should address before implementation.
    if (wf.type === 'review' && wf.currentStep === 'reviewing') {
      const agentsWithFeedback = (step.agents || []).filter(a => a.feedback);
      const allCleanApproval = agentsWithFeedback.length > 0 && agentsWithFeedback.every(a => {
        const fb = a.feedback;
        const approvedMatch = fb.match(/\*\*Approved:\*\*\s*(yes|no)/i);
        if (!approvedMatch || approvedMatch[1].toLowerCase() !== 'yes') return false;
        // Check for any actionable findings (blocking or medium)
        const blockingMatch = fb.match(/\*\*Blocking:\*\*\s*(\d+)/i);
        const mediumMatch = fb.match(/\*\*Medium:\*\*\s*(\d+)/i);
        const blockingCount = blockingMatch ? parseInt(blockingMatch[1]) : 0;
        const mediumCount = mediumMatch ? parseInt(mediumMatch[1]) : 0;
        return blockingCount === 0 && mediumCount === 0;
      });
      if (allCleanApproval) {
        console.log(`[workflow] Auto-iterate: all reviewers approved with no blocking/medium in round ${wf.round}, completing workflow.`);
        wf.steps.reviewing.status = 'completed';
        wf.currentStep = 'completed';
        wf.autoIterateRemaining = 0;
        advanceLinkedFeatures(wf.prdPath, 'Reviewed');
        writeWorklog(wf);
        commitWorkflowDocs(`docs(${wf.input.replace(/\s+/g, '-')}): mark Reviewed in backlog`);
        state.saveWorkflow(wf);
        return;
      }
    }

    // Determine the auto-advance action based on current step
    let action = null;
    if (wf.type === 'review') {
      if (wf.currentStep === 'reviewing') action = 'send_to_pm';
      else if (wf.currentStep === 'pm_fix') action = 'approve'; // sends back to reviewers
    } else if (wf.type === 'execution') {
      // Post-merge review steps (code_review, qa_validation, ac_verification, security_audit)
      // always require manual approval — auto-iterate only applies to fix loops
      if (wf.currentStep === 'fix_plan') {
        // Hash check: don't auto-approve if fix plan is identical to the previous round's plan
        const plannerFeedback = (step.agents || []).find(a => a.feedback)?.feedback || '';
        const crypto = require('crypto');
        const planHash = crypto.createHash('md5').update(plannerFeedback.trim()).digest('hex');
        if (wf._lastFixPlanHash && wf._lastFixPlanHash === planHash) {
          console.log(`[workflow] Auto-iterate: fix plan identical to previous round (hash=${planHash.slice(0, 8)}). Stopping — manual review required.`);
          wf.autoIterateRemaining = 0;
          state.saveWorkflow(wf);
          return;
        }
        wf._lastFixPlanHash = planHash;
        action = 'approve';
      }
      // fix_execution: auto-launch pending tasks and auto-approve completed ones
      if (wf.currentStep === 'fix_execution') {
        const fixStep = wf.steps.fix_execution;
        const allAgentsDone = (fixStep.agents || []).every(a => a.status === 'done' || a.status === 'error');
        if (fixStep.status === 'running' && allAgentsDone) {
          action = 'approve'; // approve completed task, advance to next
        } else if (fixStep.status === 'pending' || !fixStep.agents?.length) {
          action = 'next_task'; // launch next pending task
        }
      }
    } else if (wf.type === 'kickoff') {
      if (wf.currentStep === 'team_review') action = 'approve'; // sends to pm_revision
      else if (wf.currentStep === 'pm_revision') action = 'request_changes';
    }

    if (!action) {
      console.log(`[workflow] Auto-iterate: no auto-action for step=${wf.currentStep}`);
      return;
    }

    console.log(`[workflow] Auto-iterate: advancing step=${wf.currentStep} action=${action} round=${wf.round}/${MAX_REVIEW_ROUNDS}`);

    // Use internal HTTP call to the advance endpoint
    const http = require('http');
    const body = JSON.stringify({ action });
    const req = http.request({
      hostname: 'localhost',
      port: config.port,
      path: '/api/workflow/advance',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.needsAdvance) {
            // Some transitions need a second advance (e.g., pm_fix → reviewing needs launch)
            setTimeout(() => autoAdvanceWorkflow(state.loadWorkflow()), 2000);
          }
        } catch (_) {}
      });
    });
    req.on('error', e => console.error('[workflow] Auto-advance HTTP error:', e.message));
    req.write(body);
    req.end();
  }

  // --- Kickoff workflow ---
  function handleKickoffAdvance(wf, action, notes, res) {
    const { findRole } = require('../config');

    if (wf.currentStep === 'ceo_synthesis' && wf.steps.ceo_synthesis.status === 'pending') {
      const ceoRole = findRole(config, 'CEO');
      const skill = ceoRole ? ceoRole.skill : 'ceo';
      const agents = [{
        role: 'CEO', window: 'ceo', status: 'pending', reportFeedback: true,
        instruction: `You are the CEO/Strategist. Read all files in docs/inputs/ and produce docs/vision.md — the canonical vision document for this project. Use the /${skill} skill. Fill in all sections of the vision template. Commit your changes. ${COMMIT_ON_CURRENT_BRANCH}`,
      }];
      wf.steps.ceo_synthesis = { status: 'running', agents: launchWorkflowAgents(wf, agents, { useWorktrees: false }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'ceo_synthesis' && action === 'approve') {
      wf.steps.ceo_synthesis.status = 'completed';
      wf.currentStep = 'pm_scoping';
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    if (wf.currentStep === 'pm_scoping' && wf.steps.pm_scoping.status === 'pending') {
      const pmRole = findRole(config, 'PM');
      const skill = pmRole ? pmRole.skill : 'pm';
      const agents = [{
        role: 'PM', window: 'pm', status: 'pending', reportFeedback: true,
        instruction: `You are the Product Manager. Read docs/vision.md and docs/inputs/. Produce:\n1. docs/project-state.md — fill in all template sections (roles, workflow, conventions, backlog)\n2. The BACKLOG — use the PRD-004 per-item format, NOT a markdown table. For each planned iteration write a file docs/backlog/<PREFIX>-NNN.md with YAML frontmatter (id, title, type: Feature, status, release, created: null, prd, depends_on: [], cost_actual_usd: null) AND add a matching line "- <PREFIX>-NNN — Title  [Type · Status]" under a "### <Release>" heading between the <!-- BACKLOG-START -->/<!-- BACKLOG-END --> markers in project-state.md (every item file MUST have a matching marker line, or it renders as nothing). <PREFIX> = a 2–4 letter uppercase code derived from the project name (e.g. example-graph → EG, example-web → EW), numbered 001+. The first item (the one you draft PRD-001 for) is status Drafted with its prd field set to docs/prds/PRD-001-*.md; the rest are status Backlog. See the /${skill} skill's backlog rules for exact steps.\n3. docs/prds/PRD-001-*.md — the first iteration PRD. Start from docs/prds/TEMPLATE.md — copy it and fill it in.\n\nWhile scoping, check docs/inputs/ for the owner's preference on visual design workflow. THREE options:\n  (a) Pencil-controlled — designer authors .pen files; frontend_dev verifies via heatmap-diff\n  (b) Claude Design — designer iterates in claude.ai/design; exports a handoff bundle to design-system/; frontend_dev invokes the bundle's SKILL skill and recreates from HTML prototypes (no heatmap-diff)\n  (c) Agent-autonomous — no design source artifact; frontend_dev works from PRD + UX spec + brand-guidelines.md alone\n\nIf the input documents don't specify which, flag it in your feedback — the owner needs to decide. Record the decision in project-state.md under Project Conventions, e.g.:\n  "Visual design workflow: Pencil-controlled"\n  "Visual design workflow: Claude Design (bundle at design-system/)"\n  "Visual design workflow: agent-autonomous"\n\nThe execution flow uses this convention to decide whether to include or skip the visual_design step and which verification protocol applies.\n\nUse the /${skill} skill. Commit your changes. ${COMMIT_ON_CURRENT_BRANCH}`,
      }];
      wf.steps.pm_scoping = { status: 'running', agents: launchWorkflowAgents(wf, agents, { useWorktrees: false }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'pm_scoping' && action === 'approve') {
      wf.steps.pm_scoping.status = 'completed';
      wf.currentStep = 'owner_consultations';
      if (!wf.steps.owner_consultations) wf.steps.owner_consultations = { status: 'pending', agents: [] };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    // owner_consultations — manual gate between pm_scoping and team_review.
    // Owner reviews PM output, optionally provides notes/answers, then approves.
    // Notes (if any) are persisted to docs/inputs/owner-consultation-round-N.md so
    // team_review and pm_revision agents can read them as additional context.
    if (wf.currentStep === 'owner_consultations' && action === 'approve') {
      if (notes && notes.trim()) {
        try {
          const inputsDir = path.join(docsPath, 'inputs');
          fs.mkdirSync(inputsDir, { recursive: true });
          const round = wf.round || 1;
          const filename = `owner-consultation-round-${round}.md`;
          const filepath = path.join(inputsDir, filename);
          const stamp = new Date().toISOString();
          fs.writeFileSync(filepath, `# Owner Consultation — Round ${round}\n\nRecorded: ${stamp}\n\n${notes.trim()}\n`);
          wf.steps.owner_consultations.notes = notes.trim();
          wf.steps.owner_consultations.notesPath = path.relative(projectRoot, filepath);
        } catch (e) {
          console.error('[workflow] failed to persist owner consultation notes:', e);
        }
      }
      wf.steps.owner_consultations.status = 'completed';
      wf.currentStep = 'team_review';
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    if (wf.currentStep === 'team_review' && (wf.steps.team_review.status === 'pending' || action === 'rerun_team_review')) {
      const reviewRoles = (config.roles.review || []);
      const mode = wf.reviewMode || config.review_mode || 'parallel';
      const ownerNotesPath = wf.steps.owner_consultations && wf.steps.owner_consultations.notesPath;
      const ownerNotesHint = ownerNotesPath
        ? `\n\nThe owner provided additional input during the owner_consultations step — read \`${ownerNotesPath}\` before reviewing and let it inform your feedback.`
        : '';
      let launchedAgents;
      try {
        if (mode === 'parallel') {
          const agents = reviewRoles.map(r => ({
            role: r.role, window: r.role.toLowerCase().slice(0, 15), status: 'pending',
            feedback: null, reportFeedback: true,
            instruction: `You are a ${r.role} reviewer. Review docs/vision.md and the PRD in docs/prds/. Provide structured feedback from a ${r.role} perspective. Use your /${r.skill} skill.${ownerNotesHint}\n\n## REVIEW SCOPE RULES\n\n1. **Only review what the document covers.** Do not raise issues about systems or features outside the document's scope.\n2. **Companion specs are OUT OF SCOPE for this review.** Companion-spec files (UX-XXX, ADRs, copy specs, anything in docs/ux/, docs/brand/, docs/adrs/, etc.) are written and refined in the dedicated \`companion_specs\` step that runs AFTER this review approves. Do NOT raise BLOCKING findings about missing or incomplete content inside companion-spec files. Surface those gaps as NON-BLOCKING action items for the \`companion_specs\` step.\n3. **Do not introduce new features or expand scope.** Verify the proposed scope is correct, not expand it.\n4. **After round 2, only raise genuinely new issues.** Confirm prior fixes are resolved — do not re-raise or follow up tangentially.\n5. **Classify findings** as BLOCKING or NON-BLOCKING. Be conservative with BLOCKING.\n6. **If you have no issues, say "APPROVE — no issues found."**\n\nThis is round ${wf.round}.`,
          }));
          launchedAgents = launchWorkflowAgents(wf, agents, { useWorktrees: false });
        } else {
          const feedbackDir = path.join(config.tmpPath, 'reviews');
          launchedAgents = launchOrchestratorReview(wf, reviewRoles, null, feedbackDir);
        }
        wf.steps.team_review = { status: 'running', agents: launchedAgents };
      } catch (e) {
        wf.steps.team_review = { status: 'error', error: e.message };
        state.saveWorkflow(wf);
        return res.status(500).json({ workflow: wf, error: e.message });
      }
      wf.currentStep = 'team_review';
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'team_review' && action === 'approve') {
      wf.steps.team_review.status = 'completed';
      wf.currentStep = 'pm_revision';
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    if (wf.currentStep === 'pm_revision' && wf.steps.pm_revision.status === 'pending') {
      const roundFeedback = (wf.steps.team_review.agents || [])
        .filter(a => a.feedback)
        .map(a => `### ${a.role}\n${a.feedback}`)
        .join('\n\n');
      const pmRole = findRole(config, 'PM');
      const skill = pmRole ? pmRole.skill : 'pm';
      const ownerNotesPath = wf.steps.owner_consultations && wf.steps.owner_consultations.notesPath;
      const ownerNotesHint = ownerNotesPath
        ? `\n\n## Owner Consultation Notes\nThe owner provided additional input during the owner_consultations step. Read \`${ownerNotesPath}\` and incorporate it into the revision.`
        : '';
      const agents = [{
        role: 'PM', window: 'pm-rev', status: 'pending', reportFeedback: true,
        instruction: `You are the Product Manager. Revise the vision and PRD based on reviewer feedback.\n\nUse the /${skill} skill.${ownerNotesHint}\n\n## Reviewer Feedback (Round ${wf.round})\n\n${roundFeedback}${notes ? `\n\n## Additional Notes from User\n\n${notes}` : ''}\n\nUpdate docs/vision.md, docs/project-state.md, and the PRD as needed. Commit your changes. ${COMMIT_ON_CURRENT_BRANCH}`,
      }];
      wf.steps.pm_revision = { status: 'running', agents: launchWorkflowAgents(wf, agents, { useWorktrees: false }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    // User gate — advance to companion specs
    if (wf.currentStep === 'pm_revision' && action === 'approve') {
      wf.steps.pm_revision.status = 'completed';
      wf.currentStep = 'companion_specs';
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    // --- Companion specs step ---
    if (wf.currentStep === 'companion_specs' && wf.steps.companion_specs.status === 'pending') {
      const { findRole } = require('../config');
      const specRoles = [
        { roleName: 'Brand', output: 'docs/brand/', desc: 'brand guidelines, identity, tone, and visual language' },
        { roleName: 'UX', output: 'docs/ux/', desc: 'UX principles, user flows, and interaction patterns' },
        { roleName: 'Marketing', output: 'docs/marketing/', desc: 'go-to-market direction and growth approach' },
        { roleName: 'Architect', output: 'docs/adrs/', desc: 'ADR-001: tech stack and system architecture decisions' },
        { roleName: 'DevOps', output: 'docs/adrs/', desc: 'ADR-002: CI/CD pipeline and deployment strategy' },
      ];
      const agents = [];
      for (const spec of specRoles) {
        const role = findRole(config, spec.roleName);
        if (!role) continue;
        agents.push({
          role: spec.roleName, window: spec.roleName.toLowerCase().slice(0, 12), status: 'pending', reportFeedback: true,
          instruction: `You are the ${spec.roleName}. Read docs/vision.md, docs/project-state.md, and the PRD in docs/prds/.${spec.roleName === 'Architect' ? `\n\nBefore deciding on deployment model, hosting, database, or other infrastructure: check docs/inputs/ for any information about what the owner already uses. Prefer reusing existing infrastructure over introducing new platforms. If the input documents do not mention the owner's current infrastructure, flag this in your feedback — the owner needs to provide this context before you can make well-informed decisions.` : ''}${spec.roleName === 'DevOps' ? `\n\nBefore deciding on CI/CD tooling: check docs/inputs/ for the owner's existing CI/CD setup. GitHub Actions is the default recommendation, but verify this matches the owner's preferences. Also determine whether CI/CD should be set up from the start or deferred while the project runs locally during early iterations. If the input documents don't clarify these points, flag them in your feedback — the owner needs to decide, and the PM needs this to plan which phase includes CI/CD setup.` : ''}\n\nProduce ${spec.desc} in ${spec.output}.\n\nUse the /${role.skill} skill. Create concrete, actionable specs that the team can use immediately when starting the first PRD iteration. Commit your changes. ${COMMIT_ON_CURRENT_BRANCH}`,
        });
      }
      if (agents.length === 0) {
        wf.steps.companion_specs.status = 'skipped';
        wf.currentStep = 'devops_init';
        state.saveWorkflow(wf);
        return res.json({ workflow: wf, needsAdvance: true });
      }
      wf.steps.companion_specs = { status: 'running', agents: launchWorkflowAgents(wf, agents, { useWorktrees: false }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'companion_specs' && action === 'approve') {
      wf.steps.companion_specs.status = 'completed';
      wf.currentStep = 'devops_init';
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    // --- DevOps Init step ---
    if (wf.currentStep === 'devops_init' && wf.steps.devops_init.status === 'pending') {
      const { findRole } = require('../config');
      const devopsRole = findRole(config, 'DevOps');
      if (!devopsRole) {
        // No DevOps role configured — skip
        wf.steps.devops_init.status = 'skipped';
        wf.currentStep = 'completed';
        writeWorklog(wf);
        state.saveWorkflow(wf);
        return res.json({ workflow: wf, completed: true });
      }
      // Build features configuration context for DevOps
      const presetFeatures = config.features || {};
      const featuresContext = `\n\n## PROJECT FEATURES CONFIGURATION\n\nThe project preset (${config.preset || 'web-app'}) provides default feature flags. Review these and override in \`.build-studio/config.yaml\` if the project's actual tech stack differs from the preset defaults.\n\nCurrent feature defaults from preset:\n- \`playwright_cli: ${presetFeatures.playwright_cli !== false}\` — browser screenshot verification against Pencil designs\n\n**Decision rule for playwright_cli:**\n- Set to \`true\` if the project has a web frontend that runs in a browser (SvelteKit, Next.js, React, Vue, etc.)\n- Set to \`false\` if the project is mobile-only (iOS/Android native), API-only, or has no browser-renderable UI\n\nIf the preset default is wrong for this project, add a \`features:\` section to \`.build-studio/config.yaml\`:\n\`\`\`yaml\nfeatures:\n  playwright_cli: false  # no web frontend to screenshot\n\`\`\`\n\nIf \`playwright_cli\` is \`true\`, ensure \`@playwright/cli\` is installed globally (\`npm install -g @playwright/cli\`).`;

      const agents = [{
        role: 'DevOps', window: 'devops-init', status: 'pending', reportFeedback: true,
        instruction: `You are DevOps. Read docs/project-state.md, docs/vision.md, the PRD in docs/prds/, and all ADRs in docs/adrs/.\n\nYour job is to initialize the project scaffold so that Frontend and Backend developers can start from a clean, working base — no duplicate scaffolding, no merge conflicts.\n\nBased on the ADRs and PRD, do what is needed:\n- Initialize the framework (e.g. create-next-app) if not already done\n- Set up deployment target (e.g. vercel link) if applicable\n- Provision storage/database if specified in ADRs\n- Install shared dependencies from ADRs (framework, DB client, CSS, fonts)\n- Create initial config files (tsconfig, eslint, tailwind, postcss, etc.)\n- Run DB migrations/schema if applicable\n- Set up environment variables template (.env.example)\n- If docs/project-state.md indicates "Visual design: Pencil-controlled", create an initial .pen file for the project using the Pencil MCP tools (open_document with 'new') so it is ready for the visual_design step in execution iterations\n- Commit a clean, building scaffold that passes lint\n\nIf the project is already scaffolded and no infra work is needed, report that and commit nothing.${featuresContext}\n\nUse the /${devopsRole.skill} skill. Commit your changes. ${COMMIT_ON_CURRENT_BRANCH}`,
      }];
      wf.steps.devops_init = { status: 'running', agents: launchWorkflowAgents(wf, agents, { useWorktrees: false }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'devops_init' && action === 'approve') {
      wf.steps.devops_init.status = 'completed';
      wf.currentStep = 'completed';
      writeWorklog(wf);
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, completed: true });
    }

    if (wf.currentStep === 'devops_init' && action === 'skip') {
      wf.steps.devops_init.status = 'skipped';
      wf.currentStep = 'completed';
      writeWorklog(wf);
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, completed: true });
    }

    if (wf.currentStep === 'pm_revision' && action === 'request_changes') {
      wf.steps.pm_revision.status = 'completed';
      wf.round++;

      // Hard cap
      if (wf.round > MAX_REVIEW_ROUNDS) {
        console.log(`[workflow] Kickoff review hard cap reached (${MAX_REVIEW_ROUNDS} rounds). Moving to devops init.`);
        wf.currentStep = 'devops_init';
        state.saveWorkflow(wf);
        return res.json({ workflow: wf, needsAdvance: true, warning: `Review capped at ${MAX_REVIEW_ROUNDS} rounds.` });
      }

      wf.currentStep = 'team_review';
      wf.steps.team_review = { status: 'pending', agents: [] };
      wf.steps.pm_revision = { status: 'pending', agents: [] };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    return res.status(400).json({ error: `no valid transition for step=${wf.currentStep} action=${action}` });
  }

  // --- Onboarding workflow (PRD-001) ---
  // Mirrors kickoff but reads existing project files instead of docs/inputs/.
  // Discovery is the only step allowed to commit before owner_signoff
  // (writes docs/onboarding/survey.md so downstream agents can read it).
  function handleOnboardingAdvance(wf, action, notes, res) {
    const { findRole } = require('../config');
    const role = (name, fallbackSkill) => {
      const r = findRole(config, name);
      return r ? r.skill : fallbackSkill;
    };

    // ─── 1. discovery ────────────────────────────────────────────────────────
    if (wf.currentStep === 'discovery' && wf.steps.discovery.status === 'pending') {
      const skill = role('Architect', 'architect');
      const agents = [{
        role: 'Surveyor', window: 'survey', status: 'pending', reportFeedback: true,
        instruction:
          `You are the Surveyor for project onboarding (PRD-001).\n\n` +
          `Read docs/onboarding/inventory.json (the bootstrap-time inventory written by the Onboard button). ` +
          `For each entry in existingDocs[], OPEN the file and write a one-paragraph summary of its content.\n\n` +
          `Identify the project shape: 'single-prd-mvp', 'spec-folder', 'monorepo', or 'unstructured'.\n\n` +
          `**v1 only supports single-prd-mvp.** If the shape is anything else, halt with a BLOCKING ` +
          `structured-feedback finding so the operator can revert. Do not try to scaffold a vision/ADR/PRD ` +
          `for an unsupported shape.\n\n` +
          `Produce docs/onboarding/survey.md containing:\n` +
          `  - Detected shape (with reasoning)\n` +
          `  - Doc summaries (one per existingDocs[] entry)\n` +
          `  - Candidate-vision sources (which files contain vision-like content)\n` +
          `  - Candidate-PRD sources\n` +
          `  - Candidate-ADR sources\n` +
          `  - Owner-input gaps (anything missing that the workflow can't synthesize)\n\n` +
          `Use the /${skill} skill. Commit with: chore: onboarding survey. ${COMMIT_ON_CURRENT_BRANCH}\n\n` +
          `**This is the ONLY onboarding step allowed to commit before owner sign-off.** ` +
          `Subsequent steps stage their files only — owner_signoff makes the single onboarding commit.`,
      }];
      wf.steps.discovery = { status: 'running', agents: launchWorkflowAgents(wf, agents, { useWorktrees: false }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }
    if (wf.currentStep === 'discovery' && action === 'approve') {
      wf.steps.discovery.status = 'completed';
      wf.currentStep = 'ceo_synthesis';
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    // ─── 2. ceo_synthesis (different prompt vs kickoff) ─────────────────────
    if (wf.currentStep === 'ceo_synthesis' && wf.steps.ceo_synthesis.status === 'pending') {
      const skill = role('CEO', 'ceo');
      const agents = [{
        role: 'CEO', window: 'ceo', status: 'pending', reportFeedback: true,
        instruction:
          `You are the CEO/Strategist. This is an ONBOARDING flow, not a fresh kickoff.\n\n` +
          `Read docs/onboarding/survey.md (just written by the Surveyor) and the candidate-vision ` +
          `sources it lists. Do NOT read docs/inputs/ — for an onboarded project there are no inputs; ` +
          `the project itself is the input.\n\n` +
          `Distill the existing vision from those files into docs/vision.md. ` +
          `If a clear vision already exists, restate it in the dashboard's vision template; ` +
          `do NOT invent new direction.\n\n` +
          `If a vision-template section has no source material, leave it as ` +
          `"[Owner input needed: <what's missing>]" rather than guessing.\n\n` +
          `Use the /${skill} skill. STAGE the file (git add) but DO NOT COMMIT — ` +
          `owner_signoff makes the single onboarding commit.`,
      }];
      wf.steps.ceo_synthesis = { status: 'running', agents: launchWorkflowAgents(wf, agents, { useWorktrees: false }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }
    if (wf.currentStep === 'ceo_synthesis' && action === 'approve') {
      wf.steps.ceo_synthesis.status = 'completed';
      wf.currentStep = 'architect_backfill';
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    // ─── 3. architect_backfill ──────────────────────────────────────────────
    if (wf.currentStep === 'architect_backfill' && wf.steps.architect_backfill.status === 'pending') {
      const skill = role('Architect', 'architect');
      const agents = [{
        role: 'Architect', window: 'arch-bf', status: 'pending', reportFeedback: true,
        instruction:
          `You are the Architect. This is an ONBOARDING backfill — describe what the stack ` +
          `ALREADY is, do not propose a new one.\n\n` +
          `Read docs/onboarding/inventory.json (the "stack" field) and the relevant config files ` +
          `(package.json, tsconfig.json, vite.config.ts, wrangler.jsonc, next.config.ts, etc.).\n\n` +
          `Produce docs/adrs/ADR-001-tech-stack.md with:\n` +
          `  - Status: Accepted (backfill)\n` +
          `  - Context: this project was onboarded; ADR-001 records existing decisions, not new ones\n` +
          `  - Decision: name the framework, language, runtime, deployment target, key patterns\n` +
          `  - Consequences: implications going forward\n\n` +
          `If multiple ADR-worthy patterns are visible (state mgmt, persistence, auth, etc.), write ` +
          `only ADR-001 in v1 and list the others in docs/onboarding/survey.md as candidates.\n\n` +
          `ALSO author ARCHITECTURE.md at the repo root — the maintained repo map every agent ` +
          `reads before exploring. Keep it under ~2 pages, factual, with real paths. Sections: ` +
          `a maintenance header ("whoever changes the component map updates this file in the same ` +
          `commit; status lives in docs/project-state.md, decision rationale in docs/adrs/ — never ` +
          `duplicate either"), System overview, Components (dir | responsibility | stack/entry ` +
          `point), Data flow & contracts, Test seams & env toggles, Test infrastructure (exact run ` +
          `commands + external deps), Guardrails (must-not-break, each with its source), Where ` +
          `things are documented. Describe what EXISTS — no aspirations.\n\n` +
          `Use the /${skill} skill. STAGE files but DO NOT COMMIT.`,
      }];
      wf.steps.architect_backfill = { status: 'running', agents: launchWorkflowAgents(wf, agents, { useWorktrees: false }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }
    if (wf.currentStep === 'architect_backfill' && action === 'approve') {
      wf.steps.architect_backfill.status = 'completed';
      wf.currentStep = 'pm_synthesis';
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    // ─── 4. pm_synthesis (different from kickoff's pm_scoping) ─────────────
    if (wf.currentStep === 'pm_synthesis' && wf.steps.pm_synthesis.status === 'pending') {
      const skill = role('PM', 'pm');
      const agents = [{
        role: 'PM', window: 'pm-syn', status: 'pending', reportFeedback: true,
        instruction:
          `You are the Product Manager. This is an ONBOARDING flow.\n\n` +
          `Read docs/vision.md, docs/adrs/ADR-001-tech-stack.md, docs/onboarding/survey.md, ` +
          `and the candidate-PRD sources from the survey.\n\n` +
          `Produce three artifacts:\n\n` +
          `1. docs/project-state.md — fill in all template sections.\n` +
          `   - Completed PRDs table populated from git log + README "Released"/"Live" sections\n` +
          `   - Backlog — use the PRD-004 per-item format, NOT a markdown table: one file ` +
          `docs/backlog/<PREFIX>-NNN.md per item (frontmatter: id, title, type, status, release, ` +
          `created: null, prd, depends_on: [], cost_actual_usd: null) AND a matching line ` +
          `"- <PREFIX>-NNN — Title  [Type · Status]" under a "### <Release>" heading between the ` +
          `<!-- BACKLOG-START -->/<!-- BACKLOG-END --> markers in project-state.md (every item file MUST ` +
          `have a matching marker line). <PREFIX> = a 2–4 letter uppercase code from the project name ` +
          `(e.g. example-web → EW), numbered 001+. Populate items from any "Next steps" / "Roadmap" / ` +
          `IMPLEMENTATION_PLAN-equivalent files; default status Backlog. See the /${skill} skill's backlog rules.\n\n` +
          `2. docs/prds/PRD-001-onboarding-baseline.md — a CLOSED PRD that records ` +
          `   the project's pre-onboarding state. Status = Closed, Implementation = "shipped pre-onboarding". ` +
          `   This anchors the PRD numbering and gives docs/prds/ its first row.\n\n` +
          `3. docs/prds/PRD-002-<owner-stated-next-bet>.md — the next iteration PRD. ` +
          `   If the owner hasn't stated a next bet, leave a placeholder titled ` +
          `   "PRD-002 — pending: owner to choose first iteration" rather than inventing one.\n\n` +
          `Use the /${skill} skill. STAGE files but DO NOT COMMIT.`,
      }];
      wf.steps.pm_synthesis = { status: 'running', agents: launchWorkflowAgents(wf, agents, { useWorktrees: false }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }
    if (wf.currentStep === 'pm_synthesis' && action === 'approve') {
      wf.steps.pm_synthesis.status = 'completed';
      wf.currentStep = 'devops_detect';
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    // ─── 5. devops_detect ──────────────────────────────────────────────────
    if (wf.currentStep === 'devops_detect' && wf.steps.devops_detect.status === 'pending') {
      const skill = role('DevOps', 'devops');
      const agents = [{
        role: 'DevOps', window: 'devops', status: 'pending', reportFeedback: true,
        instruction:
          `You are DevOps. Read .build-studio/config.yaml (button-detected) and the project's ` +
          `.github/workflows/ + any vercel.json / wrangler.jsonc / railway.json.\n\n` +
          `Confirm the deployment block is correct or propose corrections. If deploys happen on ` +
          `push (no manual workflow_dispatch), confirm ci_workflow is unset (Deploy button hidden).\n\n` +
          `Produce docs/runbooks/deployment.md summarizing the deploy mechanism.\n\n` +
          `If you find that .build-studio/config.yaml needs corrections, surface them as structured ` +
          `feedback action items for team_review — do NOT modify config.yaml directly.\n\n` +
          `Use the /${skill} skill. STAGE the runbook but DO NOT COMMIT.`,
      }];
      wf.steps.devops_detect = { status: 'running', agents: launchWorkflowAgents(wf, agents, { useWorktrees: false }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }
    if (wf.currentStep === 'devops_detect' && action === 'approve') {
      wf.steps.devops_detect.status = 'completed';
      wf.currentStep = 'team_review';
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    // ─── 6. team_review (reuses kickoff machinery, override prompt framing) ─
    if (wf.currentStep === 'team_review' && (wf.steps.team_review.status === 'pending' || action === 'rerun_team_review')) {
      const reviewRoles = (config.roles.review || []);
      const mode = wf.reviewMode || config.review_mode || 'parallel';
      let launchedAgents;
      try {
        if (mode === 'parallel') {
          const agents = reviewRoles.map(r => ({
            role: r.role, window: r.role.toLowerCase().slice(0, 15), status: 'pending',
            feedback: null, reportFeedback: true,
            instruction:
              `You are a ${r.role} reviewer for an ONBOARDING workflow. ` +
              `You are reviewing BACKFILLED artifacts (vision, ADR-001, project-state) — not fresh decisions.\n\n` +
              `## REVIEW SCOPE FOR ONBOARDING\n\n` +
              `1. **Flag findings only when the artifact contradicts the actual project state.** ` +
              `Open files, check the codebase, verify claims.\n` +
              `2. **Do NOT raise findings about scope expansion or missing strategic depth** — those are ` +
              `owner decisions, not review findings, and inventing them now would steer an existing ` +
              `project away from its actual direction.\n` +
              `3. **Classify findings** as BLOCKING (artifact is wrong) or NON-BLOCKING (artifact could be richer).\n` +
              `4. **If you have no issues, say "APPROVE — no issues found."**\n\n` +
              `Use your /${r.skill} skill. This is round ${wf.round}.`,
          }));
          launchedAgents = launchWorkflowAgents(wf, agents, { useWorktrees: false });
        } else {
          const feedbackDir = path.join(config.tmpPath, 'reviews');
          launchedAgents = launchOrchestratorReview(wf, reviewRoles, null, feedbackDir);
        }
        wf.steps.team_review = { status: 'running', agents: launchedAgents };
      } catch (e) {
        wf.steps.team_review = { status: 'error', error: e.message };
        state.saveWorkflow(wf);
        return res.status(500).json({ workflow: wf, error: e.message });
      }
      wf.currentStep = 'team_review';
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }
    // team_review approve: advance to pm_revision IF reviewers raised BLOCKING
    // findings; otherwise jump straight to owner_signoff (no revision needed).
    // Mirrors kickoff's flow: review approve → next step, not always back to PM.
    if (wf.currentStep === 'team_review' && action === 'approve') {
      const hasBlocking = (wf.steps.team_review.agents || []).some((a) => {
        if (!a.feedback) return false;
        const fb = a.feedback;
        // Detect either explicit "Blocking: N" with N>0, or per-finding [BLOCKING] tags.
        const m = fb.match(/\*\*Blocking:\*\*\s*(\d+)/i);
        if (m && parseInt(m[1], 10) > 0) return true;
        if (m && parseInt(m[1], 10) === 0) return false;
        return /\[BLOCKING\]/i.test(fb);
      });
      wf.steps.team_review.status = 'completed';
      if (hasBlocking) {
        wf.currentStep = 'pm_revision';
      } else {
        // Skip pm_revision — nothing to revise.
        wf.steps.pm_revision.status = 'completed';
        wf.currentStep = 'owner_signoff';
      }
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }
    // Force-skip variant for the rare case where the operator wants to bypass
    // pm_revision even with a blocking finding (e.g. they fixed it inline).
    if (wf.currentStep === 'team_review' && action === 'skip_to_signoff') {
      wf.steps.team_review.status = 'completed';
      wf.steps.pm_revision.status = 'completed';
      wf.currentStep = 'owner_signoff';
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    // ─── 7. pm_revision (reuses kickoff pattern, NO commit) ────────────────
    if (wf.currentStep === 'pm_revision' && wf.steps.pm_revision.status === 'pending') {
      const roundFeedback = (wf.steps.team_review.agents || [])
        .filter(a => a.feedback)
        .map(a => `### ${a.role}\n${a.feedback}`)
        .join('\n\n');
      const skill = role('PM', 'pm');
      const agents = [{
        role: 'PM', window: 'pm-rev', status: 'pending', reportFeedback: true,
        instruction:
          `You are the Product Manager. Revise the onboarding artifacts (vision, ADR-001, ` +
          `project-state, PRD-001/002) based on reviewer feedback.\n\n` +
          `Use the /${skill} skill.\n\n## Reviewer Feedback (Round ${wf.round})\n\n${roundFeedback}` +
          (notes ? `\n\n## Additional Notes from User\n\n${notes}` : '') +
          `\n\nUpdate the relevant files. STAGE them but DO NOT COMMIT — owner_signoff makes ` +
          `the single onboarding commit.`,
      }];
      wf.steps.pm_revision = { status: 'running', agents: launchWorkflowAgents(wf, agents, { useWorktrees: false }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }
    // pm_revision approve: matches kickoff — advance to the NEXT step
    // (owner_signoff for onboarding), do not loop back to team_review.
    // Re-validation is achieved via owner_signoff's send_back action, which
    // re-enters pm_revision with the owner's note as additional feedback.
    if (wf.currentStep === 'pm_revision' && action === 'approve') {
      wf.steps.pm_revision.status = 'completed';
      wf.currentStep = 'owner_signoff';
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }
    // Explicit re-validation path: if the operator wants to re-run team_review
    // after PM revision (rather than going to signoff), they can opt in.
    if (wf.currentStep === 'pm_revision' && action === 'rerun_team_review') {
      wf.steps.pm_revision.status = 'completed';
      wf.round = (wf.round || 1) + 1;
      wf.currentStep = 'team_review';
      wf.steps.team_review = { status: 'pending', agents: [] };
      wf.steps.pm_revision = { status: 'pending', agents: [] };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    // ─── 8. owner_signoff — manual gate, no agent ──────────────────────────
    if (wf.currentStep === 'owner_signoff' && action === 'approve') {
      // Owner approved → make the single onboarding commit covering all staged work.
      const { execFileSync } = require('child_process');
      try {
        execFileSync('git', ['add', '-A'], { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        execFileSync('git', ['commit', '-m', 'chore: onboard to build-studio via PRD-001'], {
          cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        const msg = (e.stderr && e.stderr.toString()) || e.message;
        wf.steps.owner_signoff = { status: 'error', error: `Commit failed: ${msg}` };
        state.saveWorkflow(wf);
        return res.status(500).json({ workflow: wf, error: msg });
      }
      wf.steps.owner_signoff.status = 'completed';
      wf.currentStep = 'completed';
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }
    if (wf.currentStep === 'owner_signoff' && action === 'send_back') {
      // Owner rejected — return to pm_revision with their notes as feedback for the next round.
      wf.round = (wf.round || 1) + 1;
      wf.currentStep = 'pm_revision';
      wf.steps.pm_revision = { status: 'pending', agents: [] };
      // Stash the owner's notes inside the team_review feedback list so pm_revision picks them up.
      if (notes && wf.steps.team_review && wf.steps.team_review.agents) {
        wf.steps.team_review.agents.push({ role: 'Owner', feedback: notes, status: 'done' });
      }
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    return res.status(400).json({ error: `no valid transition for onboarding step=${wf.currentStep} action=${action}` });
  }

  // --- Review workflow ---
  function handleReviewAdvance(wf, action, notes, res) {
    const reviewStep = wf.steps.reviewing;
    const reviewStuck = reviewStep && reviewStep.status === 'running' &&
      reviewStep.agents && reviewStep.agents.length > 0 &&
      reviewStep.agents.every(a => a.status === 'pending');

    // Idempotency guard: a `launch` fired against a `reviewing` step that is
    // already running is a benign duplicate. The server's auto-advance fires
    // a launch ~1.5s after a `needsAdvance: true` response (e.g. pm_fix →
    // reviewing transition); the client-side auto-advance polls the workflow
    // and may also fire a launch in the same window. Whichever request wins
    // launches the agents; the loser used to hit the fall-through and
    // surface as "no valid transition for step=reviewing action=launch".
    // Returning the current state instead avoids the false warning.
    if (wf.currentStep === 'reviewing' && action === 'launch' && reviewStep.status === 'running') {
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'pm_draft' || (wf.currentStep === 'reviewing' && (reviewStep.status === 'pending' || reviewStuck))) {
      wf.currentStep = 'reviewing';
      const reviewRoles = (config.roles.review || []);
      const mode = wf.reviewMode || config.review_mode || 'parallel';
      let launchedAgents;
      try {
        if (mode === 'parallel') {
          const agents = reviewRoles.map(r => ({
            role: r.role, window: r.role.toLowerCase().slice(0, 15), status: 'pending',
            feedback: null, reportFeedback: true,
            instruction: `You are a ${r.role} reviewer. Review this PRD and provide structured feedback from a ${r.role} perspective. Use your /${r.skill} skill.\n\nPRD path: ${wf.prdPath}\n\nRead the PRD file, then analyze it.\n\n## REVIEW FORMAT — MANDATORY\n\nUse this exact format (it is machine-parsed by the dashboard):\n\n## Review: ${r.role}\n\n**Approved:** yes | no\n**Blocking:** N  |  **Medium:** N  |  **Low:** N\n\n### Summary\n[1-3 sentences — overall assessment]\n\n### Findings\n[Details grouped by topic. Mark each: BLOCKING, MEDIUM, or LOW.]\n\n### Action Items\n- [ ] [assignee_role] — description\n\n## REVIEW SCOPE RULES\n\n1. **Only review what the PRD covers.** If the PRD is about landing page polish, do not raise issues about backend storage architecture, payment flows, or other systems outside scope.\n2. **Check the "Out of scope" section** — anything listed there is explicitly excluded. Do not raise issues about excluded items.\n3. **Companion specs are OUT OF SCOPE for this review.** Companion-spec files (UX-XXX, ADRs, copy specs, and anything in docs/ux/, docs/brand/, docs/adrs/, etc.) are written and refined in the dedicated \`companion_specs\` step that runs AFTER this PRD review approves. Do NOT raise BLOCKING findings about missing or incomplete content inside companion-spec files — those gaps will be closed by the spec owner in the next step. If the PRD itself fails to anchor a decision that the companion spec needs, raise it as a NON-BLOCKING action item for the \`companion_specs\` step instead of blocking PRD approval.\n4. **Do not introduce new features.** Your job is to verify the proposed scope is correct and complete, not to expand it.\n5. **After round 2, only raise genuinely new issues.** If your concern was addressed in a previous round, confirm it is resolved — do not re-raise it or raise tangential follow-ups.\n6. **Classify each finding** as BLOCKING (must fix before implementation) or NON-BLOCKING (observation, can fix later). Be conservative with BLOCKING — most issues are non-blocking.\n7. **If you have no issues, set Approved: yes and all counts to 0.** Do not invent concerns to justify your review.\n\nThis is round ${wf.round}.`,
          }));
          launchedAgents = launchWorkflowAgents(wf, agents, { useWorktrees: false });
        } else {
          const feedbackDir = path.join(config.tmpPath, 'reviews');
          launchedAgents = launchOrchestratorReview(wf, reviewRoles, wf.prdPath, feedbackDir);
        }
        wf.steps.reviewing = { status: 'running', agents: launchedAgents };
      } catch (e) {
        wf.steps.reviewing = { status: 'error', error: e.message };
        state.saveWorkflow(wf);
        return res.status(500).json({ workflow: wf, error: e.message });
      }
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'reviewing' && (action === 'approve' || action === 'send_to_pm')) {
      // Guard: never approve/route a reviewing round that hasn't actually run.
      // The strict re-review round (pm_fix → reviewing) relaunches reviewers with
      // an empty agents array; an `approve` arriving before they finish (a racing
      // tick, or a manual click while they're still running) used to fall through
      // to companion_specs and silently DISCARD the re-review — because needsPmFix
      // finds nothing to bounce on running/empty agents. Require ≥1 agent and all
      // completed before this step can advance.
      const rvAgents = wf.steps.reviewing.agents || [];
      const rvNotReady = rvAgents.length === 0 || rvAgents.some(a => a.status !== 'done' && a.status !== 'error');
      if (rvNotReady) {
        return res.status(409).json({
          workflow: wf,
          error: rvAgents.length === 0
            ? 'Reviewing round has not been launched yet — launch reviewers before approving.'
            : `Reviewing round still running (${rvAgents.filter(a => a.status !== 'done' && a.status !== 'error').length}/${rvAgents.length} reviewers not finished) — wait for them before approving, so the re-review isn't skipped.`,
        });
      }
      // Safety: only redirect approve → send_to_pm if a reviewer explicitly said
      // "Approved: no" or raised a Blocking finding. Medium findings are
      // non-blocking by convention — reviewers route those to downstream steps
      // (companion_specs, implementation) via Action Items, so trust the explicit
      // "Approved: yes" signal and don't bounce back to PM for revisions PM can't act on.
      const needsPmFix = (wf.steps.reviewing.agents || []).some(a => {
        if (!a.feedback) return false;
        const approvedMatch = a.feedback.match(/\*\*Approved:\*\*\s*(yes|no)/i);
        const blockingMatch = a.feedback.match(/\*\*Blocking:\*\*\s*(\d+)/i);
        const notApproved = approvedMatch && approvedMatch[1].toLowerCase() === 'no';
        const hasBlocking = blockingMatch && parseInt(blockingMatch[1]) > 0;
        return notApproved || hasBlocking;
      });
      const effectiveAction = needsPmFix ? 'send_to_pm' : action;

      if (effectiveAction === 'approve') {
        wf.steps.reviewing.status = 'completed';
        // Check if the PRD has pending companion specs (§10) — if so, launch them before completing
        wf.currentStep = 'companion_specs';
        if (!wf.steps.companion_specs) wf.steps.companion_specs = { status: 'pending', agents: [] };
        state.saveWorkflow(wf);
        return res.json({ workflow: wf, needsAdvance: true });
      }

      // send_to_pm — route feedback to PM for fixes
      wf.steps.reviewing.status = 'completed';
      wf.currentStep = 'pm_fix';
      const roundFeedback = (wf.steps.reviewing.agents || [])
        .filter(a => a.feedback).map(a => `### ${a.role}\n${a.feedback}`).join('\n\n');
      const pmRole = require('../config').findRole(config, 'PM');
      const skill = pmRole ? pmRole.skill : 'pm';
      const pmInstruction = `You are a Product Manager. Revise the PRD based on reviewer feedback.\n\nPRD path: ${wf.prdPath}\nRead the PRD, apply the feedback below, and save the updated file. Use the /${skill} skill.\n\n## REVISION DISCIPLINE — the PRD must not grow a copy of each fix\n\nThe PRD is the builder's spec; every duplicated statement dilutes it and risks the copies drifting apart across rounds. When applying feedback:\n1. **Rewrite the one section that owns the topic** (Solution subsection, the AC, the risk row). Do NOT restate the same requirement in other sections — if another section needs to point at it, reference it ("per §2.1"), don't copy it.\n2. **Revision log: at most ONE line per round**, e.g. "Round ${wf.round}: 2 MEDIUM + 1 LOW folded into §2.1/AC-2/§5." Do NOT write a per-item narrative of what changed — the workflow's feedback history already records it. If the PRD has a detailed review-history section from earlier rounds, collapse it to the one-line-per-round form now.\n3. **Companion Specs table cells stay to one line** (spec name + short scope, owner, path, status). Detailed requirements belong in the Solution section the spec serves — never in table cells.\n4. **Replace text, don't append.** A revision that only adds sentences is usually wrong — prefer editing the sentence that was inaccurate or incomplete.\n\n## Reviewer Feedback (Round ${wf.round})\n\n${roundFeedback}${notes ? `\n\n## Additional Notes from User\n\n${notes}` : ''}\n\nAfter updating the PRD, commit your changes. ${COMMIT_ON_CURRENT_BRANCH}`;
      const pmAgent = [{ role: 'PM', window: 'pm-fix', status: 'pending', instruction: pmInstruction, reportFeedback: true }];
      try {
        wf.steps.pm_fix = { status: 'running', agents: launchWorkflowAgents(wf, pmAgent, { useWorktrees: false }) };
      } catch (e) {
        wf.steps.pm_fix = { status: 'error', error: e.message, agents: pmAgent };
        state.saveWorkflow(wf);
        return res.status(500).json({ workflow: wf, error: e.message });
      }
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    // Relaunch pm_fix: re-launch the PM agent using existing reviewer feedback
    if (wf.currentStep === 'pm_fix' && action === 'launch') {
      const roundFeedback = (wf.steps.reviewing?.agents || [])
        .filter(a => a.feedback).map(a => `### ${a.role}\n${a.feedback}`).join('\n\n');
      const pmRole = require('../config').findRole(config, 'PM');
      const skill = pmRole ? pmRole.skill : 'pm';
      const pmInstruction = `You are a Product Manager. Revise the PRD based on reviewer feedback.\n\nPRD path: ${wf.prdPath}\nRead the PRD, apply the feedback below, and save the updated file. Use the /${skill} skill.\n\n## REVISION DISCIPLINE — the PRD must not grow a copy of each fix\n\nThe PRD is the builder's spec; every duplicated statement dilutes it and risks the copies drifting apart across rounds. When applying feedback:\n1. **Rewrite the one section that owns the topic** (Solution subsection, the AC, the risk row). Do NOT restate the same requirement in other sections — if another section needs to point at it, reference it ("per §2.1"), don't copy it.\n2. **Revision log: at most ONE line per round**, e.g. "Round ${wf.round}: 2 MEDIUM + 1 LOW folded into §2.1/AC-2/§5." Do NOT write a per-item narrative of what changed — the workflow's feedback history already records it. If the PRD has a detailed review-history section from earlier rounds, collapse it to the one-line-per-round form now.\n3. **Companion Specs table cells stay to one line** (spec name + short scope, owner, path, status). Detailed requirements belong in the Solution section the spec serves — never in table cells.\n4. **Replace text, don't append.** A revision that only adds sentences is usually wrong — prefer editing the sentence that was inaccurate or incomplete.\n\n## Reviewer Feedback (Round ${wf.round})\n\n${roundFeedback}${notes ? `\n\n## Additional Notes from User\n\n${notes}` : ''}\n\nAfter updating the PRD, commit your changes. ${COMMIT_ON_CURRENT_BRANCH}`;
      const pmAgent = [{ role: 'PM', window: 'pm-fix', status: 'pending', instruction: pmInstruction, reportFeedback: true }];
      try {
        wf.steps.pm_fix = { status: 'running', agents: launchWorkflowAgents(wf, pmAgent, { useWorktrees: false }) };
      } catch (e) {
        wf.steps.pm_fix = { status: 'error', error: e.message, agents: pmAgent };
        state.saveWorkflow(wf);
        return res.status(500).json({ workflow: wf, error: e.message });
      }
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'pm_fix' && action === 'approve') {
      wf.steps.pm_fix.status = 'completed';
      wf.round++;

      // Hard cap: if we've exceeded max rounds, complete instead of looping
      if (wf.round > MAX_REVIEW_ROUNDS) {
        console.log(`[workflow] Review hard cap reached (${MAX_REVIEW_ROUNDS} rounds). Completing workflow — manual review recommended.`);
        wf.currentStep = 'completed';
        writeWorklog(wf);
        state.saveWorkflow(wf);
        return res.json({ workflow: wf, completed: true, warning: `Review capped at ${MAX_REVIEW_ROUNDS} rounds. PRD approved at last revision.` });
      }

      wf.currentStep = 'reviewing';
      wf.steps.reviewing = { status: 'pending', agents: [] };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    // --- Companion specs step (review flow) ---
    // After reviewers approve, launch roles to write pending specs and review existing ones.
    // On re-runs (PRD revised), all §10 specs are re-verified against the updated PRD scope.
    if (wf.currentStep === 'companion_specs' && (!wf.steps.companion_specs || wf.steps.companion_specs.status === 'pending')) {
      // Read the PRD and collect ALL companion spec rows from the
      // Companion Specs section. Section numbering varies per project
      // (example-web uses §10, example-site uses §6, others may differ), so locate
      // the section by HEADING TEXT — match any "## …Companion Spec(s)…"
      // heading. Fall back to the legacy §10 heuristic only if no named
      // heading is found.
      const prdPath = path.join(projectRoot, wf.prdPath || '');
      let allSpecs = [];
      try {
        const prdContent = fs.readFileSync(prdPath, 'utf8');
        // Primary: find any "## … Companion Spec[s] …" heading regardless of
        // section number. Captures common variants:
        //   "## Companion Specs"
        //   "## 6. Companion specs required"
        //   "## §10. Companion Specs — delivery table"
        //   "## 11. Companion specs required before implementation"
        let csMatch = prdContent.match(/^##\s+[^\n]*\bcompanion\s+specs?\b[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/im);
        // Fallback: legacy §10 anchor (only if no Companion-Specs-named heading exists).
        if (!csMatch) csMatch = prdContent.match(/^## §?10[.\s].*?\n([\s\S]*?)(?=\n## §?\d|$)/m);
        if (csMatch) {
          const section = csMatch[1];
          // Markdown table rows always start AND end with `|`. Filtering on
          // `.includes('|')` alone catches prose lines whose inline-code
          // contains pipe characters (e.g. `LOW | ELEVATED | MEDIUM | HIGH`),
          // which can spawn ghost-role agents like "Medium".
          const lines = section.split('\n').filter(l => {
            const t = l.trim();
            return t.startsWith('|') && t.endsWith('|');
          });
          // Detect table format from header row
          const headerLine = lines.find(l => !/^\|[-\s|]+\|$/.test(l));
          const headerCells = headerLine ? headerLine.split('|').map(c => c.trim().toLowerCase()).filter(c => c) : [];
          // Look up columns by header name instead of hardcoded positions
          const colSpec = 0;
          const colOwner = headerCells.findIndex(h => /owner|role|assigned/i.test(h));
          const colFile = headerCells.findIndex(h => /file|path/i.test(h));
          const colStatus = headerCells.findIndex(h => /status/i.test(h));

          for (const line of lines) {
            // Skip header and separator rows
            if (/^\|[-\s|]+\|$/.test(line)) continue;
            const cells = line.split('|').map(c => c.trim().replace(/\*+/g, '').replace(/`/g, '')).filter(c => c);
            if (cells.length < 2) continue;
            const specDesc = cells[colSpec];
            if (/^[-\s]+$/.test(specDesc) || /^spec$/i.test(specDesc)) continue; // header row
            const fileCell = colFile >= 0 && cells.length > colFile ? cells[colFile] : '';
            const statusCell = colStatus >= 0 && cells.length > colStatus ? cells[colStatus] : '';

            let roles = [];
            if (colOwner >= 0 && cells.length > colOwner) {
              // Strip parenthetical commentary BEFORE extracting roles. Owners are
              // mentioned outside parens; reviewers / references / qualifiers go
              // inside parens and must NOT be treated as authoring roles. Examples:
              //   "/ux (reviewers: /brand, /marketing)"  →  /ux only
              //   "/brand (via UX-008)"                  →  /brand only
              //   "/brand + /marketing"  (no parens)     →  /brand AND /marketing
              const ownerCell = cells[colOwner].replace(/\([^)]*\)/g, '').trim();
              roles = (ownerCell.match(/\/(\w+)/g) || []).map(r => r.slice(1));
              if (roles.length === 0) {
                roles = ownerCell.split(/[,+&]|\band\b/i).map(s => s.trim()).filter(Boolean);
              }
            }
            if (roles.length === 0) {
              // No Owner column or empty — extract role from spec ID prefix (e.g. "UX-002" → UX)
              const prefixMatch = specDesc.match(/^([A-Za-z]+)-\d/);
              if (prefixMatch) roles = [prefixMatch[1]];
            }
            if (roles.length === 0) {
              // Fallback 1: infer role from file path directory (docs/<dir>/...)
              const dirRoleMap = { adrs: 'Architect', architecture: 'Architect', brand: 'Brand', ux: 'UX', marketing: 'Marketing', qa: 'QA', security: 'Security', pm: 'PM', devops: 'DevOps' };
              const dirMatch = fileCell.match(/^docs\/([a-z]+)\//i);
              if (dirMatch && dirRoleMap[dirMatch[1].toLowerCase()]) {
                roles = [dirRoleMap[dirMatch[1].toLowerCase()]];
              }
            }
            if (roles.length === 0) {
              // Fallback 2: keyword match in spec description (e.g. "ADR", "UX spec", "Copy spec")
              const descRoleMap = [
                [/\badr\b|\barchitect/i, 'Architect'],
                [/\bux\b/i, 'UX'],
                [/\bbrand\b|\bcopy\b/i, 'Brand'],
                [/\bmarketing\b/i, 'Marketing'],
                [/\bqa\b|\bquality\b/i, 'QA'],
                [/\bsecurity\b/i, 'Security'],
                [/\bpm\b|product\s*manager/i, 'PM'],
                [/\bdevops\b/i, 'DevOps'],
              ];
              for (const [re, role] of descRoleMap) {
                if (re.test(specDesc)) { roles = [role]; break; }
              }
            }
            // Filter out non-role values (dashes, empty, pure numbers)
            roles = roles.filter(r => r.length > 0 && !/^[-—–]+$/.test(r) && !/^\d+$/.test(r));
            if (roles.length === 0) continue;

            const isPending = /pending|required/i.test(statusCell) || (colStatus < 0 && /pending|required/i.test(fileCell));
            const fileExists = fileCell && !/^[-—–]+$/.test(fileCell) ? fs.existsSync(path.join(projectRoot, fileCell)) : false;
            allSpecs.push({ desc: specDesc, roles, fileCell: /^[-—–]+$/.test(fileCell) ? '' : fileCell, isPending, fileExists });
          }
        }
      } catch (e) {
        console.log(`[workflow] Could not read PRD for companion specs: ${e.message}`);
      }

      // Exclude .pen (Pencil design) specs — these are created interactively
      // via the designer role between the review and execution workflows.
      allSpecs = allSpecs.filter(s => !(/\.pen\b/i.test(s.fileCell) || /\.pen\b/i.test(s.desc)));

      if (allSpecs.length === 0) {
        // No §10 companion specs found. This was historically a silent
        // skip-to-completed path, but that masks a PM authoring oversight:
        // the PM is supposed to always produce a §10 Companion Specs table
        // when drafting a PRD (see docs/agents/pm.md). A PRD without §10
        // either truly needs no companion specs (rare — most PRDs touch UX
        // or brand or ADRs) or the PM forgot it (common). Block on a manual
        // decision rather than complete the workflow silently.
        console.log('[workflow] No companion specs found in §10 — blocking for manual decision');
        wf.steps.companion_specs = {
          status: 'blocked',
          error: 'No §10 Companion Specs section found in the PRD. The PM should always include a Companion Specs delivery table when drafting (see docs/agents/pm.md "Own the Preparation → Execution gate"). Choose: (a) approve to skip companion_specs and complete the workflow if this PRD truly needs no companion specs; (b) send_back to PM to add the §10 table; or (c) edit the PRD manually to add §10, then relaunch this step.',
        };
        state.saveWorkflow(wf);
        return res.json({ workflow: wf });
      }

      // Build per-role task map — each spec entry includes whether it needs writing or review
      // Normalize role names case-insensitively to avoid duplicates (e.g. "UX" vs "ux")
      const roleMap = {};
      for (const spec of allSpecs) {
        for (const roleName of spec.roles) {
          const normalized = roleName.charAt(0).toUpperCase() + roleName.slice(1).toLowerCase();
          if (!roleMap[normalized]) roleMap[normalized] = [];
          roleMap[normalized].push(spec);
        }
      }

      // Safety net: drop any role that doesn't resolve to a known project role.
      // Catches spurious roles produced by a misparsed table cell (e.g. "Medium"
      // landing in the Owner column when a prose line gets misread as a table row).
      // Without this, the dashboard spawns ghost agents that have no command file
      // and waste a tmux window + an API call.
      const { findRole } = require('../config');
      for (const roleName of Object.keys(roleMap)) {
        const resolved = findRole(config, roleName) || findRole(config, roleName.replace(/_/g, ' '));
        // Allow PM (we filter it out separately below) and any role that resolves
        // in config. Drop everything else with a warning.
        const isPMRole = /^pm$/i.test(roleName) || /^product.manager$/i.test(roleName);
        if (!resolved && !isPMRole) {
          console.warn(`[workflow] companion_specs: dropping unknown role "${roleName}" — not in project config. Likely a misparsed Companion Specs table row.`);
          delete roleMap[roleName];
        }
      }

      // Skip PM in companion_specs — PM already reviewed the PRD and would race with
      // domain experts writing concurrently. The user approval gate serves as the review.
      const isPMRole = (name) => /^pm$/i.test(name) || /^product.manager$/i.test(name);

      const specAgents = Object.entries(roleMap)
        .filter(([roleName]) => !isPMRole(roleName))
        .map(([roleName, specs]) => {
        const role = require('../config').findRole(config, roleName) || require('../config').findRole(config, roleName.replace(/_/g, ' '));
        const displayName = role ? role.role : roleName;
        const skill = role ? role.skill : roleName;

        const toWrite = specs.filter(s => s.isPending && !s.fileExists);
        const toReview = specs.filter(s => !s.isPending || s.fileExists);

        let instruction = `You are ${displayName}. The PRD at ${wf.prdPath} has been reviewed and approved (possibly revised). Your job is to ensure all companion specs assigned to your role in §10 are accurate and aligned with the current PRD scope.\n\n`;

        if (toWrite.length > 0) {
          instruction += `**Write these new specs** (file does not exist yet):\n${toWrite.map((s, i) => `${i + 1}. ${s.desc}${s.fileCell ? ` → save to: ${s.fileCell}` : ''}`).join('\n')}\n\nRead the PRD carefully, then write each spec. Save to the file path shown (or the standard directory for your role if no path is listed). After writing, update §10 in the PRD to change "Pending"/"Required" to "Done" and add the file path.\n\n`;
        }

        if (toReview.length > 0) {
          instruction += `**Review and update these existing specs** for alignment with the revised PRD:\n${toReview.map((s, i) => `${i + 1}. ${s.desc}${s.fileCell ? ` → file: ${s.fileCell}` : ''}`).join('\n')}\n\nFor each: read the current spec file and the revised PRD. Identify any gaps or misalignments caused by scope changes. Update the spec file to match the current PRD. If no changes are needed, confirm alignment in your feedback.\n\n`;
        }

        instruction += `Use the /${skill} skill. Commit any changes you make. ${COMMIT_ON_CURRENT_BRANCH}`;

        return {
          role: displayName,
          window: `spec-${roleName.slice(0, 10)}`,
          status: 'pending',
          reportFeedback: true,
          instruction,
        };
      });

      const newCount = allSpecs.filter(s => s.isPending && !s.fileExists).length;
      const reviewCount = allSpecs.length - newCount;
      console.log(`[workflow] Launching ${specAgents.length} agent(s) for companion specs: ${newCount} to write, ${reviewCount} to review`);
      wf.steps.companion_specs = { status: 'running', agents: launchWorkflowAgents(wf, specAgents, { useWorktrees: false }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'companion_specs' && (action === 'approve' || action === 'skip')) {
      wf.steps.companion_specs.status = action === 'skip' ? 'skipped' : 'completed';

      // On approve: mark all spec files that now exist as Done in §10
      if (action === 'approve' && wf.prdPath) {
        updateCompanionSpecsInPrd(path.join(projectRoot, wf.prdPath));
      }

      wf.currentStep = 'completed';
      advanceLinkedFeatures(wf.prdPath, 'Reviewed');
      writeWorklog(wf);
      commitWorkflowDocs(`docs(${wf.input.replace(/\s+/g, '-')}): mark Reviewed in backlog`);
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, completed: true });
    }

    return res.status(400).json({ error: `no valid transition for step=${wf.currentStep} action=${action}` });
  }

  // --- Execution workflow ---
  function handleExecutionAdvance(wf, action, notes, res, body = {}) {
    const prdId = wf.input.replace(/\s+/g, '-');

    if (wf.currentStep === 'qa_tests' && wf.steps.qa_tests.status === 'pending') {
      // qa_tests WRITES + commits pre-implementation tests (the approve gate below hard-
      // requires committed test files). So resolve the test-WRITING QA (skill: qa) — NOT the
      // `qa_review` reviewer, which only emits a verdict and commits nothing. Dual-QA presets
      // ship both `qa` and `qa_review` under role "QA"; findRole('QA','review') used to pick
      // the reviewer, which left the gate with no tests and stalled the run (example-app PRD-028,
      // 2026-06-07). Prefer a role whose skill is exactly `qa`; fall back to the `qa` skill.
      const qaRole = require('../config').getAllRoles(config).find(r => (r.skill || '').toLowerCase() === 'qa');
      const skill = qaRole ? qaRole.skill : 'qa';

      // Scan project's existing test infrastructure to give QA context
      let testInventory = '';
      try {
        const { execFileSync } = require('child_process');
        // Find existing test files
        const existingTests = execFileSync('find', ['.', '-type', 'f', '(', '-name', '*.test.*', '-o', '-name', '*.spec.*', ')', '-not', '-path', '*/node_modules/*', '-not', '-path', '*/.next/*'], {
          cwd: projectRoot, encoding: 'utf8', timeout: 10000,
        }).trim();
        const testFileList = existingTests ? existingTests.split('\n').filter(f => f.trim()) : [];

        if (testFileList.length > 0) {
          // Detect test frameworks
          const pkgJsonPath = path.join(projectRoot, 'package.json');
          let frameworks = [];
          try {
            const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
            const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
            if (allDeps.vitest) frameworks.push('vitest');
            if (allDeps.jest) frameworks.push('jest');
            if (allDeps['@playwright/test']) frameworks.push('playwright (E2E)');
            if (allDeps.supertest) frameworks.push('supertest');
          } catch (_) {}

          // Categorize existing tests
          const unitTests = testFileList.filter(f => /\.test\.(ts|js|tsx|jsx|mjs|cjs|mts|cts)$/.test(f));
          const specTests = testFileList.filter(f => /\.spec\.(ts|js|tsx|jsx)$/.test(f));

          testInventory = `\n\n## EXISTING TEST INFRASTRUCTURE — READ THIS FIRST

This project already has ${testFileList.length} test files. Follow the established patterns.

**Frameworks:** ${frameworks.join(', ') || 'unknown — check package.json'}
**Unit tests (*.test.*):** ${unitTests.length} files
**Spec tests (*.spec.*):** ${specTests.length} files

**Existing test files:**
${testFileList.slice(0, 30).map(f => `- ${f}`).join('\n')}${testFileList.length > 30 ? `\n... and ${testFileList.length - 30} more` : ''}

**RULES based on existing infrastructure:**
- Write new unit tests using the SAME framework and conventions as existing *.test.* files
- Write E2E tests as *.spec.* files using Playwright, following existing .spec.* conventions
- Do NOT duplicate coverage — if an AC is already tested in an existing file, skip it
- Place new test files next to the code they test, following the existing directory structure`;
        }
      } catch (e) {
        console.log(`[workflow] test inventory scan failed: ${e.message}`);
      }

      const prdId = wf.input.replace(/\s+/g, '-');
      const qaBranch = `qa-tests-${prdId}`;
      // iOS QA runtime is dominated by simulator time (a cold boot is the expensive
      // part). With the test-count cap removed, keep cost down by test DESIGN:
      // unit-first + batch UI scenarios. Only injected for iOS/simulator projects.
      const qaIosGuidance = (config.simulator && config.simulator.destination)
        ? `\n\n## iOS TEST DESIGN — KEEP SIMULATOR COST DOWN\n\nSimulator time dominates iOS QA runtime, and a **cold-simulator boot is the expensive part**. Design the tests you write to minimize it:\n- **Prefer unit tests (XCTest, no UI).** Logic, rules, math, formatting, validation, integrity checks, and string/golden assertions all run in the test bundle with no app launch or simulator interaction. Route every cell you can to unit level — most variant cells qualify.\n- **Reserve XCUITests for genuine end-to-end UI flows.** When you must write one, BATCH related scenarios into a single test that launches the app once and asserts multiple cells — do NOT write one cold app-launch per assertion, and do NOT reset or re-boot the simulator per test. Fewer, fatter UI tests amortize the boot cost.`
        : '';
      // A maintained repo map cuts the exploration fan-out agents otherwise
      // spend re-deriving the same component/test-infrastructure facts each run.
      const qaArchNote = fs.existsSync(path.join(projectRoot, 'ARCHITECTURE.md'))
        ? `\nBefore exploring the codebase, read ARCHITECTURE.md at the repo root — the maintained component map, guardrails, and test-infrastructure notes. Don't re-derive what it already tells you.\n`
        : '';
      const qaAgent = [{
        role: 'QA', window: 'qa-tests', status: 'pending', reportFeedback: true,
        branch: qaBranch,
        instruction: `You are QA. Write test cases for the PRD. This runs BEFORE implementation — do NOT run the tests.

PRD path: ${wf.prdPath}
Use the /${skill} skill.
${qaArchNote}${testInventory}

## YOUR TASK — ENUMERATE THE MATRIX, THEN COVER EVERY CELL

This is test-DRIVEN development: the tests you write here define the coverage contract the implementation must satisfy. **Enumerate the full acceptance-criteria × variant matrix from the SPEC first, then write a test for every relevant cell** — do not just cover the happy path of each AC.

1. Read the PRD completely, plus its data model / companion specs (ADRs, API contracts, copy specs). Extract every acceptance criterion (AC-N / US-N.M).
2. For each AC, enumerate the VARIANT AXES the spec makes relevant:
   - **Entity / type variants** — every entity class or type the AC applies to, not just the common one.
   - **State variants** — each state an entity can be in when the AC fires.
   - **Direction / toggle variants** — BOTH directions of every toggle/transition, plus re-entrancy.
   - **Payload shapes** — empty / single-field / multi-field / **invalid**.
3. Check existing test files — skip cells already covered; do NOT duplicate.
4. Write a test for EVERY uncovered relevant cell. **Negative / rejection cells must assert rejection** (error thrown, non-2xx, field absent from output) — a test that only asserts the happy path does NOT cover the invalid cell (a handler that silently drops bad input and returns success would pass it).
5. Commit your test files.
6. Report the coverage matrix (format below).

Do NOT run the tests. The feature is not implemented yet — running them would waste time, and red/failing tests are expected (that's TDD). Just write and commit.

## NO TEST-COUNT CAP — THE MATRIX IS THE BOUND, KEEP TESTS CHEAP

There is **no cap** on the number of tests — write exactly as many as the matrix requires: one per relevant cell, and no more. Only enumerate cells the spec makes real — skip anything in the PRD's "Out of scope" section and variants the data model doesn't allow. Control total COST by picking the cheapest level that covers each cell (below), not by writing fewer tests.

## TEST LEVEL — USE THE SIMPLEST LEVEL THAT WORKS

Unit test is the DEFAULT. Only escalate to integration when unit testing is impossible.

- **Unit test** — test a function/module directly. Import it, call it, assert the result. Use this for: validation logic, data transforms, state machines, parsing, formatting, business rules, utility functions. If the AC says "validate X returns error for Y" — that's a unit test of the validation function, NOT an HTTP test.
- **Integration test** — test multiple modules working together through an API endpoint. Use ONLY when the AC specifically requires verifying the HTTP layer (status codes, headers, auth middleware, request routing). If you can test the same logic by importing the handler/function directly, use a unit test instead.

DO NOT write integration/HTTP tests for:
- Input validation (test the validator function directly)
- Business logic (test the service/module directly)
- Data formatting (test the formatter directly)
- Error messages (test the function that generates them)${qaIosGuidance}

## WHAT NOT TO TEST — CRITICAL

- **No LLM/AI API tests** — no real calls (costs money), no mocked calls (proves nothing). Mark LLM-dependent cells as MANUAL.
- **No E2E / browser tests** — the CI gate will reject them (this is web/Playwright; iOS XCUITests are covered by the iOS guidance above where present).
- **No trivial tests** — "renders without error", "exports exist", etc.

## FEEDBACK FORMAT

**Approved:** yes
**Test files:** list of files created

### Coverage Matrix
| AC | Variant (axis: value) | Level | Test (file:name) or status |
|----|-----------------------|-------|----------------------------|
| AC-1 | entity: template-page | unit | pages.test:reprocesses_template |
| AC-1 | payload: invalid | unit | pages.test:rejects_invalid_field |
| AC-2 | (single) | integration | api.test:delete_requires_owner |
| AC-3 | (LLM output quality) | MANUAL | requires real LLM output |
| AC-4 | (single) | EXISTING | already covered by foo.test.ts |

### Summary
[N tests across M cells; N MANUAL, N already covered. Call out any relevant cell you could NOT cover and why.]

Report **Approved: yes** once every relevant cell has a test (or a justified MANUAL / EXISTING / out-of-scope). Note remaining gaps explicitly — the advisory coverage_matrix check after implementation will surface anything missed.`,
      }];
      wf.steps.qa_tests = { status: 'running', agents: launchWorkflowAgents(wf, qaAgent, { useWorktrees: true }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    // qa_tests SKIP — owner escape hatch for a PRD that genuinely needs no pre-implementation
    // tests (e.g. pure config / docs / infra). Bypasses the committed-tests gate and goes
    // straight to planning; best-effort cleanup of the QA worktree (any uncommitted scaffold
    // is discarded — that's the point of skipping). Never reached by auto-advance (manual only).
    if (wf.currentStep === 'qa_tests' && action === 'skip') {
      const qaBranchName = ((wf.steps.qa_tests.agents || [])[0] || {}).branch;
      if (qaBranchName) { try { gitOps.removeWorktree(qaBranchName); } catch (_) {} }
      wf.steps.qa_tests.status = 'skipped';
      wf.currentStep = 'planning';
      if (!wf.steps.planning) wf.steps.planning = { status: 'pending', agents: [] };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    if (wf.currentStep === 'qa_tests' && action === 'approve') {
      // GATE: validate test case quality by scanning committed files
      const qaAgents = wf.steps.qa_tests.agents || [];
      const qaFeedback = qaAgents.map(a => a.feedback || '').join('\n');
      const qaTestsOverride = body.override === true;

      if (!qaFeedback.trim()) {
        return res.status(400).json({
          error: 'Cannot approve: QA agent has not reported feedback yet.',
        });
      }

      // --- Mechanical file scan: find new/modified test files and check for violations ---
      const violations = [];
      const warnings = [];
      // Scan in QA worktree if it exists, otherwise main
      const qaAgent0ForScan = (wf.steps.qa_tests.agents || [])[0];
      const qaScanBranch = qaAgent0ForScan?.branch;
      const qaScanCwd = qaScanBranch ? path.join(worktreesPath, qaScanBranch) : projectRoot;
      const scanCwd = fs.existsSync(qaScanCwd) ? qaScanCwd : projectRoot;
      try {
        // Get files changed since workflow started (new test files by QA)
        const { execFileSync } = require('child_process');
        const diffOutput = execFileSync('git', ['diff', '--name-only', 'main...HEAD'], {
          cwd: scanCwd, encoding: 'utf8', timeout: 10000,
        }).trim();
        // Also check unstaged new files
        const untrackedOutput = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
          cwd: scanCwd, encoding: 'utf8', timeout: 10000,
        }).trim();

        const allFiles = [...new Set([...diffOutput.split('\n'), ...untrackedOutput.split('\n')])].filter(f => f.trim());
        // Recognize test files across the languages we run agent workflows in.
        // The scan exists to prove QA actually committed tests before approval —
        // restricting to JS/TS broke iOS / Android / native projects that legitimately
        // commit Swift / Kotlin / Java / Python / Go / Rust tests.
        const testFiles = allFiles.filter(f =>
          /\.(test|spec)\.(ts|js|tsx|jsx|mjs|cjs|mts|cts)$/.test(f) ||  // JS/TS — .test.ts, .spec.tsx, etc.
          /Tests?\.swift$/.test(f) ||                                    // Swift — FooTests.swift (Apple)
          /Tests?\.(kt|kts|java)$/.test(f) ||                            // Kotlin / Java — FooTest.kt
          /(?:^|\/)test_[^/]+\.py$/.test(f) ||                           // Python pytest — test_foo.py
          /_test\.py$/.test(f) ||                                        // Python unittest — foo_test.py
          /_test\.go$/.test(f) ||                                        // Go — foo_test.go
          /(?:^|\/)tests\/.+\.rs$/.test(f)                               // Rust — tests/*.rs
        );

        if (testFiles.length === 0 && !qaTestsOverride) {
          return res.status(400).json({
            error: 'Cannot approve: no test files found in recent commits or working tree. QA must commit test files before approval. If this PRD is legitimately test-free (pure infra/ops/config with an all-MANUAL coverage matrix, e.g. R2 bucket versioning), the QA agent should say so in its feedback and you can bypass this specific approval with {"action":"approve","override":true}.',
          });
        }
        if (testFiles.length === 0 && qaTestsOverride) {
          console.log(`[workflow] qa_tests operator override: approving with no committed test files (round=${wf.round})`);
          wf.steps.qa_tests.overrides = (wf.steps.qa_tests.overrides || []).concat({
            at: new Date().toISOString(), reason: body.note || 'operator override: legitimately test-free PRD (all-MANUAL matrix)',
          });
        }

        // Reuse the shared LLM violation scan (same helper the merge_for_review
        // gate uses, so both checkpoints enforce identical rules).
        const llmScan = scanTestFilesForLlmViolations(scanCwd, 'main');
        for (const v of llmScan.violations) violations.push(v);

        // Scan each test file for qa_tests-specific warnings
        for (const relPath of testFiles) {
          const fullPath = path.join(scanCwd, relPath);
          let content;
          try { content = fs.readFileSync(fullPath, 'utf8'); } catch (_) { continue; }

          // WARN: LLM SDK imports used with mocks — flag as MANUAL-worthy
          if (/from\s+['"](@anthropic-ai\/sdk|openai|@google\/generative)['"]/.test(content) || /require\s*\(\s*['"](@anthropic-ai\/sdk|openai)['"]\s*\)/.test(content)) {
            if (/vi\.mock|jest\.mock/i.test(content)) {
              warnings.push(`${relPath}: mocks LLM SDK. Mocked LLM tests prove nothing — mark these ACs as MANUAL instead.`);
            }
          }
          // WARN: Suspiciously long timeouts (>30s = likely waiting for LLM)
          const timeoutMatches = content.match(/timeout\s*[=:]\s*(\d+)/gi) || [];
          for (const tm of timeoutMatches) {
            const ms = parseInt(tm.match(/(\d+)/)[1]);
            if (ms > 30000) {
              warnings.push(`${relPath}: timeout ${ms}ms (>${30}s) — suggests waiting for LLM or external service.`);
            }
          }
          // WARN: .spec.ts naming convention outside e2e/ directory (typically E2E by convention)
          if (/\.spec\.(ts|js|tsx|jsx)$/.test(relPath) && !relPath.startsWith('e2e/') && !violations.some(v => v.startsWith(relPath))) {
            warnings.push(`${relPath}: uses .spec.* naming (often E2E convention). Verify this is unit/integration level.`);
          }
        }

        // --- Test-level ratio check: flag when HTTP tests dominate ---
        // Re-scan to count HTTP-level vs unit-level tests
        let httpTestFiles = 0;
        let unitTestFiles = 0;
        for (const relPath of testFiles) {
          const fullPath = path.join(scanCwd, relPath);
          let content;
          try { content = fs.readFileSync(fullPath, 'utf8'); } catch (_) { continue; }
          const isHttpLevel = /supertest|\.inject\s*\(|app\.listen|fetch\s*\(\s*['"`]http:\/\/localhost/i.test(content)
            || /request\s*\(\s*(app|server)\s*\)/i.test(content);
          if (isHttpLevel) {
            httpTestFiles++;
            // Check if this HTTP test is just testing validation/logic that could be a unit test
            const linesWithAssert = (content.match(/expect\s*\(/g) || []).length;
            const linesWithStatus = (content.match(/\.status\s*\(\s*\d+\s*\)|toHaveStatus|statusCode/g) || []).length;
            // If >60% of assertions are just status code checks, it's likely overtesting at HTTP level
            if (linesWithAssert > 0 && linesWithStatus / linesWithAssert > 0.6) {
              warnings.push(`${relPath}: ${linesWithStatus}/${linesWithAssert} assertions are status code checks — this logic is likely unit-testable.`);
            }
          } else {
            unitTestFiles++;
          }
        }
        if (httpTestFiles > 0 && unitTestFiles === 0 && testFiles.length > 1) {
          violations.push(`All ${httpTestFiles} new test files use HTTP-level testing (supertest/inject/fetch). Most ACs should be tested at the unit level by importing functions directly. Rewrite tests as unit tests where possible.`);
        } else if (httpTestFiles > unitTestFiles && testFiles.length > 2) {
          warnings.push(`${httpTestFiles}/${testFiles.length} test files are HTTP-level. Consider if some could be unit tests instead.`);
        }
      } catch (e) {
        // If git scan fails, fall back to feedback-only validation
        console.log(`[workflow] qa_tests file scan failed: ${e.message}`);
      }

      // Hard block on violations
      if (violations.length > 0) {
        return res.status(400).json({
          error: `Cannot approve: ${violations.length} test file violation(s) found. QA must fix these and recommit.\n\n${violations.join('\n')}`,
          violations,
          warnings,
        });
      }

      // Merge QA worktree branch back to main before planning
      const qaAgent0 = (wf.steps.qa_tests.agents || [])[0];
      const qaBranchName = qaAgent0?.branch;
      if (qaBranchName && gitOps.branchExists(qaBranchName)) {
        try {
          const ahead = gitOps.commitsAhead(qaBranchName, 'main');
          if (ahead > 0) {
            const { execFileSync } = require('child_process');
            execFileSync('git', ['merge', qaBranchName, '--no-edit', '-m', `Merge ${qaBranchName} (pre-implementation tests)`], {
              cwd: projectRoot, encoding: 'utf8', timeout: 30000,
            });
            console.log(`[workflow] Merged QA branch ${qaBranchName} to main (${ahead} commits)`);
          }
          // Clean up worktree and branch
          try { gitOps.removeWorktree(qaBranchName); } catch (_) {}
          try { gitOps.deleteBranch(qaBranchName, false); } catch (_) {}
        } catch (e) {
          console.error(`[workflow] Failed to merge QA branch ${qaBranchName}: ${e.message}`);
          return res.status(500).json({ error: `Failed to merge QA test branch: ${e.message}. Resolve manually and retry.` });
        }
      }

      wf.steps.qa_tests.status = 'completed';
      wf.steps.qa_tests.qualityWarnings = warnings.length > 0 ? warnings : undefined;
      wf.steps.qa_tests.violations = violations.length > 0 ? violations : undefined;
      wf.currentStep = 'planning';
      if (!wf.steps.planning) wf.steps.planning = { status: 'pending', agents: [] };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true, ...(warnings.length > 0 ? { warnings } : {}) });
    }

    // --- Planning step --- breaks PRD into scoped implementation tasks
    if (wf.currentStep === 'planning' && (!wf.steps.planning || wf.steps.planning.status === 'pending' || !wf.steps.planning.agents?.length)) {
      if (!wf.steps.planning) wf.steps.planning = { status: 'pending', agents: [] };

      // PRD-001: Monolithic task_execution shortcut.
      // When step_strategies.task_execution === 'monolithic', the planner step
      // is redundant — the plan is always a single "implement the whole PRD"
      // task. Skip the planner agent, run a basic PRD-existence check, and
      // synthesize the plan inline. Saves ~5-10 min wallclock + planner tokens
      // per workflow.
      //
      // Default flipped to 'monolithic' 2026-05-27 — the PRD-009 experiment
      // showed monolithic ~5× faster + ~3× cheaper at PRD-009/011/012 scale,
      // and example-ios has been running monolithic exclusively without issue.
      // Projects that want fine-grained (per-task agents) opt out explicitly:
      //   step_strategies:
      //     task_execution: fine-grained
      //     fix_execution: fine-grained
      const taskStrategy = (config.step_strategies && config.step_strategies.task_execution) || 'monolithic';
      if (taskStrategy === 'monolithic') {
        // wf.prdPath is project-root-relative (e.g. "docs/prds/PRD-011-...md");
        // resolve against projectRoot, not docsPath.
        const prdAbsPath = path.join(projectRoot, wf.prdPath || '');
        if (!wf.prdPath || !fs.existsSync(prdAbsPath)) {
          wf.steps.planning.status = 'blocked';
          wf.steps.planning.validationFailure = {
            validation: 'failed',
            message: `PRD file not found at ${prdAbsPath}`,
            missing: [{ type: 'prd', description: 'PRD markdown file', expected_path: prdAbsPath }],
          };
          state.saveWorkflow(wf);
          return res.status(400).json({
            error: `Monolithic planning blocked — PRD not found at ${prdAbsPath}.`,
            validationFailure: wf.steps.planning.validationFailure,
          });
        }
        const prdId = (wf.input || 'PRD').replace(/\s+/g, '-');
        wf.taskPlan = {
          validation: 'passed',
          monolithic: true,
          tasks: [{
            id: 1,
            name: `Implement ${prdId} end-to-end`,
            title: `Implement ${prdId} end-to-end`,
            description: `Read the PRD in full at ${wf.prdPath}. Implement every acceptance criterion and surface the PRD specifies, in one pass. Use the pre-implementation tests at the project's test directory (committed before task_execution started) as your unit-test scaffolding — un-skip them as you implement the corresponding production code. Add UI / integration test coverage for any gesture / interaction ACs. Commit per logical chunk (per surface or per feature group is fine — your judgment on granularity); the dashboard's commit ribbon will show each commit as a milestone. When all ACs are implemented and the relevant test suite passes, POST feedback summarizing what you built, what's tested, and any residual concerns.`,
            roles: ((config.roles.execution || [])[0]?.role ? [config.roles.execution[0].role] : ['iOS Dev']),
            acs_covered: ['all'],
            dependencies: [],
            estimated_size: 'large',
          }],
        };
        wf.steps.planning = {
          status: 'completed',
          agents: [{
            role: 'Planner', window: 'planner', status: 'done',
            feedback: `Planning shortcut: step_strategies.task_execution=monolithic. Synthesized single-task plan; planner agent not launched.\n\n\`\`\`json\n${JSON.stringify(wf.taskPlan, null, 2)}\n\`\`\``,
          }],
          synthesizedAt: new Date().toISOString(),
        };
        wf.currentStep = 'task_execution';
        if (!wf.taskExecution) {
          // Mirror the structure that the normal approve path creates so
          // task_execution's launch logic can pick up cleanly.
          wf.taskExecution = {
            currentTaskIndex: 0,
            taskStates: { '0': { status: 'pending', startedAt: null, completedAt: null, tokenUsage: null, agentSummary: null, agents: [] } },
          };
        }
        if (!wf.steps.task_execution) wf.steps.task_execution = { status: 'pending', agents: [] };
        state.saveWorkflow(wf);
        return res.json({ workflow: wf, needsAdvance: true });
      }

      const roleList = (config.roles.execution || []).map(r => `- ${r.role} (/${r.skill})`).join('\n');
      const plannerAgent = [{
        role: 'Planner', window: 'planner', status: 'pending', reportFeedback: true,
        instruction: `## YOU ARE A PLANNER — NOT A FIX AGENT — READ THIS FIRST

**Your job is to produce a task plan for the PRD. You do NOT write code. You do NOT fix bugs. You do NOT run tests. You decompose the PRD into discrete tasks for downstream execution agents.**

**FORBIDDEN FEEDBACK FORMAT** — your feedback will be REJECTED if you use any of these patterns (these are FIX-REPORT or REVIEW formats from CLAUDE.md, used by Dev / Reviewer agents in OTHER steps — wrong for your role):
- \`**All issues addressed:** yes|no\` / \`**Committed:** <hash>\` / \`### Changes\` (fix-report format — you are not a fix agent)
- \`**Approved:** yes|no\` / \`**Blocking:** N\` / \`### Findings\` (review format — you are not a reviewer)
- Any phrasing that implies you made code changes, ran tests, or reviewed someone else's work

**REQUIRED FEEDBACK FORMAT** — your feedback MUST contain a \`\`\`json code block with a \`tasks\` array, parseable by the workflow. Optionally include a one-line summary header above the JSON (e.g. \`Plan: 14 tasks (3 small / 8 medium / 3 large), est. ~5.5 hours total.\`). A markdown task list with \`### Role\` headers + numbered tasks is accepted as a fallback parse, but JSON is strongly preferred. Do NOT submit prose-only feedback — the approve gate cannot parse it.

**IF VALIDATION FAILS** (Phase 1): report the failure, set the validation_failure field, and do NOT produce a task plan. Don't try to "fix" the PRD; flag the missing artifacts and stop.

---

PRD path: ${wf.prdPath}

Use the /planner skill. Read the PRD completely, including acceptance criteria, technical spec, and companion specs referenced in §10.

## Available execution roles:
${roleList}

**CHOOSING THE RIGHT ROLE PER TASK.** When multiple execution roles are
listed above, the right role for each task is determined by the FILES the
task will modify. Mapping:
- Swift / SwiftUI / iOS APIs / \`.xcodeproj\` / iOS test targets / \`.entitlements\` / \`PrivacyInfo.xcprivacy\` / \`Info.plist\` → \`/ios_dev\`
- HTML / CSS / JS / TS / React / Svelte / Vue / Astro / Vite / Tailwind / web frameworks → \`/frontend_dev\`
- Server code (Node/Go/Python backends), SQL migrations, API contracts, server-side auth → \`/backend_dev\`
- Kotlin / Jetpack Compose / Android Studio → \`/android_dev\`
- Infrastructure-as-code, CI YAML, Docker / Kubernetes → \`/devops\`

If a task touches files predominantly owned by one role, assign that role.
Cross-cutting work goes to the role whose conventions cover the MAJORITY
of the change. **Do not default to the first listed role** — match each
task to its file types.

IMPORTANT: Tasks execute strictly one at a time, sequentially. Do NOT group tasks into "waves" or "parallel batches". Order them so each task builds on prior completed work.

## TASK SIZING — TARGET 10–30 MIN PER TASK + HARD CEILING ON COUNT

Tasks that take longer than ~30 min have HIGH restart cost on failure (the whole task starts over), risk context exhaustion, and make progress hard to observe. Tasks under ~10 min are dominated by fixed overhead (agent boot ~30–60s, role/skill load, context build, commit, feedback POST) and waste runtime. Target the 15–25 min sweet spot.

**HARD CEILING: a plan with more than 25 tasks will be rejected by the workflow.** A typical small-to-medium feature should produce 8–15 tasks; a large multi-surface feature 15–25. If your draft exceeds 25, **re-bundle before submitting** — see the "How to bundle" section below. If you can't get under 25, the PRD is too large for one workflow — split it and report that back, do NOT submit an oversized plan.

### How to bundle — tightly-coupled work is ONE task

The dominant over-decomposition pattern in iOS work is **"separate tasks for tests after all implementation is done"**. This is wrong. Tests for a given surface are written by the agent BUILDING that surface, in the same task. Specifically:

- **A SwiftUI view's implementation + its XCUITest(s) + its accessibility identifiers + its localized strings are ONE TASK.** Not four. The agent writes the view, adds the test, wires the identifiers, and adds the strings in a single turn. They share the same mental model and build state — splitting them just multiplies overhead.
- **A new repository method + its unit tests are ONE TASK.** Not two. The agent writes the method and the test against in-memory ModelContainer in the same turn.
- **A new module's named constants + enums + first consumer are ONE TASK.**
- **A complete screen's localization strings (all keys in one .xcstrings update) is ONE TASK.** Don't split by section.
- **Snapshot tests for new visual surfaces ride with the surface implementation task** — the agent who builds the view also captures the baseline.

Avoid creating a "test phase" at the back of the plan. The pattern "tasks 1-N implement, tasks N+1-2N write tests, tasks 2N+1-3N do verification" is wasteful — it forces N agent boots that could have been done inline at near-zero marginal cost during the original task.

### CRITICAL: Don't duplicate qa_validation's work in task_execution

After task_execution completes, the workflow runs a **dedicated qa_validation step** with these responsibilities (read the actual instruction at workflow.js:4619 if you need detail):

1. **Run the full test suite** (xcodebuild test / vitest / etc.) and report test counts.
2. **Run E2E / Playwright / XCUITest** suites.
3. **Capture visual smoke screenshots** of every AC surface and commit to \`docs/pr-evidence/<PRD>/visual/\`.
4. **Scan launch console for runtime warnings** (Invalid Configuration, missing color, etc.) and block on them.
5. **Re-run the full suite on every fix-loop round** to verify fixes don't regress.

**Therefore in task_execution, the planner must NOT emit:**

- Tasks named "Full XCUITest suite — first green pass" / "all green" / similar omnibus — qa_validation does this. (G1: REJECTED)
- Tasks named "Flake check — Nx consecutive runs" — qa_validation runs the suite already; flakes show up there. If a specific test is genuinely flaky, mark it with \`XCTSkipIf\` in the implementation task. (G1: REJECTED for N≥2)
- Tasks named "Regression smoke" / "PRD-N regression" / "Verify nothing broke" — qa_validation's full-suite run covers ALL prior tests. There's no need for a separate "smoke" task. (G1: REJECTED)
- Tasks named "PR evidence — screenshot capture" / "Visual conformance screenshots" / "Visual smoke for all surfaces" — qa_validation captures these to the same \`docs/pr-evidence/\` directory the AC verifier reads from. (G1: REJECTED if exhaustive; allowed if scoped to a SPECIFIC artifact that qa_validation won't produce, e.g. "before/after gradient comparison strip for PR body §3".)
- Tasks named "SwiftLint pass" / "static analyzer pass" as a standalone — fold into implementation tasks. Each implementation task should pass lint before committing.

**What task_execution SHOULD include for testing:**

- For each implementation task: write the test(s) for the AC(s) that task covers, IN THE SAME TASK, and verify with \`-only-testing\` on just those tests during iteration. A passing \`-only-testing\` run for the new tests is sufficient signal that the implementation works.
- ONE task for "PR body draft" at the end (qa_validation doesn't write the PR body).

**What task_execution SHOULD NOT include for testing:**

- A "test phase" at the back of the plan with one task per AC's test (the dominant over-decomposition pattern — see "How to bundle" above).
- ANY task whose primary work is running the full test suite. Iterate with \`-only-testing\` during implementation; qa_validation runs the full suite once at the end of task_execution.

### Anti-patterns to BREAK UP — these are NOT coupled work

- **"Final verification" omnibus tasks.** If you genuinely need an end-of-plan task (e.g. PR body draft + a specific artifact qa_validation doesn't produce), split into 2 small tasks. Each is restartable.

## SELF-CHECK BEFORE SUBMITTING — REQUIRED

After producing your plan, sanity-check it BEFORE returning the JSON:
- **Total task count ≤ 25.** Plans exceeding this WILL BE REJECTED by the workflow. If you're at 30+, find your largest cluster of one-AC-per-task tests and merge them into their implementation tasks.
- **No standalone "test writing" phase.** Each test should be coupled to the implementation task it covers. If you find a task whose ONLY job is "write XCUITest for AC N", that test belongs in the task that implements the surface AC N covers.
- **No "regression smoke" / "verify nothing broke" tasks at all.** qa_validation's full-suite run covers ALL prior PRD tests (auto-scoped via test-impact analysis). A standalone regression task WILL BE REJECTED, regardless of how many prior PRDs are touched.
- **Size distribution.** Count of small/medium/large. If >50% are small (<15 min), re-bundle related ones.
- **Estimated total wall-time.** Sum size midpoints (small=10, medium=22, large=37 min). If total > 8 hours, the PRD is too large — report back, don't submit.

Include a one-line summary at the top of your feedback (before the JSON code block): "Plan: N tasks (X small / Y medium / Z large), est. ~H hours total."

Run Phase 1 (input validation) first. If validation fails, report the failure — do NOT produce a task plan. If validation passes, proceed to Phase 2 (task plan).

${EFFICIENCY_INSTRUCTIONS}`,
      }];
      wf.steps.planning = { status: 'running', agents: launchWorkflowAgents(wf, plannerAgent, { useWorktrees: false }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'planning' && action === 'approve') {
      // Parse the task plan from the planner's feedback
      const plannerFeedback = (wf.steps.planning.agents || []).map(a => a.feedback || '').join('\n');
      let taskPlan = null;

      // Strategy 1: JSON code block (```json ... ``` or ``` ... ```)
      const jsonMatch = plannerFeedback.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        taskPlan = tryParseJSON(jsonMatch[1]);
      }

      // Strategy 2: Find any JSON object with a "tasks" array anywhere in the feedback
      if (!taskPlan) {
        // Look for { ... "tasks": [ ... ] ... } even without code fences
        const tasksArrayMatch = plannerFeedback.match(/\{[\s\S]*?"tasks"\s*:\s*\[[\s\S]*?\]\s*\}/);
        if (tasksArrayMatch) {
          taskPlan = tryParseJSON(tasksArrayMatch[0]);
        }
      }

      // Strategy 3: Parse task list from markdown text
      // Handles: role headers + numbered tasks, or inline role annotations
      if (!taskPlan) {
        const tasks = [];
        let currentRoles = [];
        let taskId = 0;
        const allRoles = require('../config').getAllRoles(config);

        function matchRole(text) {
          const clean = text.replace(/\s*\(\/\w+\).*/, '').trim();
          let matched = allRoles.find(r => r.role.toLowerCase() === clean.toLowerCase());
          if (!matched) {
            const skillMatch = text.match(/\/(\w+)/);
            if (skillMatch) matched = allRoles.find(r => r.skill === skillMatch[1]);
          }
          return matched;
        }

        for (const line of plannerFeedback.split('\n')) {
          // Task header: "### Task N — Role: description" or "### Task N: description"
          // Match this BEFORE the generic role-header pattern, since the role-header
          // regex would otherwise capture "Task N" and discard the role + description.
          const taskHeader = line.match(/^#{2,4}\s+\*?\*?Task\s+(\d+)\s*[:—–-]\s*(.+?)\*?\*?\s*$/i);
          if (taskHeader) {
            let desc = taskHeader[2].trim();
            let headerRoles = [];
            const roleColon = desc.match(/^([^:]{1,40}?):\s+(.+)$/);
            if (roleColon) {
              const matched = matchRole(roleColon[1]);
              if (matched) {
                headerRoles = [matched.role];
                desc = roleColon[2].trim();
              }
            }
            if (headerRoles.length === 0) {
              const inlineRole = desc.match(/\(([^)]+?Dev|[^)]+?QA|[^)]+?DevOps|[^)]+?Architect|[^)]+?Designer|[^)]+?Security)\)/i);
              if (inlineRole) {
                const matched = matchRole(inlineRole[1]);
                if (matched) headerRoles = [matched.role];
              }
            }
            if (headerRoles.length === 0) {
              const lower = desc.toLowerCase();
              if (/\b(migration|endpoint|api|route|cron|database|db)\b/.test(lower)) {
                const be = allRoles.find(r => r.role === 'Backend Dev');
                if (be) headerRoles = [be.role];
              } else if (/\b(component|page|ui|ux|css|style|layout|form|button)\b/.test(lower)) {
                const fe = allRoles.find(r => r.role === 'Frontend Dev');
                if (fe) headerRoles = [fe.role];
              }
            }
            if (headerRoles.length === 0) {
              const firstExec = (config.roles.execution || [])[0];
              if (firstExec) headerRoles = [firstExec.role];
              else headerRoles = ['Backend Dev'];
            }
            taskId++;
            const acsMatch = desc.match(/\((AC-[\w,\s–-]+)\)/g) || [];
            const acs = acsMatch.flatMap(m => m.replace(/[()]/g, '').split(/[,\s]+/).filter(s => /^AC-/.test(s)));
            tasks.push({
              id: taskId,
              name: desc.replace(/\s*\(AC-[\w,\s–-]+\)/g, '').replace(/\s*[\(\[][^)\]]*Dev[^)\]]*[\)\]]/gi, '').trim().slice(0, 80),
              description: desc,
              roles: headerRoles,
              dependencies: [],
              acs_covered: acs,
              estimated_size: 'medium',
            });
            currentRoles = headerRoles;
            continue;
          }

          // Section header: ### Role (/skill) or ### Role or ## Role
          const roleHeader = line.match(/^#{2,3}\s+(.+?)(?:\s*\(\/\w+\))?(?:\s*[—–-].*)?$/);
          if (roleHeader) {
            const matched = matchRole(roleHeader[1]);
            if (matched) {
              currentRoles = [matched.role];
            } else {
              console.log(`[workflow] Skipping non-role header in planner output: "${roleHeader[1]}"`);
            }
            continue;
          }

          // Numbered task: "N. Desc", "**Task N: Desc**", "- **Task N: Desc**",
          // "**N. Desc**" (bold-numbered without literal "Task" word — common
          // planner output variant under role headers)
          const taskLine = line.match(/^\d+\.\s+(.+)/)
            || line.match(/^\*\*Task\s+\d+[:\s]+(.+?)\*\*/)
            || line.match(/^-?\s*\*\*Task\s+\d+[:\s]+(.+?)\*\*/)
            || line.match(/^\*\*\d+\.\s+(.+?)\*\*\s*$/);
          if (!taskLine) continue;

          const desc = taskLine[1].trim();

          // Extract inline role annotation: "... (Backend Dev)" or "... [Frontend Dev]" or "— Backend Dev"
          let taskRoles = [...currentRoles];
          if (taskRoles.length === 0) {
            const inlineRole = desc.match(/\(([^)]+?Dev|[^)]+?QA|[^)]+?DevOps|[^)]+?Architect|[^)]+?Designer|[^)]+?Security)\)/i)
              || desc.match(/\[([^\]]+?Dev|[^\]]+?QA|[^\]]+?DevOps|[^\]]+?Architect|[^\]]+?Designer|[^\]]+?Security)\]/i)
              || desc.match(/[—–-]\s*((?:Frontend|Backend)\s+Dev|DevOps|QA|Architect|Designer|Security)\s*$/i);
            if (inlineRole) {
              const matched = matchRole(inlineRole[1]);
              if (matched) taskRoles = [matched.role];
            }
          }

          // Still no role? Try to infer from keywords in the description
          if (taskRoles.length === 0) {
            const lower = desc.toLowerCase();
            if (/\b(migration|endpoint|api|route|cron|database|db)\b/.test(lower)) {
              const be = allRoles.find(r => r.role === 'Backend Dev');
              if (be) taskRoles = [be.role];
            } else if (/\b(component|page|ui|ux|css|style|layout|form|button)\b/.test(lower)) {
              const fe = allRoles.find(r => r.role === 'Frontend Dev');
              if (fe) taskRoles = [fe.role];
            }
          }

          // Last resort: assign to first execution role
          if (taskRoles.length === 0) {
            const firstExec = (config.roles.execution || [])[0];
            if (firstExec) taskRoles = [firstExec.role];
            else taskRoles = ['Backend Dev'];
            console.log(`[workflow] No role found for task "${desc.slice(0, 60)}", defaulting to ${taskRoles[0]}`);
          }

          taskId++;
          const acsMatch = desc.match(/\((AC-[\w,\s–-]+)\)/g) || [];
          const acs = acsMatch.flatMap(m => m.replace(/[()]/g, '').split(/[,\s]+/).filter(s => /^AC-/.test(s)));
          tasks.push({
            id: taskId,
            name: desc.replace(/\s*\(AC-[\w,\s–-]+\)/g, '').replace(/\s*[\(\[][^)\]]*Dev[^)\]]*[\)\]]/gi, '').trim().slice(0, 80),
            description: desc,
            roles: taskRoles,
            dependencies: [],
            acs_covered: acs,
            estimated_size: 'medium',
          });
        }

        // Infer dependencies: tasks with different roles depend on the prior role group
        if (tasks.length > 0) {
          let prevRole = tasks[0].roles[0];
          for (let i = 0; i < tasks.length; i++) {
            if (tasks[i].roles[0] !== prevRole) {
              const depIds = tasks.slice(0, i).map(t => t.id);
              for (let j = i; j < tasks.length; j++) tasks[j].dependencies = [...depIds];
              prevRole = tasks[i].roles[0];
            }
          }
          taskPlan = { validation: 'passed', tasks };
          console.log(`[workflow] Parsed ${tasks.length} tasks from planner markdown (no JSON block found)`);
        }
      }

      // Check for input validation failure — structured JSON or prose
      if (taskPlan && taskPlan.validation === 'failed') {
        const missing = (taskPlan.missing || []).map(m => `- [${m.type}] ${m.description}: ${m.expected_path || 'unknown path'}`).join('\n');
        wf.steps.planning.status = 'blocked';
        wf.steps.planning.validationFailure = taskPlan;
        state.saveWorkflow(wf);
        return res.status(400).json({
          error: `Planning blocked — missing input artifacts:\n${missing}\n\n${taskPlan.message || 'Fix the missing artifacts and relaunch the planning step.'}`,
          validationFailure: taskPlan,
        });
      }

      // Detect prose validation failures (planner didn't use JSON format)
      if (!taskPlan || !taskPlan.tasks || taskPlan.tasks.length === 0) {
        const fbLower = plannerFeedback.toLowerCase();
        const isValidationFailure = /validation[:\s]*(failed|fail)\b/i.test(plannerFeedback)
          || (/\bfail\b.*\bmissing\b|\bmissing\b.*\bfail\b/i.test(plannerFeedback) && /\b(companion|design|spec|artifact|\.pen)\b/i.test(plannerFeedback));

        if (isValidationFailure) {
          // Extract FAIL lines from the feedback for a useful summary
          const failLines = plannerFeedback.split('\n')
            .filter(l => /FAIL|missing|does not exist/i.test(l))
            .map(l => l.replace(/^\s*[|*-]+\s*/, '').trim())
            .filter(Boolean)
            .slice(0, 10);
          const summary = failLines.length > 0 ? failLines.join('\n') : 'See planner feedback for details.';

          wf.steps.planning.status = 'blocked';
          wf.steps.planning.validationFailure = {
            validation: 'failed',
            message: summary,
            missing: [],
          };
          state.saveWorkflow(wf);
          return res.status(400).json({
            error: `Planning blocked — input validation failed:\n${summary}\n\nFix the missing artifacts and relaunch the planning step.`,
            validationFailure: wf.steps.planning.validationFailure,
          });
        }

        // Genuinely unparseable — log the feedback for debugging
        console.warn(`[workflow] Failed to parse planner output (${plannerFeedback.length} chars). First 500 chars:\n${plannerFeedback.slice(0, 500)}`);
        return res.status(400).json({ error: 'No valid task plan found in planner feedback. The planner must output a ```json code block with a tasks array, or a numbered task list under role headers. Relaunch the planning step.' });
      }

      // --- Hard ceiling on task count ---
      // The dominant over-decomposition pattern in iOS work is creating a
      // separate task per AC's XCUITest. PRD-008 produced 43 tasks (14 of
      // them one-test-per-AC) while a comparable web PRD lands at 10-15.
      // Tests belong inside their implementation task, not in a downstream
      // "test phase". Cap at 25 to force bundling; configurable via
      // `max_tasks_per_plan` in config.yaml if a specific project needs more.
      const maxTasksPerPlan = (config && Number(config.max_tasks_per_plan)) || 25;
      if ((taskPlan.tasks || []).length > maxTasksPerPlan) {
        const n = taskPlan.tasks.length;
        const msg = `Plan rejected — ${n} tasks exceeds ceiling of ${maxTasksPerPlan}. Most common cause: separate test-writing tasks for each AC. Tests for a given surface belong INSIDE the task that implements the surface, not as standalone tasks afterward. Re-run planner with explicit instruction: "Merge each XCUITest-writing task into the task that implements the corresponding view/screen/flow." If the merged plan still exceeds ${maxTasksPerPlan}, the PRD is too large for one workflow — split it.`;
        wf.steps.planning.status = 'blocked';
        wf.steps.planning.validationFailure = {
          validation: 'failed',
          message: msg,
          missing: [{ type: 'task-count-ceiling', description: `${n} tasks > ${maxTasksPerPlan} ceiling` }],
        };
        state.saveWorkflow(wf);
        return res.status(400).json({ error: msg, validationFailure: wf.steps.planning.validationFailure });
      }

      // --- G1: Anti-pattern rejection ---
      // Catches the slow-task classes that historically destroyed overnight
      // runtime (PRD-008's t36 "Full XCUITest suite first green pass" = 190
      // min, t37 "Flake check 3x consecutive" = 168 min). The planner
      // instruction tells agents to avoid these, but planners running with
      // stale instructions (from before the prompt was updated, or in
      // re-plans) ignore it. Backend-side gate is the only enforcement.
      //
      // Failure-mode: planner runs full xcodebuild scheme as a dedicated
      // omnibus task. Each full run is 25-35 min on example-ios. Bundling N runs
      // into one task multiplies the floor — and on iteration (any failure
      // restarts the whole task) the floor compounds. Tests must run as
      // part of implementation tasks, not as standalone N-run tasks.
      const TASK_ANTI_PATTERNS = [
        { re: /\b\d+\s*[x×]\s*consecutive\s+(?:full\s+)?(?:xcui)?test/i,
          why: 'Nx consecutive full-suite test runs (each run is 25-35 min; qa_validation will run the suite anyway)' },
        { re: /\bflake\s+check\b.*\b[2-9]\s*[x×]/i,
          why: 'flake check with N≥2 runs (single run + XCTSkipIf for known flakes is faster; qa_validation runs the suite)' },
        { re: /\bfull\s+xcuitest\s+suite\b.*\b(first\s+green|all\s+green)/i,
          why: 'first-green omnibus task (qa_validation runs the full suite — this task duplicates it)' },
        { re: /\brun\s+the\s+full\s+(?:xcui)?test\s+suite\b/i,
          why: 'full-suite run as standalone task (qa_validation runs the full suite — this task duplicates it)' },
        // Duplicates of qa_validation downstream work — added 2026-05-22 after PRD-008 plan
        // produced t39/t40/t41 (regression smokes), t42 (PR evidence screenshots), all of
        // which qa_validation already does. ~8-10 hours wasted per PRD by these duplicates.
        { re: /\bregression\s+smoke\b/i,
          why: 'regression smoke as standalone task (qa_validation runs the full suite which covers all prior PRD tests; the workflow auto-scopes via test-impact analysis)' },
        { re: /\bregression\s+(?:check|verification)\s+(?:for|of|across)\s+(?:prd|prior|previous)/i,
          why: 'cross-PRD regression task (qa_validation runs the full suite, covering all prior tests)' },
        { re: /\bverify\s+(?:nothing|that\s+nothing)\s+broke\b/i,
          why: '"verify nothing broke" task (qa_validation runs the full suite — that IS verifying nothing broke)' },
        { re: /\b(?:pr|visual)\s+evidence\b.*\bscreenshot\b.*\b(capture|all|comprehensive|exhaustive)/i,
          why: 'visual evidence / screenshot capture omnibus task (qa_validation captures visual smoke to docs/pr-evidence/<PRD>/visual/, the same directory the AC verifier reads from)' },
        { re: /\bvisual\s+conformance\s+screenshots?\b/i,
          why: 'visual conformance screenshots as task (qa_validation captures these as part of its visual smoke)' },
        { re: /\bswiftlint\s*(?:\+|\s+and\s+|\s*&\s*)?\s*(?:static\s+analyz(?:er|e))/i,
          why: 'SwiftLint + analyzer as a standalone task (fold lint checks into the implementation tasks that touch the code — each commit should pass lint)' },
      ];
      const offenders = [];
      for (const t of taskPlan.tasks || []) {
        const haystack = `${t.name || ''} ${t.description || ''}`;
        for (const pat of TASK_ANTI_PATTERNS) {
          if (pat.re.test(haystack)) {
            offenders.push({ name: t.name || `Task ${t.id}`, why: pat.why });
            break;
          }
        }
      }
      if (offenders.length > 0) {
        const offenderList = offenders.map(o => `  • "${o.name}" — ${o.why}`).join('\n');
        const msg = `Plan rejected — ${offenders.length} anti-pattern task(s) detected:\n${offenderList}\n\nFix: re-run planner with explicit instruction "tests run as part of implementation tasks, not as standalone N-run tasks". The planner should split each \`first-green\` / \`Nx flake check\` omnibus into per-AC implementation tasks where each task runs ONLY the tests it touches.`;
        wf.steps.planning.status = 'blocked';
        wf.steps.planning.validationFailure = {
          validation: 'failed',
          message: msg,
          missing: offenders.map(o => ({ type: 'anti-pattern', description: `${o.name}: ${o.why}` })),
        };
        state.saveWorkflow(wf);
        return res.status(400).json({ error: msg, validationFailure: wf.steps.planning.validationFailure });
      }

      // --- Normalize task field names ---
      // Planners emit varying shapes: `title` vs `name`, `role` (singular string)
      // vs `roles` (plural array), `acceptance_criteria` vs `acs_covered`. The
      // launcher and the hub UI both read the canonical shape (`name`, `roles`,
      // `acs_covered`). Normalize once here so neither consumer needs to handle
      // both shapes. Caught 2026-05-22 (PRD-009): UI showed no avatar/name + all
      // 16 tasks silently skipped because launcher read `task.roles` while the
      // plan only had `task.role`.
      for (const t of (taskPlan.tasks || [])) {
        if (!t.name && t.title) t.name = t.title;
        if (!(Array.isArray(t.roles) && t.roles.length > 0)) {
          t.roles = t.role ? [t.role] : [];
        }
        if (!Array.isArray(t.acs_covered) || t.acs_covered.length === 0) {
          t.acs_covered = Array.isArray(t.acceptance_criteria) ? t.acceptance_criteria
            : (t.acceptance_criteria ? [t.acceptance_criteria] : []);
        }
      }

      wf.steps.planning.status = 'completed';
      wf.taskPlan = taskPlan;
      wf.currentTaskIndex = 0;
      wf.currentStep = 'task_execution';
      if (!wf.steps.task_execution) wf.steps.task_execution = { status: 'pending', agents: [], completedTasks: [] };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    // --- Sequential task execution ---
    if (wf.currentStep === 'task_execution') {
      const taskPlan = wf.taskPlan;
      if (!taskPlan || !taskPlan.tasks) {
        return res.status(400).json({ error: 'No task plan found. Run the planning step first.' });
      }

      if (action === 'launch') {
        if (!wf.taskExecution) initTaskExecution(wf);
        if (!wf.steps.task_execution) wf.steps.task_execution = { status: 'pending', agents: [], completedTasks: [] };
        // Guard: don't launch if a task is already running
        if (wf.taskExecution) {
          const hasRunning = Object.values(wf.taskExecution.taskStates).some(ts => ts.status === 'running' || ts.status === 'reviewing' || ts.status === 'fixing');
          if (hasRunning) {
            return res.json({ workflow: wf });
          }
        }
        wf.steps.task_execution.status = 'running';
        launchNextTask(wf);
        state.saveWorkflow(wf);
        return res.json({ workflow: wf });
      }

      // Relaunch a single stuck/errored task agent without resetting the whole step
      if (action === 'relaunch_task' && body.taskIndex !== undefined) {
        const tex = wf.taskExecution;
        const tIdx = Number(body.taskIndex);
        const ts = tex?.taskStates[String(tIdx)];
        if (!ts) return res.status(400).json({ error: `Task ${tIdx} not found` });
        const phase = ts.status;
        if (!['running', 'error', 'pending'].includes(phase)) {
          return res.status(400).json({ error: `Task ${tIdx} is not in a relaunchable phase (${phase})` });
        }

        // Kill stuck tmux windows for this task
        for (const a of (ts.agents || [])) {
          if (a.window) {
            const target = `${wf.sessionName}:${a.window}`;
            try { tmuxOps.killWindowAndChildren(target); } catch (_) {}
          }
        }

        ts.agents = [];
        ts.status = 'pending';
        ts.startedAt = null;
        ts.completedAt = null;
        launchTaskImpl(wf, tIdx);
        updateStepAgents(wf);
        state.saveWorkflow(wf);
        return res.json({ workflow: wf });
      }

      // Skip a blocked/errored task (user-initiated rescue)
      if (action === 'skip_blocked' && body.taskIndex !== undefined) {
        const tex = wf.taskExecution;
        const tIdx = Number(body.taskIndex);
        const ts = tex?.taskStates[String(tIdx)];
        if (!ts || !['blocked', 'error'].includes(ts.status)) {
          return res.status(400).json({ error: `Task ${tIdx} is not blocked or errored` });
        }
        ts.status = 'done';
        ts.completedAt = ts.completedAt || new Date().toISOString();
        updateStepAgents(wf);
        state.saveWorkflow(wf);
        launchNextTask(wf);
        return res.json({ workflow: wf });
      }
    }

    // API contract step — Architect defines API contracts before frontend/backend implement in parallel
    if (wf.currentStep === 'api_contract' && wf.steps.api_contract.status === 'pending') {
      const archRole = require('../config').findRole(config, 'Architect');
      if (!archRole) {
        wf.steps.api_contract.status = 'skipped';
        wf.currentStep = 'implementation';
        state.saveWorkflow(wf);
        return res.json({ workflow: wf, needsAdvance: true });
      }
      const contractAgent = [{
        role: 'Architect', window: 'api-contract', status: 'pending', reportFeedback: true,
        instruction: `You are the Architect. Define API contracts for this PRD before implementation begins.\n\nPRD path: ${wf.prdPath}\nRead the PRD and existing ADRs in docs/adrs/. Produce API contract definitions (endpoints, request/response shapes, error codes) that both Frontend and Backend developers will implement against.\n\nWrite the contract to docs/adrs/ or alongside the PRD as appropriate. If the PRD has no API surface (e.g. pure frontend or config change), report "SKIP — no API contract needed."\n\nUse the /${archRole.skill} skill. Commit your changes. ${COMMIT_ON_CURRENT_BRANCH}`,
      }];
      wf.steps.api_contract = { status: 'running', agents: launchWorkflowAgents(wf, contractAgent, { useWorktrees: false }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'api_contract' && (action === 'approve' || action === 'skip')) {
      wf.steps.api_contract.status = action === 'skip' ? 'skipped' : 'completed';
      wf.currentStep = 'implementation';

      // Collect design/companion spec context from the PRD's Companion Specs
      // section for frontend devs (heading matched by NAME — section numbers
      // drift per project; legacy §10 anchor kept as fallback).
      let designFiles = [];
      let companionSpecs = [];
      try {
        const prdContent = fs.readFileSync(path.join(docsPath, wf.prdPath || ''), 'utf8');
        let section10Match = prdContent.match(/^##\s+[^\n]*\bcompanion\s+specs?\b[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/im);
        if (!section10Match) section10Match = prdContent.match(/## §?10[.\s].*?\n([\s\S]*?)(?=\n## §?\d|$)/);
        if (section10Match) {
          for (const line of section10Match[1].split('\n')) {
            if (/\|\s*Done\s*\|/i.test(line)) {
              const cells = line.split('|').map(c => c.trim()).filter(c => c);
              if (cells.length >= 3) {
                const desc = cells[0];
                const filePath = cells[cells.length - 1];
                companionSpecs.push({ desc, path: filePath });
                if (/\.pen\b|pencil|visual design|design spec/i.test(desc)) {
                  designFiles.push(filePath);
                }
              }
            }
          }
        }
      } catch {}

      const hasDesign = designFiles.length > 0;
      const companionList = companionSpecs.map(s => `- ${s.desc}: \`${s.path}\``).join('\n');

      const devAgents = (config.roles.execution || []).map(r => {
        const isFrontend = r.role.toLowerCase().includes('frontend');
        let designContext = '';

        if (isFrontend) {
          // Always include companion specs reference
          if (companionSpecs.length > 0) {
            designContext += `\n\n## COMPANION SPECS — READ BEFORE IMPLEMENTING\n\nThe following companion specs were written during the review flow. Read them all:\n${companionList}`;
          }

          // If Pencil design files exist, add design enforcement
          if (hasDesign) {
            const pwCli = config.features && config.features.playwright_cli;
            const screenshotInstr = pwCli
              ? `\n2. **Screenshot your implementation** with playwright-cli:\n\`\`\`bash\nplaywright-cli open http://localhost:${config.port || 3000}/<path>\nplaywright-cli resize 1440 900\nplaywright-cli screenshot --filename /tmp/impl.png --full-page\nplaywright-cli close\n\`\`\``
              : `\n2. **Screenshot your implementation**: Use Playwright at the same viewport:\n\`\`\`bash\nnpx playwright screenshot --viewport-size=1440,900 http://localhost:<port>/<path> /tmp/impl.png\n\`\`\``;
            designContext += `\n\n## VISUAL DESIGN — MANDATORY\n\nA Pencil visual design was created and approved by the project owner. You MUST follow it exactly.\n\nDesign files:\n${designFiles.map(f => '- `' + f + '`').join('\n')}\n\n### PENCIL MCP — CHECK BEFORE READING .pen FILES\nBefore reading any .pen design file, call \`get_editor_state\` to verify the Pencil MCP is available.\nIf the call fails (tool not found, connection refused, timeout), **STOP IMMEDIATELY**.\nDo NOT skip design verification. Do NOT proceed without reading the design.\nReport in your feedback: "BLOCKED: Pencil MCP unavailable — please start the Pencil app and re-run this step."\n\n### Rules:\n1. **Open and read the .pen design file** using the Pencil MCP tools (get_editor_state, batch_get) BEFORE writing any code\n2. **Match the design pixel-for-pixel** — colors, spacing, typography, layout, component structure\n3. **Do not invent your own visual style** — the Pencil design is the approved visual spec\n4. **If the design conflicts with the PRD**, follow the design (it was approved after the PRD)\n\n## SELF-VERIFICATION WITH HEATMAP — REQUIRED BEFORE REPORTING DONE\n\nYou MUST verify your implementation against the design before committing.\n\n1. **Export the design**: Use Pencil MCP \`export_nodes\` to export the design frame as PNG at 2x scale to \`/tmp/design.png\`${screenshotInstr}\n3. **Run the heatmap diff** (see docs/wow/web-design-workflow.md for the script)\n4. **If match < 85%**: Fix the top discrepancies and re-run\n5. **If match >= 85%**: Commit and report the match percentage in your feedback`;
          }
        }

        return {
          role: r.role, branch: `${r.branch_prefix}-${prdId}`, window: r.role.toLowerCase().replace(/\s+/g, '-').slice(0, 15),
          status: 'pending', reportFeedback: true,
          instruction: `You are a ${r.role}. Read your role definition at .claude/commands/${r.command} first.\n\nImplement the changes for this PRD.\n\nPRD path: ${wf.prdPath}\nUse the /${r.skill} skill. Read the PRD and implement. Commit your changes.${designContext}`,
        };
      });
      wf.steps.implementation = { status: 'running', agents: launchWorkflowAgents(wf, devAgents, { useWorktrees: true }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'implementation' && action === 'approve') {
      wf.steps.implementation.status = 'completed';
      wf.currentStep = 'merge_for_review';
      state.saveWorkflow(wf);
      return mergeDevBranches(wf, res);
    }

    if (wf.currentStep === 'merge_for_review' && action === 'retry') {
      return mergeDevBranches(wf, res);
    }

    if (wf.currentStep === 'code_review' && (action === 'launch' || (!action && wf.steps.code_review.status === 'pending'))) {
      const crAgent = [{
        role: 'Code Reviewer', window: 'code-review', status: 'pending', reportFeedback: true,
        instruction: (() => {
          // Build context about what triggered this review round
          const prevFixStep = wf.steps.fix_execution || wf.steps.fix_review || wf.steps.fix_qa || wf.steps.fix_security;
          const prevQA = wf.steps.qa_validation;
          const prevSecurity = wf.steps.security_audit;
          let reviewContext = '';
          if (wf.round > 1 && prevFixStep) {
            // Sequential fix execution stores completed task feedback in completedTasks[].agentFeedback,
            // not in .agents (which is cleared after each task). Read from both sources to be safe.
            const completedTaskFeedback = (prevFixStep.completedTasks || [])
              .flatMap(t => t.agentFeedback || [])
              .filter(a => a.feedback)
              .map(a => `${a.role}: ${a.feedback}`)
              .join('\n\n');
            const agentFeedback = (prevFixStep.agents || []).filter(a => a.feedback).map(a => `${a.role}: ${a.feedback}`).join('\n\n');
            const fixFeedback = completedTaskFeedback || agentFeedback;
            reviewContext = `\n\n## THIS IS A RE-REVIEW (Round ${wf.round})\nFocus on verifying the fixes from the previous round. Do not re-raise issues that were already fixed.\n\n### Previous fix reports:\n${fixFeedback}`;
            if (prevQA && prevQA.agents) {
              const qaFb = prevQA.agents.filter(a => a.feedback).map(a => a.feedback).join('\n');
              if (qaFb) reviewContext += `\n\n### QA issues that prompted the fixes:\n${qaFb}`;
            }
            if (prevSecurity && prevSecurity.agents) {
              const secFb = prevSecurity.agents.filter(a => a.feedback).map(a => a.feedback).join('\n');
              if (secFb) reviewContext += `\n\n### Security issues that prompted the fixes:\n${secFb}`;
            }
          }
          // Add design conformance check if a Pencil design file exists in the
          // Companion Specs section (heading matched by NAME; legacy §10 fallback)
          let designCheck = '';
          try {
            const prdContent = fs.readFileSync(path.join(docsPath, wf.prdPath || ''), 'utf8');
            let section10Match = prdContent.match(/^##\s+[^\n]*\bcompanion\s+specs?\b[^\n]*\n([\s\S]*?)(?=\n## |(?![\s\S]))/im);
            if (!section10Match) section10Match = prdContent.match(/## §?10[.\s].*?\n([\s\S]*?)(?=\n## §?\d|$)/);
            if (section10Match) {
              const penFiles = [];
              for (const line of section10Match[1].split('\n')) {
                if (/\|\s*Done\s*\|/i.test(line) && /\.pen\b|pencil|visual design/i.test(line)) {
                  const cells = line.split('|').map(c => c.trim()).filter(c => c);
                  if (cells.length >= 3) penFiles.push(cells[cells.length - 1]);
                }
              }
              if (penFiles.length > 0) {
                designCheck = `\n6. **DESIGN CONFORMANCE** — A Pencil visual design was approved for this PRD (${penFiles.join(', ')}). Verify that frontend code matches the approved design. Check: colors, spacing, typography, layout, component structure. If the implementation deviates from the design without justification, mark it BLOCKING.`;
              }
            }
          } catch {}

          if (wf.round > 1 && reviewContext) {
            // Re-review: targeted single-pass, no parallel sub-agents
            return `## YOU ARE A CODE REVIEWER — NOT A FIX AGENT — READ THIS FIRST\n\n**Your job is to review code changes and report findings. You do NOT write code. You do NOT fix bugs. You do NOT modify files. You read the diff, identify issues, and submit a structured review.**\n\n**FORBIDDEN FEEDBACK FORMAT** — your feedback will be REJECTED if you use any of these patterns (FIX-REPORT format used by Dev agents — wrong for reviewers):\n- \`**All issues addressed:** yes|no\` / \`**Committed:** <hash>\` / \`### Changes\` listing files you modified\n- Any phrasing that implies you made code changes\n\n**REQUIRED FEEDBACK FORMAT** — your feedback MUST contain:\n- \`**Approved:** yes | no\`\n- \`**Blocking:** N  |  **Medium:** N  |  **Low:** N\`\n- \`### Summary\`, \`### Findings\`, \`### Action Items\` sections\n\n**IF YOU SEE A BUG:** REPORT it as a finding with severity (BLOCKING / MEDIUM / LOW) and an Action Item naming the role responsible. DO NOT fix it yourself.\n\n---\n\nYou are a Code Reviewer doing a targeted re-review.\n\nDo NOT use the /code-review skill and do NOT launch parallel sub-agents. Do a single-pass focused review.\n\nPRD path: ${wf.prdPath}\n${reviewContext}\n\n## YOUR TASK\nVerify that each fix listed above actually resolves the issue it claims to fix. Read the relevant changed files directly. Check for regressions introduced by the fixes. Do not re-audit code that was already approved in round 1.\n\n## OUTPUT FORMAT (machine-parsed — use exactly)\n\n## Review: Code Reviewer\n\n**Approved:** yes | no\n**Blocking:** N  |  **Medium:** N  |  **Low:** N\n\n### Summary\n[1-3 sentences]\n\n### Findings\n[Only issues with the fixes. If fixes are clean, say "All blocking issues from round 1 are resolved."]\n\n### Action Items\n- [ ] [role] — description`;
          }
          return `## YOU ARE A CODE REVIEWER — NOT A FIX AGENT — READ THIS FIRST\n\n**Your job is to review code changes and report findings. You do NOT write code. You do NOT fix bugs. You do NOT modify files. You read the diff, identify issues, and submit a structured review.**\n\n**FORBIDDEN FEEDBACK FORMAT** — your feedback will be REJECTED if you use any of these patterns (FIX-REPORT format used by Dev agents — wrong for reviewers):\n- \`**All issues addressed:** yes|no\` / \`**Committed:** <hash>\` / \`### Changes\` listing files you modified\n- Any phrasing that implies you made code changes\n\n**REQUIRED FEEDBACK FORMAT** — your feedback MUST contain:\n- \`**Approved:** yes | no\`\n- \`**Blocking:** N  |  **Medium:** N  |  **Low:** N\`\n- \`### Summary\`, \`### Findings\`, \`### Action Items\` sections\n\n**IF YOU SEE A BUG:** REPORT it as a finding with severity (BLOCKING / MEDIUM / LOW) and an Action Item naming the role responsible. DO NOT fix it yourself. The fix happens in a separate fix_execution step by Dev agents.\n\n---\n\nYou are a Code Reviewer. Review the code changes in this branch.\n\nPRD path: ${wf.prdPath}\nUse the /code-review skill at ${(config.code_review && config.code_review.effort) || 'high'} effort — a multi-angle, recall-biased pass: surface every plausible issue then verify, don't stop at the first few. Review all changes, check for quality, correctness, and adherence to project standards.\n\n## REVIEW SCOPE RULES\n1. **Only review code changes in this branch** — do not review pre-existing code or suggest refactors outside the PRD scope.\n2. **Check the PRD's "Out of scope" section** — do not raise issues about excluded items.\n3. **Classify findings** as BLOCKING or NON-BLOCKING. Be conservative with BLOCKING.\n4. **If code is correct, say "APPROVE."** Do not invent concerns.\n5. **Use the structured review format** from CLAUDE.md.${designCheck}\n7. **ACCEPTANCE CRITERIA COVERAGE** — Read the PRD and verify that EVERY acceptance criterion has corresponding code changes. If an AC has no implementation at all, mark it BLOCKING. Include an "AC Coverage" section in your review listing each AC and whether it's covered by the code changes.\n8. **MOCK-ONLY COVERAGE** — Check if any acceptance criteria that depend on external services (LLM calls, third-party APIs, hardware) are only tested with mocked responses. Flag these as "MOCK-ONLY — real integration unverified" in your review so they are flagged for manual testing during demo review. Not all projects use mocks — only flag this when the project's tests actually mock external dependencies.\n9. **MULTI-ANGLE RECALL** — cover these angles explicitly (each has shipped real merged defects): (a) correctness across ALL entity/type variants the spec covers and BOTH directions of every toggle — not just the path the implementation took; (b) silent fail-safe drops (returns 200 while quietly discarding an invalid field); (c) removed or weakened prior behavior; (d) cross-file / contract drift; (e) altitude — a third copy of logic that will drift; (f) dead / unused error contracts; (g) test scaffolding leaked into production (env hooks, ungated test seams).\n\nThis is round ${wf.round}.${reviewContext}`;
        })(),
      }];
      wf.steps.code_review = { status: 'running', agents: launchWorkflowAgents(wf, crAgent, { useWorktrees: false, cwd: projectRoot }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'code_review' && action === 'approve') {
      wf.steps.code_review.status = 'completed';
      // Bugfix runs code_review AFTER qa_validation, as the last gate before the
      // merge — advance FORWARD in its own sequence (→ merge_to_main), never back
      // into the execution review→qa fix loop below. When config.bugfix.auto_merge
      // is true, proceed straight into the merge via the same code path the manual
      // merge action runs (on any gate failure it surfaces the error identically);
      // default false stops at the manual merge_to_main gate, exactly like execution.
      if (wf.type === 'bugfix') {
        const next = nextStepInSequence(wf, config, 'code_review') || 'merge_to_main';
        wf.currentStep = next;
        if (!wf.steps[next]) wf.steps[next] = { status: 'pending' };
        if (next === 'merge_to_main' && config.bugfix && config.bugfix.auto_merge === true) {
          state.saveWorkflow(wf);
          return handleExecutionAdvance(wf, action, notes, res, body);
        }
        state.saveWorkflow(wf);
        return res.json({ workflow: wf, needsAdvance: true });
      }
      // Route to the coverage_matrix critic when the project's flow includes it
      // (web-app / api-only / mobile-app); otherwise fall straight through to QA.
      const crExecSteps = (config.workflow && config.workflow.execution) || [];
      if (crExecSteps.includes('coverage_matrix')) {
        wf.currentStep = 'coverage_matrix';
        wf.steps.coverage_matrix = { status: 'pending', agents: [] }; // reset for re-run after fix loop
        state.saveWorkflow(wf);
        return res.json({ workflow: wf, needsAdvance: true });
      }
      wf.currentStep = 'qa_validation';
      wf.steps.qa_validation = { status: 'pending', agents: [] }; // reset for re-run after fix loop
      // Fall through to launch QA
    }

    // ─── Coverage-matrix critic (ADVISORY — post-implementation backstop) ─────
    // The full spec-derived AC×variant matrix is now enumerated and tested up
    // front at qa_tests (no cap), so this step is advisory: it re-checks coverage
    // against the REAL implementation and surfaces residual gaps (variants the
    // impl introduced, silent-drop paths) as NON-BLOCKING notes. It is not in
    // reviewSteps/REVIEW_SOURCE_STEPS, so it always auto-approves and never spawns
    // a fix loop — that grind is what moved the enumeration up front to qa_tests.
    if (wf.currentStep === 'coverage_matrix' && (action === 'launch' || (!action && wf.steps.coverage_matrix.status === 'pending'))) {
      const cmVariants = config.coverage_matrix && config.coverage_matrix.variants;
      const variantSection = cmVariants
        ? `\n\n## PROJECT VARIANT TAXONOMY (authoritative — enumerate these axes for every AC they touch)\n${typeof cmVariants === 'string' ? cmVariants : JSON.stringify(cmVariants, null, 2)}`
        : '';
      const cmAgent = [{
        role: 'Coverage Critic', window: 'coverage', status: 'pending', reportFeedback: true,
        instruction: `## YOU ARE A COVERAGE CRITIC — ADVISORY POST-IMPLEMENTATION CHECK — READ THIS FIRST

**Your findings are ADVISORY: they are surfaced for the operator and later steps, but they do NOT block the merge or trigger a fix loop.** The full spec-derived acceptance-criteria × variant matrix was already enumerated and tested BEFORE implementation, at the qa_tests step (read its coverage matrix in the qa_tests feedback — those cells are covered by definition; do not re-flag them). Your job now is the residual pass against the REAL implementation — catch what a pre-implementation, spec-only enumeration cannot:

1. **Implementation-introduced variants** — a branch, type, state, or error path the CODE added that the spec did not name, and that therefore has no test.
2. **Silent fail-safe drops** — a code path that returns success (200 / no error) while quietly discarding an invalid field or skipping work, where the only covering test asserts the happy path.

You do NOT write code, write tests, run tests, or fix bugs. Read the qa_tests coverage matrix + the implementation diff + the test files, and report residual gaps.

PRD path: ${wf.prdPath}${variantSection}

## PROCESS

1. Read the qa_tests coverage matrix (in the qa_tests step feedback) — that is the already-covered cell set. Do NOT re-flag those cells.
2. Read the implementation diff. For each new branch / type / state / error path it introduces, check that a test exercises it.
3. Check every input-accepting path for silent drops (success returned while input is discarded) and confirm a negative/rejection test exists.
4. Report residual gaps only — anything already in the qa_tests matrix is covered.

## FEEDBACK FORMAT — MANDATORY (machine-parsed; ADVISORY, non-blocking)

**Approved:** yes | no
**Blocking:** N  |  **Medium:** N  |  **Low:** N

### Residual Coverage Gaps
| Source | Cell | Covered? | Note |
|--------|------|----------|------|
| impl-introduced | <branch/type/state> | NO | no test for the code path added at <file:line> |
| silent-drop | <input field> | NO | handler returns success while dropping it; no rejection test |

### Summary
[Residual gaps beyond the qa_tests matrix, or "none — implementation matches the pre-enumerated matrix." Advisory; name the highest-risk one for the operator.]

### Action Items
- [ ] [QA] — add test: <cell> asserting <expected behavior / rejection>

Report honestly. Note: this step does NOT block — even Approved: no advances the workflow. The counts are recorded so the operator and final_review can weigh them.`,
      }];
      wf.steps.coverage_matrix = { status: 'running', agents: launchWorkflowAgents(wf, cmAgent, { useWorktrees: false, cwd: projectRoot }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'coverage_matrix' && action === 'approve') {
      wf.steps.coverage_matrix.status = 'completed';
      wf.currentStep = 'qa_validation';
      wf.steps.qa_validation = { status: 'pending', agents: [] }; // reset for re-run after fix loop
      // Fall through to launch QA
    }

    if (wf.currentStep === 'coverage_matrix' && action === 'send_to_devs') {
      const cmFeedback = (wf.steps.coverage_matrix.agents || []).filter(a => a.feedback).map(a => a.feedback).join('\n\n');
      launchFixPlan(wf, 'coverage_matrix', cmFeedback, notes, prdId);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'qa_validation' && (action === 'launch' || action === 'approve' && wf.steps.qa_validation.status === 'pending')) {
      startDevServers(wf, projectRoot);
      // Post-implementation test execution — use the standalone-category QA
      // (skill: qa) which loads the test-runner identity, NOT the
      // review-category one (skill: qa_review) which loads the testability-
      // review identity and pulls the agent into methodology critique mode.
      // Mobile-app preset defines both; without category preference we'd hit
      // the review one first and the agent would do spec review instead of
      // running xcodebuild — the root cause of the recurring "QA stalled
      // doing methodology review" failure on example-ios.
      const qaRole = require('../config').findRole(config, 'QA', 'standalone');
      const skill = qaRole ? qaRole.skill : 'qa';
      // Build dev server port info for QA
      const ports = wf.devServerPorts || {};
      const frontendPort = ports.frontend || 5173;
      const backendPort = ports.backend || 4000;
      const frontendUrl = `http://localhost:${frontendPort}`;
      const backendUrl = `http://localhost:${backendPort}`;
      const portInfo = Object.entries(ports).map(([name, port]) => `${name}: http://localhost:${port}`).join(', ') || 'default ports';
      const preTestCmd = config.pre_test_command || '';
      const preTestSection = preTestCmd ? `\n\n## PRE-TEST SETUP\n\nRun this command FIRST before any tests:\n\`\`\`\n${preTestCmd}\n\`\`\`\nThis ensures test dependencies (browsers, tools) are available in the worktree.` : '\n\n## PRE-TEST SETUP\n\nBefore running E2E tests, ensure Playwright browsers are installed in the worktree:\n```\nnpx playwright install chromium\n```';
      // Extract test file list from qa_tests feedback to focus validation
      const qaTestFeedback2 = (wf.steps.qa_tests?.agents || []).map(a => a.feedback || '').join('\n');
      const testFileMatches2 = qaTestFeedback2.match(/`([^`]+\.test\.[^`]+)`/g) || [];
      const testFiles2 = testFileMatches2.map(m => m.replace(/`/g, ''));

      // Check if E2E tests were already run during task execution (e.g. a "verify E2E" task)
      const taskStates = wf.taskExecution?.taskStates || {};
      const taskE2EFeedback = Object.values(taskStates)
        .flatMap(ts => (ts.agents || []).filter(a => a.feedback))
        .filter(a => /e2e|playwright|\.spec\./i.test(a.instruction || '') || /e2e|playwright|\.spec\./i.test(a.feedback || ''))
        .map(a => a.feedback).join('\n');
      const e2eAlreadyRan = taskE2EFeedback.length > 200; // substantial E2E feedback exists

      const e2eInstruction = e2eAlreadyRan
        ? `\n\n**E2E tests were already run during task execution — do NOT re-run them.** The results are included below for reference. Only re-run E2E if the task execution report indicates they were NOT completed.\n\n### E2E results from task execution:\n${taskE2EFeedback.slice(0, 3000)}`
        : '\nThen run any E2E/Playwright .spec.* files written for this PRD.';

      const testFileList2 = testFiles2.length > 0
        ? `\n\n## TEST FILES TO RUN\nThese unit test files were written by the QA step for this PRD:\n${testFiles2.map(f => `- ${f}`).join('\n')}\n\nRun these FIRST. If they all pass, run the broader unit test suite (vitest/jest) to check for regressions.${e2eAlreadyRan ? '' : e2eInstruction}`
        : '';

      let qaRoundContext2 = '';
      if (wf.round > 1) {
        const prevFix = wf.steps.fix_execution || wf.steps.fix_plan;
        const fixFeedback = prevFix ? (prevFix.agents || []).filter(a => a.feedback).map(a => a.feedback).join('\n') : '';
        if (fixFeedback) qaRoundContext2 = `\n\n## THIS IS RE-VALIDATION (Round ${wf.round}) — RE-RUN, DO NOT RE-ANALYSE\n\n**You MUST re-execute the full test suite from scratch.** Do not cite round-${wf.round - 1} test results, do not "verify the fix reports against the spec", do not produce a methodology review. The fix-execution step claims the failures are resolved; your job is to PROVE that by re-running the tests and capturing fresh \`N passed / N failed\` output, plus re-doing the visual smoke and confirming the round-${wf.round - 1} runtime warnings (e.g. \`[Invalid Configuration]\`) are GONE on this round's launch.\n\nThe approval gate will reject feedback without fresh test-count output. The visual smoke from round ${wf.round - 1} is invalid — capture new screenshots and inspect for the same issues you flagged before.\n\n### Round ${wf.round - 1} fix reports (context only — do NOT trust them; verify by running tests):\n${fixFeedback}`;
      }

      // Check if PRD has visual designs and playwright-cli is enabled
      let qaVisualSection2 = '';
      const hasBrowserTesting2 = config.features && config.features.playwright_cli;
      if (hasBrowserTesting2) {
        try {
          const qaPrdContent2 = fs.readFileSync(path.join(docsPath, wf.prdPath || ''), 'utf8');
          const qaS10_2 = qaPrdContent2.match(/## 10[.\s].*?\n([\s\S]*?)(?=\n## \d|$)/);
          if (qaS10_2 && /\.pen\b|pencil|visual design/i.test(qaS10_2[1])) {
            qaVisualSection2 = `\n\n## VISUAL VERIFICATION — REQUIRED\nThis PRD has an approved Pencil design. After running tests, use the \`qa-browser-testing\` skill to screenshot key pages and verify visual correctness.\nUse \`playwright-cli\` to screenshot at desktop (1440×900) and mobile (390×844) viewports. Verify all key states: default, error, empty, loading.\nInclude screenshot paths in your feedback as evidence.\n\n### PENCIL MCP — CHECK FIRST\nIf you need to export or read .pen design files for heatmap comparison, first call \`get_editor_state\` to verify the Pencil MCP is available. If it fails, **STOP IMMEDIATELY** and report: "BLOCKED: Pencil MCP unavailable — please start the Pencil app and re-run this step." Do NOT skip visual verification.`;
          }
        } catch {}
      }
      const browserSkillRef2 = hasBrowserTesting2 ? ' Use the `qa-browser-testing` skill for any browser-based verification.' : '';

      // iOS-specific QA guidance — injected only when the project has a pinned
      // simulator destination (i.e. config.simulator.destination is set).
      // Captures the lessons from the example-ios PRD-009 QA stall (2026-05-23):
      // (a) agent spawned 3 duplicate xcodebuild processes because grep-piped
      //     output looked frozen; (b) name-based -destination lookup was brittle;
      //     (c) no parallel testing flag = 2x runtime; (d) Bash Monitors
      //     waiting on xcodebuild created the "no output, must be stuck" loop.
      // PRD-001 backlog: qa_validation.scope='new-uitests' narrows XCUITest to
      // only new/modified test files in this branch (full unit-test target still
      // runs). Regression XCUITests are run manually via Operations → UITests
      // tab before merge. Saves 20-40 min per QA round on iOS-sized projects.
      const qaScope = (config.qa_validation && config.qa_validation.scope) || 'full';
      // Parallel XCUITest cloning halves wallclock but, on some iOS-26 simulator
      // cohorts, the clones crash on boot (FBSOpenApplicationServiceError cascade),
      // making tests flaky and tripping the QA gate run after run. Let a project
      // dial it down: config.simulator.parallel_testing = false → serial (no clones,
      // no cascade); a number → capped worker count; unset/true → full parallel.
      const _pt = config.simulator && config.simulator.parallel_testing;
      const parallelFlag = _pt === false
        ? '-parallel-testing-enabled NO'
        : (typeof _pt === 'number' ? `-parallel-testing-enabled YES -parallel-testing-worker-count ${_pt}` : '-parallel-testing-enabled YES');
      let qaScopeSection = '';
      if (qaScope === 'new-uitests' && config.simulator && config.simulator.destination) {
        try {
          const { execFileSync } = require('child_process');
          const diff = execFileSync('git', ['diff', '--name-only', '--diff-filter=AM', 'main...HEAD'], { cwd: projectRoot, encoding: 'utf8' });
          const uitestFiles = diff.split('\n')
            .map(s => s.trim())
            .filter(f => /^ios\/.*UITests\/.*\.swift$/.test(f));
          const testClasses = uitestFiles.map(f => {
            const parts = f.split('/');
            const target = parts[parts.length - 2]; // e.g. "<Scheme>UITests"
            const cls = path.basename(f, '.swift');
            return `${target}/${cls}`;
          });
          // Identify the unit-test target from project config; fall back to the
          // <Scheme>Tests convention derived from config.simulator.scheme.
          const iosScheme = (config.simulator && config.simulator.scheme) || '<Scheme>';
          const iosProject = (config.simulator && config.simulator.project) || `ios/${iosScheme}.xcodeproj`;
          const unitTarget = (config.qa_validation && config.qa_validation.unit_test_target) || `${iosScheme}Tests`;
          const onlyTestingFlags = [`-only-testing:${unitTarget}`]
            .concat(testClasses.map(c => `-only-testing:${c}`))
            .map(s => `  ${s}`)
            .join(' \\\n');
          qaScopeSection = `\n\n## QA SCOPE — NEW UITests ONLY (qa_validation.scope=new-uitests)

Regression XCUITests take 20-40 min and aren't validating *this PRD's* surface — they're re-running unrelated tests that haven't changed. Skip them this round; the operator runs full regression manually via the **Operations → UITests** tab before pushing to remote.

This branch adds or modifies **${testClasses.length} XCUITest file(s)** (vs \`main\`):
${testClasses.length > 0 ? testClasses.map(c => '- `' + c + '`').join('\n') : '- _(none — only unit tests will run this round)_'}

**Use this scoped invocation INSTEAD of the broad command in §5:**

\`\`\`
xcodebuild test \\
  -project ${iosProject} \\
  -scheme ${iosScheme} \\
  -destination "$BUILD_STUDIO_SIMULATOR_DESTINATION" \\
  ${parallelFlag} \\
${onlyTestingFlags} \\
  2>&1 | tee /tmp/qa-test-output.log
\`\`\`

The first \`-only-testing:${unitTarget}\` flag scopes to all unit tests in the unit-test target; subsequent \`-only-testing:Target/Class\` flags scope XCUITest to just the new/modified classes. Any pre-existing XCUITest file unchanged in this branch is intentionally excluded — that coverage runs in the manual regression step.`;
        } catch (e) {
          console.warn('[workflow] qa_validation.scope=new-uitests: could not compute scoped tests:', e.message);
        }
      }

      const iosTestingSection = (config.simulator && config.simulator.destination)
        ? `\n\n## iOS-SPECIFIC PROTECTIONS — READ THIS BEFORE RUNNING xcodebuild

This is an iOS project. xcodebuild has gotchas that have stalled QA on this project before. Follow these:

1. **One xcodebuild at a time.** Before launching xcodebuild, check for an in-flight run: \`ps aux | grep "[x]codebuild test" | grep -v grep\`. If one is already running, DO NOT spawn another — the simulator handles one test session at a time. A second xcodebuild queues behind the first, doubling wallclock and creating zombies that need manual cleanup. Wait for the existing one to finish (poll its PID, don't spawn a Monitor that waits silently — see point 6).

2. **Use the pinned simulator destination.** The \`BUILD_STUDIO_SIMULATOR_DESTINATION\` env var holds the stable UDID set by the workflow. Always use \`-destination "$BUILD_STUDIO_SIMULATOR_DESTINATION"\`. Name-based lookup is brittle (the actual sim name has a locale suffix the workflow added).

3. **Parallel testing is configured per project — use the flag exactly as shown in the command below; do NOT add or change it.** Parallel cloning halves wallclock, but on some iOS-26 simulator cohorts the clones crash on boot (\`FBSOpenApplicationServiceError\` cascade) and make XCUITests flaky. So this project may run serially (\`-parallel-testing-enabled NO\`) or with a capped worker count — that is intentional. The command below already has the correct flag baked in.

4. **Tee output to a file — do NOT pipe through grep alone.** Piping xcodebuild through grep silently swallows progress lines, which is what makes runs LOOK stuck (this caused QA to spawn duplicate xcodebuild processes in prior runs). Always: \`2>&1 | tee /tmp/qa-test-output.log\`. After the run exits, grep the log: \`grep -E "Executed|FAILED|passed|failed" /tmp/qa-test-output.log | tail -20\`.

5. **Recommended invocation** (substitute your project's scheme + .xcodeproj — find with \`xcodebuild -list\` if unsure):
\`\`\`
xcodebuild test \\\\
  -project ios/<Scheme>.xcodeproj \\\\
  -scheme <Scheme> \\\\
  -destination "$BUILD_STUDIO_SIMULATOR_DESTINATION" \\\\
  ${parallelFlag} \\\\
  2>&1 | tee /tmp/qa-test-output.log
\`\`\`

6. **While xcodebuild runs, tail the log to confirm progress** — DO NOT spawn a Bash Monitor that waits silently. Periodic foreground tail: \`tail -5 /tmp/qa-test-output.log\` (run this every few minutes via the Bash tool). If you see Test Suite / Test Case / Executed lines being added, the run is progressing. If 10+ minutes pass with NO new log lines, the run is genuinely stuck — kill the PID (\`kill -9 <pid>\`) and report environment failure rather than spawning a duplicate. After any \`kill -9\`, run \`node "$XCTEST_CLEAN" --quiet\` to reap the orphaned clones.

7. **Clean up leaked simulator clones — pre AND post (and after any kill).** \`-parallel-testing-enabled YES\` clones the sim into a GLOBAL device set (\`~/Library/Developer/XCTestDevices\`) shared with every other project on this machine. Cancelled or force-killed runs orphan their clones, which accumulate and fill the boot drive (this folder hit 66 GB before the reaper existed). Run \`node "$XCTEST_CLEAN" --quiet\` BEFORE starting and AFTER finishing (success, failure, or kill). It deletes ONLY Shutdown + idle clones, so it is safe to run even while a DIFFERENT project is mid-test — a booted or freshly-created clone is never touched. **Do NOT** use \`xcrun simctl shutdown all\` or \`rm -rf ~/Library/Developer/XCTestDevices/*\` — those would destroy another project's in-flight test run.`
        : '';

      const qaAgent = [{
        role: 'QA', window: 'qa-validate', status: 'pending', reportFeedback: true,
        instruction: `## YOU ARE A TEST RUNNER — NOT A FIX AGENT — READ THIS FIRST

**You are QA. Your ONLY job is to run the test suite and report what happened. You do NOT write code. You do NOT fix bugs.**

**FORBIDDEN FEEDBACK FORMAT** — your feedback will be REJECTED if you use any of these patterns (these are FIX-REPORT formats from CLAUDE.md, used by iOS Dev agents in a different step — they are wrong for your role):
- \`**All issues addressed:** yes|no\`
- \`**Committed:** <hash>\`
- \`### Changes\` listing files you modified
- Any phrasing that implies you made code changes

**REQUIRED FEEDBACK FORMAT** — your feedback MUST contain ONE of these tokens or the approval gate rejects it:
- \`**Tests passed:** N/M\` (e.g. \`**Tests passed:** 232/232\`)
- \`N passed\` / \`N failed\` / \`N skipped\` from the test runner output
- The native \`Executed N tests, with M failures\` line

**IF YOU OBSERVE A DEFECT during testing:**
- REPORT it as a failure in your feedback. Include the failing test name + the exact output. Set \`**Approved:** no\` and \`**Blocking:** N\`.
- DO NOT fix it. DO NOT make code changes. DO NOT commit. Code fixes happen in fix_execution (a different step, by iOS Dev agents). Your role here is test execution and reporting only.

**IF YOU CANNOT RUN TESTS** (toolchain missing, environment broken, simulator unreachable):
- Report the EXACT command + exact error verbatim. Set \`**Approved:** no\`, explain the environmental block, and stop.
- DO NOT substitute static code review for a missing test run.

---

You are QA. **Your job is to RUN the test suite and report test outcomes — nothing else.**\n\nPRD path: ${wf.prdPath}\nUse the /${skill} skill.${browserSkillRef2}${testFileList2}${e2eAlreadyRan ? e2eInstruction : ''}${qaRoundContext2}\n\n## DO NOT DO THESE THINGS\n\n- **Do NOT review companion-spec methodology or quality.** That is a team_review concern. Your feedback must contain test results (e.g. \`N passed\`, \`M failed\`), not spec critique. The approval gate REJECTS feedback that lacks recognizable test output.\n- **Do NOT skip running tests in favor of static review.** If you cannot run the test command (missing toolchain, broken environment), report the exact failure verbatim and stop — do not substitute a spec review for missing test output.\n- **Do NOT pass \`-resultBundlePath\` to xcodebuild.** It routes output to the .xcresult bundle instead of stdout, making the test counts invisible to you and to the approval gate. Default stdout reporting is what the gate parses.\n\n## DEV SERVER PORTS\n\nWorktree dev servers are already running on offset ports:\n${portInfo}\n\nFrontend: ${frontendUrl}\nBackend:  ${backendUrl}${preTestSection}${iosTestingSection}${qaScopeSection}\n\n## VALIDATION STEPS — RUN IN ORDER\n\n**Do NOT read companion-spec files (docs/qa/*.md, docs/adrs/*.md, docs/ux/*.md, etc.) at all in this step.** They were already validated in the companion_specs step before execution started. Reading them is what causes you to drift into methodology review instead of running tests. If you find yourself opening a spec file, STOP and run tests instead.\n\n1. **Run the test suite FIRST.** Use the project's native test command:\n   - JS/TS projects: \`npx vitest run\` or \`npm test\`, plus Playwright (\`npx playwright test\`) for E2E\n   - iOS/Swift projects: \`xcodebuild test -scheme <SchemeName> -destination 'platform=iOS Simulator,name=iPhone 15'\` (or the equivalent for the project's scheme)\n   - Android/Kotlin projects: \`./gradlew test\` (unit) and \`./gradlew connectedAndroidTest\` (instrumented)\n2. **Report ALL test counts** in the format the approval gate expects: include at least one of \`**Tests passed:** N/M\`, \`N passed\`, \`N failed\`, or the native runner's "Executed N tests, with M failures" line. Without this, the gate will reject your feedback.\n3. ${e2eAlreadyRan ? 'E2E tests were already run during task execution (see results above) — skip unless re-run is needed' : 'Run any E2E/Playwright .spec.* files written for this PRD'}\n4. **Visual smoke — REQUIRED for visual PRDs** (see your /${skill} role's "Visual smoke" section for the full protocol).\n   - If this PRD ships any visible UI surface, capture simulator/device screenshots of every AC surface and inspect for: fallback colors (e.g. system-blue tab tint, system-gray text), missing UI elements (gear icons rendering as blurred backgrounds, empty MetricRow cards, missing empty-state copy), letterbox / safe-area breaks, layout regressions vs the design bundle reference at \`design-system/project/<screen>.html\` if the project has one.\n   - Visual regressions are **BLOCKING** even if the XCUITest / Playwright suite is green. Accessibility queries return matches for invisible text — the visual smoke is the only check that catches "tests pass but the user sees a blank screen".\n   - Commit screenshots to \`docs/pr-evidence/<PRD-basename>/visual/\`. The AC verification gate will look for them; a missing directory blocks the AC verifier from marking visual ACs as MET.\n   - **Scope evidence to THIS PRD only.** Capture or regenerate evidence ONLY under \`docs/pr-evidence/<PRD-basename>/\`. Do NOT run other PRDs' screenshot/evidence-capture tests. If a test run leaves OTHER PRDs' committed evidence modified (PDFs/PNGs drift byte-wise even when visually identical), \`git checkout --\` those files before finishing — never commit cross-PRD evidence churn into this run.\n   - **Brand-token check (mechanical)**: for each visible color in your screenshots, confirm it appears in \`docs/brand/brand-guidelines.md\` or the project's locked palette. Any color NOT in the locked palette is a fallback render — BLOCKING (even if the asset catalog has the right hex values committed; namespace mismatches mean the production code reaches nil at runtime and tests don't catch it).\n5. **Runtime warnings are BLOCKING.** Scan the launch console output for warnings like \`[Invalid Configuration]\`, \`No color named\`, \`Could not load nib\`, asset-not-found patterns. Any such warning that fires on every app launch means the implementation has a structural bug that the test suite doesn't catch. Report as **Approved: no**, **Blocking: <n>**, NOT as a Medium finding.\n\n## TEST DATA CLEANUP — MANDATORY\nAfter ALL tests finish (pass or fail), delete every test record created during this run.\n- Test users (emails matching \`test-*@example.com\` or \`preflight@example.com\`)\n- Test events, sessions, and any other DB rows created by tests\n- Use the project's delete endpoints or direct DB queries\n- Verify cleanup: query the DB and confirm test records are gone\n- Report cleanup status in your feedback (e.g., "Cleaned up 12 test users, 3 test events")\nDo NOT leave test data behind — it accumulates across runs and pollutes the database.\n\n## IMPORTANT\n- If tests fail, report the EXACT failure output — do not summarize\n- Distinguish between PRD test failures (blocking) and pre-existing failures (non-blocking)\n- Do NOT fix code — only report what fails${qaVisualSection2}`,
      }];
      wf.steps.qa_validation = { status: 'running', agents: launchWorkflowAgents(wf, qaAgent, { useWorktrees: false, cwd: projectRoot }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'code_review' && action === 'send_to_devs') {
      const roundFeedback = (wf.steps.code_review.agents || []).filter(a => a.feedback).map(a => a.feedback).join('\n\n');
      launchFixPlan(wf, 'code_review', roundFeedback, notes, prdId);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'qa_validation' && action === 'approve') {
      // GATE: QA agent must have submitted feedback before approval is allowed
      const qaAgents = wf.steps.qa_validation.agents || [];
      const qaFeedback = qaAgents.map(a => a.feedback || '').join('\n');
      const agentsStillRunning = qaAgents.some(a => a.status === 'running' || a.status === 'pending');
      const qaStrict = (config.qa_validation && config.qa_validation.strict) !== false; // default true
      const operatorOverride = body.override === true;

      if (!qaFeedback.trim()) {
        return res.status(400).json({
          error: agentsStillRunning
            ? 'Cannot approve QA: the QA agent is still running. Wait for it to complete and submit feedback before approving.'
            : 'Cannot approve QA: no feedback received from the QA agent. Relaunch QA if the agent did not complete.',
        });
      }

      // GATE: Check that tests actually ran — "0 passed, 0 failed" means broken environment, not clean pass
      const passedMatch = qaFeedback.match(/\*\*Tests passed:\*\*\s*(\d+)\/(\d+)/i) || qaFeedback.match(/(\d+)\/(\d+)\s*pass/i) || qaFeedback.match(/(\d+)\s+passed/i);
      const totalTests = passedMatch ? parseInt(passedMatch[2] || passedMatch[1]) : -1;
      // Also check for explicit "0 passed" or reporter output like "0 passed (0s)"
      const zeroTests = /\b0 passed\b/i.test(qaFeedback) || /\b0\/0\b/.test(qaFeedback);

      if (totalTests === 0 || (totalTests === -1 && zeroTests)) {
        return res.status(400).json({
          error: 'Cannot approve QA: no tests were executed (0 passed, 0 failed). This usually means the test environment is broken (missing browsers, wrong ports, missing dependencies). Fix the environment and relaunch QA.',
          zeroTests: true,
        });
      }

      // GATE: Feedback must contain recognizable test output — reject if no test counts found at all
      // (catches cases like "environment setup failed" with no test runner output)
      if (totalTests === -1) {
        const hasTestOutput = /\d+\s+(passed|failed|skipped)/i.test(qaFeedback) ||
          /Tests?\s*(passed|failed|run)/i.test(qaFeedback) ||
          /\d+\s+test/i.test(qaFeedback) ||
          /PASS|FAIL/m.test(qaFeedback);
        if (!hasTestOutput) {
          return res.status(400).json({
            error: 'Cannot approve QA: feedback does not contain recognizable test results (e.g., "N passed", "N failed"). The QA agent may have failed before running tests. Check the agent output and relaunch QA.',
            noTestOutput: true,
          });
        }
      }

      // PRD-002: STRICT-MODE GATE — any failing tests block approval.
      // Owner's precondition (2026-05-25): `main` is kept clean (zero failing
      // tests). Therefore any failure in the review branch is, by definition,
      // a regression introduced by this PRD. Don't trust the agent's
      // "pre-existing failure" classification — the agent has no way to
      // verify it without rerunning on main, which we're not doing because
      // the precondition makes it unnecessary.
      //
      // Override: operator can pass `{"action":"approve","override":true}`
      // to ship anyway (e.g. known infra-level flakes). Override is logged.
      // Opt-in (per project): honor the QA agent's certified-clean verdict.
      // When qa_validation.honor_clean_approval is true AND the agent gave a
      // clean approval (Approved: yes + Blocking: 0 — i.e. it triaged every
      // failure as non-blocking: pre-existing / flaky / out-of-scope), the
      // strict gate treats the run as approvable without a manual override.
      // Mirrors the auto-advance tick's cleanApproval logic so the two agree
      // (they disagreeing is what stalled example-app — tick won't send-to-devs,
      // gate won't approve). Default OFF preserves strict's "operator must
      // consciously override any failure" behavior everywhere else.
      const honorCleanApproval = config.qa_validation && config.qa_validation.honor_clean_approval === true;
      const cleanApproval = /\*\*Approved:\*\*\s*yes\b/i.test(qaFeedback) && /\*\*Blocking:\*\*\s*0\b/i.test(qaFeedback);
      const strictBypass = operatorOverride || (honorCleanApproval && cleanApproval);
      if (qaStrict && !strictBypass) {
        // Negative lookbehind `(?<![\w-])` prevents a PRD number from being read
        // as a failure count: without it, "0 PRD-080 failures" matches "080 failures"
        // → parseInt("080") = 80, blocking a clean run. The digit run must not be
        // preceded by a word char or hyphen (i.e. not the tail of "PRD-080").
        const failMatch = qaFeedback.match(/(?<![\w-])(\d+)\s+(?:failed|failures)\b/i)
          || qaFeedback.match(/\*\*Failures:\*\*\s*(\d+)/i)
          || qaFeedback.match(/\((\d+)\s+failed/i);
        const failingCount = failMatch ? parseInt(failMatch[1]) : 0;
        if (failingCount > 0) {
          return res.status(400).json({
            error: `Cannot approve QA: ${failingCount} test(s) failed. Project is configured with qa_validation.strict=true and \`main\` is the precondition baseline (zero failing tests on main). All test failures must be addressed before merge. To bypass for this specific approval (e.g. known flake), use {"action":"approve","override":true}. To permanently relax, set qa_validation.strict: false in .build-studio/config.yaml.`,
            failingCount,
            strict: true,
          });
        }
      }
      if (qaStrict && honorCleanApproval && cleanApproval && !operatorOverride) {
        console.log(`[workflow] qa_validation honor_clean_approval: approving on agent's clean verdict (Approved:yes + Blocking:0) despite failing-test count, round=${wf.round}`);
        wf.steps.qa_validation.overrides = (wf.steps.qa_validation.overrides || []).concat({
          at: new Date().toISOString(), step: 'qa_validation', round: wf.round || 1,
          reason: 'honor_clean_approval: QA certified Approved:yes + Blocking:0 (failures triaged non-blocking)',
        });
      }
      if (qaStrict && operatorOverride) {
        const overrideEntry = { at: new Date().toISOString(), step: 'qa_validation', round: wf.round || 1, reason: body.note || 'operator override of strict QA gate' };
        wf.steps.qa_validation.overrides = (wf.steps.qa_validation.overrides || []).concat(overrideEntry);
        console.log(`[workflow] qa_validation operator override: round=${wf.round}, reason="${overrideEntry.reason}"`);
      }

      wf.steps.qa_validation.status = 'completed';
      // Compute the next step from the workflow's ACTIVE sequence (same pattern as
      // ac_verification/security_audit below) — the solo preset goes straight from
      // QA to the merge gate; classic presets continue to ac_verification (also the
      // fallback for legacy configs); a bugfix run continues to code_review.
      const qvNext = nextStepInSequence(wf, config, 'qa_validation') || 'ac_verification';
      wf.steps[qvNext] = { ...(wf.steps[qvNext] || {}), status: 'pending', agents: [] }; // reset for re-run on round > 1
      wf.currentStep = qvNext;
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    // AC Verification — verify each PRD acceptance criterion is met
    if (wf.currentStep === 'ac_verification' && (!wf.steps.ac_verification || wf.steps.ac_verification.status === 'pending' || !wf.steps.ac_verification.agents?.length)) {
      const acAgent = [{
        role: 'AC Verifier', window: 'ac-verify', status: 'pending', reportFeedback: true,
        instruction: `## YOU ARE AN AC VERIFIER — NOT A FIX AGENT — READ THIS FIRST

**Your job is to verify each PRD acceptance criterion against the implementation + tests + evidence. You do NOT write code. You do NOT fix bugs. You do NOT capture new evidence (qa_validation does that). You read the code + the qa_validation feedback + the pr-evidence directory, fill in the AC matrix, and submit a structured verification report.**

**FORBIDDEN FEEDBACK FORMAT** — your feedback will be REJECTED if you use any of these patterns:
- \`**All issues addressed:** yes|no\` / \`**Committed:** <hash>\` / \`### Changes\` listing files you modified (FIX-REPORT format — wrong)
- Plain prose without the AC Verification Matrix table (your role IS the matrix)

**REQUIRED FEEDBACK FORMAT** — your feedback MUST contain:
- \`**Approved:** yes | no\`
- \`**Blocking:** N  |  **Medium:** N  |  **Low:** N\`
- \`### AC Verification Matrix\` table with one row per AC, columns: AC | Description | Status (MET/MOCK-ONLY/PARTIAL/UNMET/UNTESTABLE) | Test Type (AUTOMATED/MOCK/MANUAL) | Evidence (file path or test name)

**IF YOU SEE A BUG OR MISSING IMPLEMENTATION:** mark the affected AC as UNMET or PARTIAL with severity BLOCKING. Add an Action Item naming the role responsible (typically iOS Dev / Backend Dev). DO NOT fix it yourself. DO NOT capture missing screenshots yourself — flag the missing artifact and require the implementing role to capture it.

**APPROVED VS NOT APPROVED — DISTINGUISH OWNER-GATED FROM DEV-GATED:**
Reserve \`**Approved:** no\` for cases where the **implementing role** (iOS Dev, Backend Dev, Frontend Dev, etc.) needs to do more work — broken code, missing implementation, missing evidence the dev should have captured (screenshots from simulator runs, font-output pastes the test could emit, etc.). Those route into a fix loop.

**ACs that are UNTESTABLE solely because they depend on owner-only actions** — opening the project in Xcode IDE, archiving + uploading to TestFlight / App Store Connect, installing on a physical device, capturing a home-screen photo after install, manual smoke on a preview deploy, etc. — are **NOT a reason to set Approved: no**. The dev cannot close those gates; only the owner can, and they close at \`device_testing\` / \`demo_review\` / post-deploy, not via a fix loop. For these:
- Set \`**Approved:** yes\`
- Keep the AC row marked \`UNTESTABLE\` in the matrix
- Add an \`### Owner action items\` section listing each pending owner gate (one bullet per AC) so demo_review has a checklist
- DO NOT count them in \`**Blocking:** N\`

Use \`**Approved:** no\` ONLY when at least one AC is UNMET, PARTIAL, or UNTESTABLE due to a missing-artifact-the-dev-should-have-captured. If every UNTESTABLE row is owner-gated and there are zero UNMET / PARTIAL rows and zero dev-captureable missing artifacts, the answer is \`**Approved:** yes\` with owner action items — not \`**Approved:** no\`.

---

You are an Acceptance Criteria Verifier. Your job is to verify that the implementation meets EVERY acceptance criterion in the PRD.

PRD path: ${wf.prdPath}

## Process

1. Read the PRD file completely
2. Extract ALL acceptance criteria (look for sections titled "Acceptance Criteria", lines with "AC-N:", numbered criteria, or checkbox items in the PRD)
3. For EACH acceptance criterion:
   a. Check if there is code that implements it (search the codebase in this branch)
   b. Check if there is a passing test that covers it
   c. Determine the TEST TYPE for each AC:
      - MOCK: Test uses mocked API/LLM responses — verifies UI logic only
      - INTEGRATION: Test hits the real backend endpoint — verifies actual data flow
      - MANUAL: Requires human verification (e.g., real LLM output quality, visual conformance, app icon appearance)
   d. **For MANUAL ACs, verify an EVIDENCE ARTIFACT exists**: every AC marked MANUAL in your matrix MUST cite a concrete file path in its Evidence column (e.g. \`docs/pr-evidence/PRD-001-ios-scaffolding/visual/today-screen.png\`, \`docs/pr-evidence/PRD-001-ios-scaffolding.md#fonts\`). **Every evidence path MUST be FULLY QUALIFIED — no \`...\` ellipsis, no \`<PRD>\` placeholder, no relative shorthand.** Write the same full path on every row even when it gets repetitive — the approval gate file-exists-checks each cited path literally, and a row with \`docs/pr-evidence/.../visual/foo.png\` will be rejected as a missing artifact even when the real file is present. You MUST verify each cited file exists in the worktree via \`ls\` or \`fs\`. **Marking MANUAL as MET without a committed evidence artifact is a hard error.** If no artifact exists, classify which kind of MANUAL it is:
      - **Dev-captureable MANUAL** (simulator screenshot, font-output paste, byte-check log, runbook excerpt — anything the implementing agent could produce by running the code): mark UNTESTABLE and **Approved: no** with an Action Item for the implementing role to capture the evidence. This routes back through fix loop.
      - **Owner-gated MANUAL** (Xcode IDE open, TestFlight upload, on-device install, home-screen photo after install, manual preview-deploy smoke): mark UNTESTABLE but keep **Approved: yes**, list it under \`### Owner action items\`. Owner closes the gate at device_testing / demo_review — fix loop cannot help.
   e. If possible, run the feature flow end-to-end to verify it works
   f. Rate each AC:
      - MET: Code exists AND verified by automated test with no mocked external dependencies (or project doesn't use mocks) — OR for MANUAL gates, the cited evidence artifact exists and substantively supports the claim
      - MOCK-ONLY: Test passes but mocks external services (LLM, third-party APIs, hardware) — real wiring unverified
      - PARTIAL: Code exists but implementation is incomplete
      - UNMET: No implementation found
      - UNTESTABLE: Cannot verify in this environment, OR MANUAL gate has no evidence artifact — explain why
4. **Cross-check against qa_validation findings.** Read the qa_validation feedback for this round. If QA flagged any \`[Invalid Configuration]\` / asset-not-found / render-wrong runtime warning, treat the affected ACs (anything visual or color-dependent) as PARTIAL or UNMET — the test suite passing does not mean the AC is met when the app renders with fallback colors at runtime.
5. **Check the visual evidence directory** \`docs/pr-evidence/<PRD-basename>/visual/\` for any AC that depends on visible rendering (greetings, metric values, icons, empty states, brand colors). If the directory does not exist or is empty, visual-dependent ACs cannot be marked MET — mark them UNTESTABLE and require the implementing role to capture screenshots.
6. Report using the structured review format from CLAUDE.md

## CRITICAL RULES

- UNMET or PARTIAL is BLOCKING — the implementation is incomplete
- **MANUAL with no committed evidence artifact is UNTESTABLE, not MET.** Source-code review alone is insufficient for MANUAL gates. The PRD declared the gate manual because it requires evidence beyond what code reading can provide (a rendered screenshot, a font-output paste, a byte-check log). Without that artifact in the repo, the gate has not been verified by anyone.
- MOCK-ONLY is NOT blocking but must be flagged for manual verification during demo review
- Not all projects use mocks — check whether the project's test infrastructure actually mocks external services before applying the MOCK-ONLY label
- For projects that DO use mocks: pay special attention to data flow through external services. Does the user's input actually reach the external API call? Does the response contain what the user configured, not invented defaults?
- For mobile projects: distinguish what can be verified in simulator vs what requires real device testing
- Integration tests that call real external services should NOT be run automatically (cost/rate-limit concerns) — they exist for manual execution or CI/CD pre-production gates
- Use the /qa skill for running tests if needed

## Report format

Use the structured review format:

**Approved:** yes | no
**Blocking:** N  |  **Medium:** N  |  **Low:** N

### Summary
[Overall: N/N acceptance criteria met, N at-risk (mock-only). Key gaps.]

### AC Verification Matrix

| AC | Description | Status | Test Type | Evidence |
|----|-------------|--------|-----------|----------|
| AC-1 | ... | MET/MOCK-ONLY/PARTIAL/UNMET/UNTESTABLE | AUTOMATED/MOCK/MANUAL | test name or verification details |
| AC-2 | ... | ... | ... | ... |

The first column MUST use the PRD's own acceptance-criteria identifiers verbatim — either flat \`AC-1\`, \`AC-2\` … or per-user-story \`US-1.1\`, \`US-1.2\`, \`US-2.1\` …. Do not invent a parallel \`AC-N\` numbering when the PRD uses \`US-N.M\`; the dashboard accepts either style and parses both. Mismatched or invented identifiers break the demo-review summary.

### Mock-Only ACs (require manual verification)
[List ACs that pass with mocked external services. These need manual verification during demo review — the automated tests verify logic but not real integration.]

### Action Items
- [ ] [assignee_role] — fix description for each UNMET/PARTIAL AC

This is round ${wf.round}.`,
      }];
      if (!wf.steps.ac_verification) wf.steps.ac_verification = { status: 'pending', agents: [] };
      wf.steps.ac_verification = { status: 'running', agents: launchWorkflowAgents(wf, acAgent, { useWorktrees: false, cwd: projectRoot }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'ac_verification' && action === 'approve') {
      // GATE: every AC row in the AC verifier's matrix that is marked MANUAL
      // must cite an evidence-artifact path that actually exists on disk. The
      // verifier's prompt already enforces this, but agents sometimes claim
      // "side-by-side screenshot in PR description" or hallucinate paths that
      // were never committed. Enforce mechanically: extract Evidence-column
      // paths for every MANUAL row and confirm each resolves to a real file.
      //
      // Operator override: pass `{"override": true}` (or `{"forceApprove": true}`)
      // in the request body to bypass this check. Use when the operator has
      // verified the evidence is captured elsewhere or has accepted that the
      // AC is met despite the artifact-path mismatch. The override is logged
      // so the workflow telemetry captures the manual decision. Note: this
      // block is inside handleExecutionAdvance(..., body) — body is the
      // request body forwarded from the route handler (workflow.js:2300).
      const overrideRequested = body?.override === true || body?.forceApprove === true;
      const acFb = (wf.steps.ac_verification.agents || []).map(a => a.feedback || '').join('\n');
      // PRD-003: ac_verification.strict gates whether to also enforce evidence
      // citations on AUTOMATED+MET rows (not just MANUAL+MET). Default false
      // for soft rollout — projects opt in via .build-studio/config.yaml:
      //   ac_verification:
      //     strict: true
      const acStrict = (config.ac_verification && config.ac_verification.strict) === true;
      const missingArtifacts = [];
      if (acFb.trim() && !overrideRequested) {
        // Match matrix rows: `| <id> | <desc> | <status> | <type> | <evidence> |`
        const rowRe = /^\|\s*(AC-[\w.]+|US-[\w.]+)\s*\|[^|]*\|\s*(MET|PARTIAL|UNMET|UNTESTABLE|MOCK-ONLY|AT-RISK)\s*\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|/gm;
        // Path candidates inside the evidence column — backticked or bare, ending in a file extension or a fragment.
        const pathRe = /`?(docs\/pr-evidence\/[^\s`)]+|docs\/[A-Za-z0-9_\/.\-]+\.(?:md|png|jpg|jpeg|svg|txt|html|json))`?/g;
        // Test-name patterns the verifier might cite as evidence (loose match —
        // covers `Suite.testName`, `Suite/testName`, `testFooBar()` etc.).
        const testNameRe = /\b[A-Z][A-Za-z0-9_]*(?:Tests?|Suite|Spec)[\/.][a-zA-Z_][\w]*\b|\btest[A-Z][\w]*\b/;
        for (const m of acFb.matchAll(rowRe)) {
          const id = m[1];
          const status = m[2].toUpperCase();
          const type = m[3].toUpperCase();
          const evidence = m[4];
          if (status !== 'MET') continue;
          const isManual = /MANUAL/.test(type);
          const isAutomated = /AUTOMATED/.test(type);

          // Existing behavior — MANUAL-only rows always require a real path.
          // AUTOMATED+MANUAL hybrid is exempted (automated test is the load-
          // bearing proof; manual layer is supplementary).
          if (isManual && !isAutomated) {
            let foundAny = false;
            for (const p of evidence.matchAll(pathRe)) {
              const rel = p[1].split('#')[0].trim();
              const abs = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
              if (fs.existsSync(abs)) { foundAny = true; }
              else { missingArtifacts.push({ ac: id, path: rel }); }
            }
            if (!foundAny && !/(docs\/pr-evidence|\.png|\.jpg|\.md|\.html|\.txt|\.json)/.test(evidence)) {
              missingArtifacts.push({ ac: id, path: '(no path cited)' });
            }
            continue;
          }

          // PRD-003 strict mode: AUTOMATED+MET rows must cite a recognizable
          // test reference in the evidence column. Catches the "tests pass so
          // AC is met" cop-out where the verifier doesn't actually point at
          // a test that exercises this AC's surface.
          if (acStrict && isAutomated) {
            const hasPath = pathRe.test(evidence);
            const hasTest = testNameRe.test(evidence);
            if (!hasPath && !hasTest) {
              missingArtifacts.push({ ac: id, path: '(strict mode: AUTOMATED row cites no test name or file path in evidence column)' });
            }
            // Reset regex state — these are sticky (g flag) and would skip rows otherwise.
            pathRe.lastIndex = 0;
          }
        }
      }
      if (missingArtifacts.length > 0) {
        const missingList = missingArtifacts.map(m => `  - ${m.ac}: ${m.path}`).join('\n');
        return res.status(400).json({
          error: `Cannot approve AC verification: ${missingArtifacts.length} MANUAL AC row(s) cite evidence paths that do not exist or cite no path at all. Send the work back to the implementing role to capture the evidence, then re-run AC verification. To bypass this check, retry with {"override": true} in the request body.\n\nMissing or absent:\n${missingList}`,
          missingArtifacts,
          canOverride: true,
        });
      }
      if (overrideRequested) {
        console.log(`[workflow] ac_verification approve: operator override applied (skipped evidence check)`);
      }
      wf.steps.ac_verification.status = 'completed';
      // Compute the next step from the project's resolved workflow.execution
      // list rather than hardcoding 'security_audit' — static-site projects
      // (e.g. example-app) don't include security_audit in their execution flow.
      const execSteps = (config.workflow && config.workflow.execution) || [];
      const acIdx = execSteps.indexOf('ac_verification');
      const nextStep = (acIdx >= 0 && acIdx < execSteps.length - 1)
        ? execSteps[acIdx + 1]
        : 'security_audit'; // legacy fallback
      wf.steps[nextStep] = { status: 'pending', agents: [] };
      wf.currentStep = nextStep;
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    if (wf.currentStep === 'ac_verification' && action === 'send_to_devs') {
      const acFeedback = (wf.steps.ac_verification.agents || []).filter(a => a.feedback).map(a => a.feedback).join('\n\n');
      launchFixPlan(wf, 'ac_verification', acFeedback, notes, prdId);
      return res.json({ workflow: wf });
    }

    // Security audit — code-level review scoped to PRD changes only
    if (wf.currentStep === 'security_audit' && (wf.steps.security_audit.status === 'pending' || !wf.steps.security_audit.agents?.length)) {
      const secRole = require('../config').findRole(config, 'Security');
      const skill = secRole ? secRole.skill : 'security';
      const secAgent = [{
        role: 'Security', window: 'security', status: 'pending', reportFeedback: true,
        instruction: `You are a Security Reviewer. Perform a code-level security audit of the implementation.\n\nPRD path: ${wf.prdPath}\nUse the /${skill} skill.\n\n## AUDIT SCOPE RULES\n1. **Only audit code changes for this PRD** — do not review pre-existing code or raise issues outside the PRD scope.\n2. **Focus on:** injection vulnerabilities, auth/authz gaps, data exposure, input validation, XSS, CSRF, and OWASP Top 10.\n3. **Classify findings** as BLOCKING (must fix before merge) or NON-BLOCKING (track for later).\n4. **If no issues found, say "APPROVE — no security issues found."**`,
      }];
      wf.steps.security_audit = { status: 'running', agents: launchWorkflowAgents(wf, secAgent, { useWorktrees: false, cwd: projectRoot }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'security_audit' && action === 'approve') {
      wf.steps.security_audit.status = 'completed';
      // Compute the next step from the project's resolved workflow.execution
      // list. Mobile-app slots security_audit AFTER device_testing as the final
      // pre-demo gate; web-app slots it between ac_verification and demo_review.
      // Either way, follow whatever the preset configured.
      const execSteps = (config.workflow && config.workflow.execution) || [];
      const secIdx = execSteps.indexOf('security_audit');
      const nextStep = (secIdx >= 0 && secIdx < execSteps.length - 1)
        ? execSteps[secIdx + 1]
        : 'demo_review';
      // Reset the next manual gate to `pending` — if a prior round already
      // approved it, the stale `completed` state would block the UI from
      // rendering the manual approve/send-back/skip buttons on re-entry.
      wf.steps[nextStep] = { ...(wf.steps[nextStep] || {}), status: 'pending', agents: [] };
      wf.currentStep = nextStep;
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    // Device testing — manual gate where the owner (or QA) runs the suite on a
    // physical device. Mirrors demo_review's approve / skip / send-back shape.
    if (wf.currentStep === 'device_testing' && (action === 'approve' || action === 'skip')) {
      wf.steps.device_testing.status = action === 'skip' ? 'skipped' : 'completed';
      // Compute next from workflow.execution — mobile-app now slots
      // security_audit after device_testing, but earlier orderings (or
      // presets without security_audit) need to fall through to demo_review.
      const execSteps = (config.workflow && config.workflow.execution) || [];
      const devIdx = execSteps.indexOf('device_testing');
      const nextStep = (devIdx >= 0 && devIdx < execSteps.length - 1)
        ? execSteps[devIdx + 1]
        : 'demo_review';
      // Reset the next manual gate for the same reason as above.
      wf.steps[nextStep] = { ...(wf.steps[nextStep] || {}), status: 'pending', agents: [] };
      wf.currentStep = nextStep;
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }
    if (wf.currentStep === 'device_testing' && action === 'send_to_devs') {
      const deviceNotes = notes || 'Physical-device test surfaced issues — see user notes.';
      launchFixPlan(wf, 'device_testing', deviceNotes, '', prdId);
      return res.json({ workflow: wf });
    }

    // Demo review step — owner reviews the running app before merge (optional, skippable)
    if (wf.currentStep === 'demo_review' && (action === 'approve' || action === 'skip')) {
      wf.steps.demo_review.status = action === 'skip' ? 'skipped' : 'completed';
      wf.currentStep = 'merge_to_main';
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    // Demo review send back — user describes what's wrong, planner creates fix tasks
    if (wf.currentStep === 'demo_review' && action === 'send_to_devs') {
      const demoNotes = notes || 'Issues found during demo review — see user notes.';
      launchFixPlan(wf, 'demo_review', demoNotes, '', prdId);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'security_audit' && action === 'send_to_devs') {
      const secFeedback = (wf.steps.security_audit.agents || []).filter(a => a.feedback).map(a => a.feedback).join('\n\n');
      launchFixPlan(wf, 'security_audit', secFeedback, notes, prdId);
      return res.json({ workflow: wf });
    }

    // ─── Final independent review (recall-biased, spec-first backstop) ────────
    // Hard gate before the demo/merge gate. A fresh reviewer starts from the
    // spec + architecture (not the diff or the implementer's rationale) and runs
    // the /code-review skill's multi-angle finder→verify at high effort. This is
    // the out-of-band adversarial pass, moved in-flow. Blocking → fix loop.
    if (wf.currentStep === 'final_review' && (wf.steps.final_review.status === 'pending' || !wf.steps.final_review.agents?.length)) {
      const frEffort = (config.final_review && config.final_review.effort) || 'high';
      const frAgent = [{
        role: 'Final Reviewer', window: 'final-review', status: 'pending', reportFeedback: true,
        instruction: `## YOU ARE AN INDEPENDENT FINAL REVIEWER — NOT A FIX AGENT — READ THIS FIRST

**Your job: an adversarial, recall-biased review of the whole change before it ships. You do NOT write code. You do NOT fix bugs. You read, hunt, and report a structured review.**

**START FROM THE SPEC, NOT THE DIFF.** Every earlier gate read the diff and inherited the implementer's mental model — that is why defects survive to here. Do the opposite: read the PRD acceptance criteria + the architecture / data model FIRST and write down what the system SHOULD do across all inputs and entity types. THEN go find where the implementation diverges. Treat "the code looks like it does what it intends" as unproven until you have checked it against the spec across every variant.

**BIAS TOWARD RECALL.** Surface every plausible issue, then verify. A false positive costs a sentence; a missed defect ships. Do not stop at the first few findings.

PRD path: ${wf.prdPath}

## HOW TO REVIEW
Use the /code-review skill at ${frEffort} effort (its multi-angle finder→verify structure). Cover these angles explicitly — each has caught real, merged defects:
1. **Correctness across all inputs** — every entity/type the spec covers (not just the one the impl took), both directions of every toggle, empty/single/multi/invalid payloads. Does a whole class of entity get skipped on a state change?
2. **Silent, fail-safe drops** — code paths that return success (HTTP 200 / no error) while quietly discarding a field or skipping work (e.g. \`safeParse\` → drop instead of reject). Nothing green catches these; hunt them.
3. **Removed / altered behavior** — did the change silently drop or weaken behavior that existed before?
4. **Cross-file / contract drift** — callers and callees still agree on types, shapes, error contracts.
5. **Altitude / duplication** — a third copy of logic that will drift; something that belongs one layer up or down.
6. **Dead / unused error contracts** — declared errors never thrown, branches never reached.
7. **Test scaffolding leaked to prod** — env-based behavior hooks (\`process.env.* === 'fail'\`), test seams not gated by \`NODE_ENV !== 'production'\`, debug backdoors.
8. **Spec conformance** — every AC actually satisfied across all its variants, not just demoed on the happy path.

## SCOPE
Review the change for this PRD. Do not raise pre-existing issues outside the PRD's blast radius, and respect the PRD's "Out of scope" section. Be conservative labeling BLOCKING, but do not suppress a real correctness/spec-violation finding to be polite.

## FEEDBACK FORMAT — MANDATORY (machine-parsed)

**Approved:** yes | no
**Blocking:** N  |  **Medium:** N  |  **Low:** N

### Summary
[1-3 sentences — overall verdict + highest-risk finding.]

### Findings
[Each: severity (BLOCKING/MEDIUM/LOW), file:line, what's wrong, why it violates the spec or is a real defect. Include the angle it came from.]

### Action Items
- [ ] [role] — description

Set **Approved: no** with **Blocking: N** when any BLOCKING finding exists; those route into the fix loop. Otherwise **Approved: yes**, **Blocking: 0** (Medium/Low are recorded but do not block).`,
      }];
      wf.steps.final_review = { status: 'running', agents: launchWorkflowAgents(wf, frAgent, { useWorktrees: false, cwd: projectRoot }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'final_review' && action === 'approve') {
      wf.steps.final_review.status = 'completed';
      // Compute the next step from the resolved execution list — demo_review for
      // presets that have it, merge_to_main for api-only (no demo gate).
      const execSteps = (config.workflow && config.workflow.execution) || [];
      const frIdx = execSteps.indexOf('final_review');
      const nextStep = (frIdx >= 0 && frIdx < execSteps.length - 1)
        ? execSteps[frIdx + 1]
        : 'demo_review';
      wf.steps[nextStep] = { ...(wf.steps[nextStep] || {}), status: 'pending', agents: [] };
      wf.currentStep = nextStep;
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    if (wf.currentStep === 'final_review' && action === 'send_to_devs') {
      const frFeedback = (wf.steps.final_review.agents || []).filter(a => a.feedback).map(a => a.feedback).join('\n\n');
      launchFixPlan(wf, 'final_review', frFeedback, notes, prdId);
      return res.json({ workflow: wf });
    }

    // Merge review branch to main — the "ship it" step
    if (wf.currentStep === 'merge_to_main') {
      // New branching strategy: the run owns wf.branch (checked out in the main dir).
      // Land it on the default branch, delete it (local + remote if pushed), remove
      // any fix worktrees, and return the checkout to the default branch so the next
      // run starts clean. Legacy runs (no wf.branch) fall through to the old logic.
      if (wf.branch) {
        const { execFileSync } = require('child_process');
        const run = (args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        const def = wf.defaultBranch || 'main';
        // Bugfix pre-merge gates. Execution runs the LLM-URL + hygiene scans at its
        // merge_for_review step (mergeDevBranches); a bugfix run has no such step, so
        // run them here — against the fix branch's diff vs the default branch — before
        // anything mutates. The bug-fix discipline mandates a new regression test on
        // every run, exactly the file class these scans protect (a test URL hitting a
        // real LLM API already billed tokens on life-graph). Failure blocks the merge
        // with the scan's error surfaced, same as execution — operator fixes or waives
        // (@llm-url-fixture / config.hygiene.allow) and retries. Guarded to bugfix so
        // execution's path is byte-identical.
        if (wf.type === 'bugfix') {
          const llmScan = scanTestFilesForLlmViolations(projectRoot, def);
          if (llmScan.violations.length > 0) {
            wf.steps.merge_to_main = { status: 'error', error: `${llmScan.violations.length} test file(s) on ${wf.branch} would call real LLM APIs. Fix them (or, for a URL asserted as REJECTED, tag the file @llm-url-fixture), commit, and retry the merge.\n\n${llmScan.violations.join('\n')}`, violations: llmScan.violations };
            state.saveWorkflow(wf);
            return res.status(400).json({ workflow: wf, error: `bugfix merge blocked: ${llmScan.violations.length} LLM test violation(s)`, violations: llmScan.violations });
          }
          const hygieneScan = scanSourceForTestScaffolding(projectRoot, def, config.hygiene || {});
          if (hygieneScan.violations.length > 0) {
            wf.steps.merge_to_main = { status: 'error', error: `${hygieneScan.violations.length} production source file(s) on ${wf.branch} contain test scaffolding that must not ship (env failure hooks / test seams). Remove it (or exempt via config.hygiene.allow), commit, and retry the merge.\n\n${hygieneScan.violations.join('\n')}`, violations: hygieneScan.violations, advisories: hygieneScan.advisories || [] };
            state.saveWorkflow(wf);
            return res.status(400).json({ workflow: wf, error: `bugfix merge blocked: ${hygieneScan.violations.length} hygiene violation(s)`, violations: hygieneScan.violations, advisories: hygieneScan.advisories || [] });
          }
        }
        // Apply the backlog status transition BEFORE the merge so these doc edits are
        // captured by the pre-merge docs auto-commit below and land inside the merge
        // commit — instead of being written to main post-merge and left uncommitted.
        markPrdDone(wf.input);
        advanceLinkedFeatures(wf.prdPath, 'Implemented');
        // Read RAW (untrimmed) porcelain output. The `run()` helper trims the whole
        // string, which strips the leading status-column space of the FIRST line only
        // (" M path" → "M path"), shifting it one char so slice(3) drops the path's
        // first character ("docs/…" → "ocs/…") and a docs/ file is then misclassified
        // as non-docs — falsely blocking the merge on auto-committable evidence.
        let dirty = '';
        try { dirty = execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' }); } catch {}
        if (dirty.trim()) {
          // QA's visual-smoke regenerates evidence under docs/ on every run and often
          // leaves it uncommitted. Auto-commit docs/-only changes onto the run branch
          // (they're part of the PRD and land as a reviewable merge commit). But BLOCK
          // if anything OUTSIDE docs/ is uncommitted — that's un-reviewed source the
          // agent should have committed; silently merging it would bypass QA/review.
          // Porcelain v1: cols 0-1 = XY status, col 2 = space, col 3+ = path.
          const entries = dirty.split('\n').filter(Boolean).map(l => {
            const status = l.slice(0, 2);
            let p = l.slice(3).replace(/^"|"$/g, '');
            if (p.includes(' -> ')) p = p.split(' -> ').pop();
            return { status, path: p };
          });
          const nonDocs = entries.filter(e => !e.path.startsWith('docs/')).map(e => e.path);
          if (nonDocs.length > 0) {
            wf.steps.merge_to_main = { status: 'error', error: `Working tree (${wf.branch}) has uncommitted non-docs changes that must be committed/reviewed first: ${nonDocs.slice(0, 8).join(', ')}${nonDocs.length > 8 ? ` (+${nonDocs.length - 8} more)` : ''}. Commit or stash, then retry the merge.` };
            state.saveWorkflow(wf);
            return res.status(500).json({ workflow: wf, error: `merge_to_main: uncommitted non-docs changes on ${wf.branch}`, uncommitted: nonDocs });
          }
          // Cross-PRD evidence churn: QA's visual smoke re-renders evidence for OTHER PRDs
          // (PDFs/PNGs drift byte-wise even when visually identical). That evidence belongs
          // to the other PRD, not this run — revert tracked drift rather than sweeping it
          // into this merge. Only the CURRENT PRD's pr-evidence dir is auto-committed below.
          // (Untracked foreign evidence is left alone — deleting it is too aggressive; it is
          // rare and falls through to the commit.)
          const prdBase = (wf.prdPath || '').replace(/^.*\//, '').replace(/\.md$/, '');
          const currentEvidenceDir = prdBase ? `docs/pr-evidence/${prdBase}/` : null;
          const foreignTracked = entries.filter(e =>
            e.path.startsWith('docs/pr-evidence/') &&
            (!currentEvidenceDir || !e.path.startsWith(currentEvidenceDir)) &&
            !e.status.includes('?')).map(e => e.path);
          if (foreignTracked.length > 0) {
            try {
              run(['checkout', '--', ...foreignTracked]);
              console.log(`[workflow] merge_to_main: reverted ${foreignTracked.length} cross-PRD evidence drift file(s) not under ${currentEvidenceDir}`);
            } catch (e) {
              console.error(`[workflow] merge_to_main: failed to revert cross-PRD evidence drift: ${e.message}`);
            }
          }
          // Whatever is still dirty under docs/ is this PRD's own work — auto-commit it.
          let remaining = '';
          try { remaining = execFileSync('git', ['status', '--porcelain'], { cwd: projectRoot, encoding: 'utf8' }); } catch {}
          if (remaining.trim()) {
            try {
              run(['add', '-A', '--', 'docs']);
              run(['commit', '-m', `chore(${wf.input}): commit workflow docs/evidence before merge`]);
              console.log(`[workflow] merge_to_main: auto-committed docs/evidence on ${wf.branch}`);
            } catch (e) {
              wf.steps.merge_to_main = { status: 'error', error: `Failed to auto-commit docs/evidence on ${wf.branch}: ${e.message}` };
              state.saveWorkflow(wf);
              return res.status(500).json({ workflow: wf, error: `merge_to_main: docs auto-commit failed: ${e.message}` });
            }
          }
        }
        const runBranchExists = (() => { try { run(['rev-parse', '--verify', wf.branch]); return true; } catch { return false; } })();
        try {
          run(['checkout', def]);
          if (runBranchExists && wf.branch !== def) {
            execFileSync('git', ['merge', wf.branch, '--no-ff', '-m', `Merge ${wf.branch}: ${wf.input}`], { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] });
          }
        } catch (e) {
          try { run(['merge', '--abort']); } catch {}
          try { run(['checkout', def]); } catch {}
          wf.steps.merge_to_main = { status: 'error', error: `Failed to merge ${wf.branch} into ${def}: ${e.message}. Resolve manually (you are on ${def}; the run branch ${wf.branch} is intact).` };
          state.saveWorkflow(wf);
          return res.status(500).json({ workflow: wf, error: `merge_to_main failed: ${e.message}` });
        }
        wf.steps.merge_to_main = { status: 'completed' };
        // markPrdDone + advanceLinkedFeatures already ran pre-merge → included in the merge commit.
        // Bugfix: the fixed Bug is still 'Fixing' (a bug has no PRD link, so the
        // markPrdDone/advanceLinkedFeatures item-lifecycle above are no-ops for it).
        // Flip it Fixing → Done and stamp the merge commit sha into `fixed_in`, then
        // commit that doc change on the default branch so the tree stays clean.
        if (wf.type === 'bugfix' && wf.itemId) {
          try {
            const mergeSha = run(['rev-parse', 'HEAD']);
            setBugItemStatus(wf.itemId, 'Done', { fixed_in: mergeSha });
            commitWorkflowDocs(`docs(${wf.itemId}): mark Done (fixed_in ${mergeSha.slice(0, 7)})`);
          } catch (e) { console.error(`[bugfix] finalize ${wf.itemId} → Done failed:`, e.message); }
        }
        // cleanupBranches removes fix worktrees + deletes wf.reviewBranch (= wf.branch) locally.
        try { cleanupBranches(wf); } catch (e) { console.error('[workflow] cleanupBranches:', e.message); }
        // Delete the remote copy too, if the run branch was ever pushed.
        if (runBranchExists && wf.branch !== def) {
          try { run(['push', 'origin', '--delete', wf.branch]); } catch (_) { /* not pushed / no remote — fine */ }
        }
        tagAndPush(wf);
        wf.currentStep = 'capture_learnings';
        state.saveWorkflow(wf);
        broadcast('worktrees-updated', {});
        return res.json({ workflow: wf, needsAdvance: true });
      }

      const reviewBranch = wf.reviewBranch;
      // Check if review branch actually exists — it may not if tasks ran without worktrees
      let branchExists = false;
      if (reviewBranch) {
        try {
          const { execFileSync } = require('child_process');
          execFileSync('git', ['rev-parse', '--verify', reviewBranch], { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] });
          branchExists = true;
        } catch {} // branch doesn't exist
      }
      if (!reviewBranch || !branchExists) {
        // No review branch — execution didn't use the worktree+review-branch flow
        // (monolithic / iOS runs commit directly in the main checkout). This used
        // to ASSUME "code already on main" and skip. But if execution committed
        // onto a feature branch in the main checkout (e.g. feat/faz-NNN) and left
        // it checked out, the work was stranded off main and never pushed — the
        // CI/CD tab then showed nothing to deploy. Verify the actual checkout and,
        // if it's on a non-default branch, land that branch onto the default
        // branch before tagging/pushing.
        const { execFileSync } = require('child_process');
        const run = (args) => execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
        let defaultBranch = 'main';
        try { defaultBranch = (run(['rev-parse', '--abbrev-ref', 'origin/HEAD']) || '').replace(/^origin\//, '') || 'main'; } catch {}
        let current = '';
        try { current = run(['branch', '--show-current']); } catch {}

        if (current && current !== defaultBranch) {
          // Refuse on a dirty tree — never carry or drop uncommitted work.
          let dirty = '';
          try { dirty = run(['status', '--porcelain']); } catch {}
          if (dirty) {
            wf.steps.merge_to_main = { status: 'error', error: `Working tree on ${current} has uncommitted changes; cannot land it on ${defaultBranch}. Commit or stash, then retry.` };
            state.saveWorkflow(wf);
            return res.status(500).json({ workflow: wf, error: `merge_to_main: uncommitted changes on ${current}` });
          }
          try {
            run(['checkout', defaultBranch]);
            execFileSync('git', ['merge', current, '--no-ff', '-m', `Merge ${current}: ${wf.input}`], { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] });
            try { run(['branch', '-d', current]); } catch {}
            console.log(`[workflow] merge_to_main: landed ${current} onto ${defaultBranch}`);
          } catch (e) {
            try { run(['merge', '--abort']); } catch {}
            wf.steps.merge_to_main = { status: 'error', error: `Failed to merge ${current} into ${defaultBranch}: ${e.message}. Resolve manually.` };
            state.saveWorkflow(wf);
            return res.status(500).json({ workflow: wf, error: `merge_to_main failed: ${e.message}` });
          }
        } else {
          console.log(`[workflow] merge_to_main: on ${defaultBranch}, code already in place`);
        }

        wf.steps.merge_to_main = { status: 'completed' };
        markPrdDone(wf.input);
        advanceLinkedFeatures(wf.prdPath, 'Implemented');
        commitWorkflowDocs(`docs(${wf.input.replace(/\s+/g, '-')}): mark Implemented in backlog`);
        tagAndPush(wf);
        wf.currentStep = 'capture_learnings';
        state.saveWorkflow(wf);
        return res.json({ workflow: wf, needsAdvance: true });
      }
      try {
        const { execFileSync } = require('child_process');
        execFileSync('git', ['merge', reviewBranch, '--no-ff', '-m', `Merge ${reviewBranch}: ${wf.input}`], { cwd: projectRoot, stdio: ['pipe', 'pipe', 'pipe'] });
        wf.steps.merge_to_main = { status: 'completed' };
        markPrdDone(wf.input);
        advanceLinkedFeatures(wf.prdPath, 'Implemented');
        commitWorkflowDocs(`docs(${wf.input.replace(/\s+/g, '-')}): mark Implemented in backlog`);
        // Safe to clean up branches now — they're merged
        cleanupBranches(wf);
        tagAndPush(wf);
        wf.currentStep = 'capture_learnings';
        state.saveWorkflow(wf);
        broadcast('worktrees-updated', {});
        return res.json({ workflow: wf, needsAdvance: true });
      } catch (e) {
        wf.steps.merge_to_main = { status: 'error', error: e.message };
        state.saveWorkflow(wf);
        return res.status(500).json({ workflow: wf, error: `Merge to main failed: ${e.message}. Resolve manually.` });
      }
    }

    // Capture learnings step — extract reusable knowledge from workflow feedback
    if (wf.currentStep === 'capture_learnings' && wf.steps.capture_learnings.status === 'pending') {
      // Capture gate: a clean first-pass run has no lesson worth a page — the
      // curator only launches when something actually went wrong this run.
      // learnings.capture: 'failures' (default) | 'always' | 'off'.
      const captureMode = (config.learnings && config.learnings.capture) || 'failures';
      const fixCycleCount = Object.values(wf.taskExecution?.taskStates || {})
        .reduce((n, ts) => n + (ts.fixCycles || 0), 0);
      const overrideCount = Object.values(wf.steps || {})
        .reduce((n, s) => n + ((s && Array.isArray(s.overrides)) ? s.overrides.length : 0), 0);
      const hygieneTrips = (wf.steps.merge_for_review && wf.steps.merge_for_review.violations || []).length;
      const hadFixWork = (wf.round || 1) > 1 || !!wf.steps.fix_plan || !!wf.steps.fix_execution || fixCycleCount > 0;
      const runSignal = { rounds: wf.round || 1, hadFixWork, fixCycleCount, overrideCount, hygieneTrips };
      const cleanRun = !hadFixWork && overrideCount === 0 && hygieneTrips === 0;
      if ((config.learnings && config.learnings.auto_capture === false)
          || captureMode === 'off'
          || (captureMode === 'failures' && cleanRun)) {
        wf.steps.capture_learnings.status = 'skipped';
        wf.steps.capture_learnings.skipReason = captureMode === 'failures' && cleanRun
          ? 'clean run (no fix rounds, overrides, or gate trips) — nothing signal-bearing to capture'
          : 'learnings capture disabled by config';
        wf.currentStep = 'completed';
        writeWorklog(wf);
        // Still run the expiry sweep — stats accumulated during this run.
        archiveStaleLearnings();
        state.saveWorkflow(wf);
        return res.json({ workflow: wf, completed: true });
      }
      // Promotion candidates: entries agents keep self-reporting as applied are
      // candidates to graduate into a durable home (CLAUDE.md / ARCHITECTURE.md /
      // role notes) and leave the injection pool.
      let promotionHint = '';
      try {
        const stats = loadLearningsStats();
        const candidates = Object.values(stats.entries || {})
          .filter(e => (e.timesApplied || 0) >= 3)
          .sort((a, b) => b.timesApplied - a.timesApplied)
          .slice(0, 5);
        if (candidates.length > 0) {
          promotionHint = `\n\n## Promotion candidates (agents self-reported applying these ≥3 times)\n${candidates.map(c => `- "${c.title}" (applied ${c.timesApplied}×)`).join('\n')}\nFor each: propose in your feedback (under \`### Promotion proposals\`) where it should graduate to — the project's CLAUDE.md, ARCHITECTURE.md component section, or a role notes file — with the exact text to add. Do NOT apply the promotion yourself; the owner decides. A promoted learning's file should then be deleted from docs/learnings/ (note that in the proposal).`;
        }
      } catch {}
      const agentDashboardPath = path.join(__dirname, '../..');
      const logFile = path.join(config.tmpPath, 'logs', `workflow-${wf.id}.md`);
      const captureAgent = [{
        role: 'Knowledge Curator', window: 'learnings', status: 'pending', reportFeedback: true,
        instruction: `You are a Knowledge Curator. Review the completed workflow and extract reusable learnings.

Workflow log: ${logFile}
Read the workflow log for the full feedback history from all agents across all rounds.

## THIS RUN'S SIGNAL — capture only what the failures taught

This run: ${runSignal.rounds} round(s), fix work: ${runSignal.hadFixWork ? `yes (${runSignal.fixCycleCount} fix cycle(s))` : 'no'}, operator overrides: ${runSignal.overrideCount}, hygiene-gate trips: ${runSignal.hygieneTrips}.

**Hard limits — the learnings pool must stay small to stay useful:**
1. **At most 3 new learnings from this run. Zero is a good outcome** — write learnings only for lessons the fix rounds / overrides / gate trips actually taught. Do not write "we did X and it worked" entries.
2. **Every learning must cite its evidence**: the round + finding (or override/gate trip) it came from, in a \`evidence:\` frontmatter field (e.g. \`evidence: "r2 code_review BLOCKING-1"\`). No evidence, no learning.
3. **Merge before create**: search existing docs/learnings/ files first. If a lesson overlaps an existing entry, UPDATE that file (sharpen the title/content, add the new evidence) instead of creating a near-duplicate.
${promotionHint}

## Classification — THIS IS CRITICAL

Every learning must be classified as either:

**CROSS-PROJECT** — A pattern that applies to ANY project using similar technology. Examples:
- "Escape </ in JSON embedded in <script> blocks" ← applies everywhere
- "Date-only strings parse as UTC midnight" ← universal JS/Node pitfall
- "XSS test assertions must account for structural script tags" ← general testing pattern

**PROJECT-SPECIFIC** — Something unique to THIS project's setup, config, or codebase. These should NOT go in learnings files. Examples:
- "Need to copy backend/.env to worktrees" ← this is a project config fix (worktree_env_files in config.yaml)
- "Port 4000 conflicts with Build Studio" ← infrastructure issue, not a code pattern
- "This project uses Fastify not Express" ← project fact, not a learning
- Anything about this project's specific file paths, database schema, or deployment setup

DO NOT write project-specific items as learnings. Instead, mention them in your feedback so the team can fix the config or docs directly — and if the repo has an ARCHITECTURE.md at its root, propose the exact edit to its relevant component section (component facts, guardrails, and test-infrastructure notes belong THERE, not in the learnings pool).

## File Format — ONE FILE PER LEARNING

Each learning is a separate markdown file with YAML frontmatter:

\`\`\`
docs/learnings/<category>/<slug>.md
\`\`\`

Categories: architecture, backend, frontend, devops, qa, security, workflow

Example file \`docs/learnings/security/escape-script-closing-tags-in-embedded-json.md\`:

\`\`\`markdown
---
title: "Escape </ in JSON embedded in <script> blocks"
date: 2026-03-22
severity: high
tags: [xss, json, script, escape, html]
component: rendering
---

JSON.stringify does not escape </script> sequences. Any <script> element ends when the HTML parser sees </, so host-controlled content can break out of a JSON config block. Fix: .replace(/<\\//g, '<\\\\/') on the stringified output before embedding.
\`\`\`

### Frontmatter fields:
- **title**: Clear, actionable title (the learning itself, not a description of what happened)
- **date**: YYYY-MM-DD when discovered
- **severity**: high (build/deploy failure), medium (bug), low (style/preference)
- **tags**: Lowercase keywords for search — technical terms, APIs, tools involved. 3-8 tags.
- **component**: What area — testing, build, rendering, api, auth, database, general
- **evidence**: The round + finding / override / gate trip this lesson came from (e.g. "r2 code_review BLOCKING-1") — required

### File naming:
- Slug from the title, lowercase, hyphens, max 60 chars
- Example: \`escape-script-closing-tags-in-embedded-json.md\`

### Where to write:
1. Write to \`docs/learnings/<category>/<slug>.md\` (project copy)
2. ALSO write the same file to \`${agentDashboardPath}/docs/learnings/<category>/<slug>.md\` (global copy, so other projects benefit)

## Housekeeping

Before adding new entries, scan existing files in docs/learnings/:
- If a new learning overlaps with an existing file, update the existing file instead of creating a duplicate
- If an existing learning is no longer relevant (e.g., fixed in a dependency update), delete the file
- The system uses tags and content for relevance search — good tags make learnings discoverable

## Rules
- Do NOT duplicate learnings that already exist — check existing files first (merge-before-create, see Hard limits above)
- Only capture genuinely reusable patterns, not one-off fixes
- **0–3 new learnings per workflow.** Zero is a good outcome on a run whose failures taught nothing new.
- The body should be 1-3 sentences: what the problem is, why it happens, and how to fix/prevent it
- Commit your changes. ${COMMIT_ON_CURRENT_BRANCH}`,
      }];
      wf.steps.capture_learnings = { status: 'running', agents: launchWorkflowAgents(wf, captureAgent, { useWorktrees: false }) };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf });
    }

    if (wf.currentStep === 'capture_learnings' && (action === 'approve' || action === 'skip')) {
      // Don't finalize the run while the Knowledge Curator is still working.
      // `approve` marks this step completed and sets currentStep='completed',
      // which clears the workflow and (via stopWorkflow) kills the curator's
      // tmux window — if it hadn't committed yet, its learnings are lost and no
      // docs/learnings commit lands. Observed on example-ios ex-108/110/111 (round-3
      // fix-loop runs): capture_learnings showed `completed` with the curator
      // still `running` and no feedback, and no learnings were captured. Round-N
      // curators review a longer feedback history, widening the window for a
      // premature approve. Mirror the fix_execution allDone guard. (`skip` is
      // exempt — it explicitly means "don't capture", so ending the agent is
      // the intended behaviour.)
      if (action === 'approve') {
        const clAgents = wf.steps.capture_learnings.agents || [];
        const stillRunning = clAgents.length > 0 && clAgents.some(a => a.status !== 'done' && a.status !== 'error');
        if (stillRunning) {
          return res.status(400).json({ error: 'capture_learnings is still running — wait for the Knowledge Curator to finish committing its docs/learnings files before approving. Approving now would kill it mid-write and lose the learnings. Use action "skip" only if you intend to discard learnings for this run.' });
        }
      }
      wf.steps.capture_learnings.status = action === 'skip' ? 'skipped' : 'completed';

      // Propagate new learnings to the cross-project shared store at ~/.build-studio/learnings/
      // so other projects benefit from insights discovered here.
      if (action === 'approve') {
        try {
          const { LEARNINGS_DIR } = require('@build-studio/shared/constants');
          const projectLearningsDir = path.join(projectRoot, 'docs/learnings');
          if (fs.existsSync(projectLearningsDir)) {
            const copyDir = (src, dst) => {
              fs.mkdirSync(dst, { recursive: true });
              for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
                if (entry.name === '_archive') continue; // archived entries stay archived — don't resurrect via propagation
                const srcPath = path.join(src, entry.name);
                const dstPath = path.join(dst, entry.name);
                if (entry.isDirectory()) {
                  copyDir(srcPath, dstPath);
                } else if (entry.name.endsWith('.md') && !fs.existsSync(dstPath)) {
                  // Only copy new files — don't overwrite edits made to existing entries
                  fs.copyFileSync(srcPath, dstPath);
                }
              }
            };
            copyDir(projectLearningsDir, LEARNINGS_DIR);
            console.log(`[workflow] Propagated learnings from ${projectLearningsDir} → ${LEARNINGS_DIR}`);
          }
        } catch (e) {
          console.warn(`[workflow] Failed to propagate learnings: ${e.message}`);
        }
      }

      // End-of-run expiry sweep: entries injected ≥30 times since their last
      // self-reported "applied" move to _archive (see archiveStaleLearnings).
      archiveStaleLearnings();

      wf.currentStep = 'completed';
      writeWorklog(wf);
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, completed: true });
    }

    if (wf.currentStep === 'qa_validation' && action === 'send_to_devs') {
      const qaFeedback = (wf.steps.qa_validation.agents || []).filter(a => a.feedback).map(a => a.feedback).join('\n\n');
      // Refuse to launch fix_plan with empty source feedback. Usually means the
      // qa_validation agent stalled or errored before submitting structured
      // feedback (mirrors the relaunch guard below). Without findings to triage,
      // the planner produces 0 tasks and the step ends up blocked anyway —
      // block early so the user re-runs qa_validation against the live pane
      // content (or submits feedback manually) before fix_plan even spins up.
      if (!qaFeedback.trim()) {
        const errored = (wf.steps.qa_validation.agents || []).some(a => a.status === 'error');
        return res.status(400).json({
          error: `Cannot send to devs: qa_validation has no feedback${errored ? ' (an agent errored — likely stalled by the watchdog)' : ''}. Re-run qa_validation so it produces structured findings, or submit feedback manually, before send_to_devs.`,
        });
      }
      launchFixPlan(wf, 'qa_validation', qaFeedback, notes, prdId);
      return res.json({ workflow: wf });
    }

    // --- Fix plan: relaunch (re-run the planner with the same source feedback) ---
    if (wf.currentStep === 'fix_plan' && action === 'launch') {
      const sourceStep = wf.fixSource;
      if (!sourceStep) return res.status(400).json({ error: 'Cannot relaunch fix_plan: wf.fixSource is missing' });
      const sourceFeedback = (wf.steps[sourceStep]?.agents || []).filter(a => a.feedback).map(a => a.feedback).join('\n\n');
      // Refuse to relaunch with empty source feedback — usually means the source
      // step (e.g. qa_validation) hit an error and never produced findings. Running
      // the planner with no input yields a 0-tasks plan that used to silently
      // shortcut to demo_review. Block early so the user re-runs the source step.
      if (!sourceFeedback.trim()) {
        const errored = (wf.steps[sourceStep]?.agents || []).some(a => a.status === 'error');
        return res.status(400).json({
          error: `Cannot relaunch fix_plan: source step "${sourceStep}" has no feedback${errored ? ' (an agent errored, possibly hit usage limits)' : ''}. Re-run ${sourceStep} so it produces findings, then relaunch fix_plan.`,
        });
      }
      launchFixPlan(wf, sourceStep, sourceFeedback, notes, prdId);
      return res.json({ workflow: wf });
    }

    // --- Fix plan: planner creates targeted fix tasks from review feedback ---
    if (wf.currentStep === 'fix_plan' && action === 'approve') {
      const plannerFeedback = (wf.steps.fix_plan.agents || []).map(a => a.feedback || '').join('\n');
      // Try closed code fence first, then unclosed fence (agent forgot to close it), then anchored raw JSON
      const jsonMatch = plannerFeedback.match(/```json\s*([\s\S]*?)```/) ||
                        plannerFeedback.match(/```json\s*([\s\S]+)/);
      let fixPlan = null;
      if (jsonMatch) {
        fixPlan = tryParseJSON(jsonMatch[1]);
      }
      // Fallback: agent may output raw JSON without a code fence — anchor on {"tasks"
      // to avoid matching prose braces. Allow whitespace between { and "tasks" so a
      // pretty-printed object ({\n  "tasks": [...]}) still matches (example-ios EX-107,
      // 2026-06-18: planner emitted unfenced pretty JSON → "No valid fix plan" block).
      if (!fixPlan) {
        const rawMatch = plannerFeedback.match(/(\{\s*"tasks"[\s\S]*\})/);
        if (rawMatch) { fixPlan = tryParseJSON(rawMatch[1]); }
      }

      // If no JSON block found, check if plain-text feedback says 0 tasks (false positive)
      if (!fixPlan) {
        const zeroTasksPlainText = /\b0\s+tasks?\b/i.test(plannerFeedback) || /\bno\s+tasks?\b/i.test(plannerFeedback);
        if (zeroTasksPlainText) {
          fixPlan = { tasks: [] };
        }
      }

      // Normalize: agent may use "fix_plan" key instead of "tasks", or "role" instead of "roles"
      if (fixPlan && !fixPlan.tasks) {
        const arr = fixPlan.fix_plan || fixPlan.fixes || fixPlan.items;
        if (Array.isArray(arr)) fixPlan = { tasks: arr };
      }
      if (fixPlan && fixPlan.tasks) {
        // Normalize task fields. Planner output schema varies (observed shapes
        // use title/scope, name/description, or summary). Without these
        // fallbacks, the fix_execution launcher dereferences `currentTask.name`
        // and `currentTask.description` as undefined and the agent ends up
        // with "**undefined**\nundefined" as its task description — observed
        // on example-ios PRD-009 fix-3 (2026-05-23) where the agent guessed from
        // git history and worked on the wrong task. Same fix as the
        // task_execution plan-approval normalization added 2026-05-22.
        fixPlan.tasks = fixPlan.tasks
          .filter(t => t.severity !== 'SKIP' && t.role !== null)
          .map(t => ({
            ...t,
            roles: t.roles?.length ? t.roles : (t.role ? [t.role] : (t.assignee ? [t.assignee] : [])),
            name: t.name || t.title || `Fix task ${t.id || ''}`.trim(),
            description: t.description || t.scope || t.summary || t.problem
              || (Array.isArray(t.instructions) ? t.instructions.join('\n') : t.instructions) || '',
          }));
      }

      if (!fixPlan || !Array.isArray(fixPlan.tasks)) {
        return res.status(400).json({ error: 'No valid fix plan found in planner feedback. The fix planner must output a ```json code block with a tasks array. Relaunch the fix plan step.' });
      }

      // 0 tasks is ambiguous: either everything is clean (legit shortcut) or the
      // planner had no input feedback to plan against. Distinguish by checking
      // whether the source step actually produced findings — if not, block here
      // instead of marching to demo_review.
      if (fixPlan.tasks.length === 0) {
        const sourceStep = wf.fixSource;
        const sourceFeedback = sourceStep
          ? (wf.steps[sourceStep]?.agents || []).filter(a => a.feedback).map(a => a.feedback).join('\n\n')
          : '';
        if (sourceStep && !sourceFeedback.trim()) {
          wf.steps.fix_plan.status = 'blocked';
          wf.steps.fix_plan.error = `Fix planner produced 0 tasks because source step "${sourceStep}" had no feedback. Re-run ${sourceStep} to produce findings, then relaunch fix_plan.`;
          state.saveWorkflow(wf);
          return res.status(400).json({ error: wf.steps.fix_plan.error });
        }

        // Generalised strict-mode guard: refuse 0-task fix plans whenever the
        // source step is a review step that actually reported blocking
        // findings. Closes the rationalisation escape hatch where fix_planner
        // marks legitimate findings as "out of scope" / "pre-existing" and
        // returns {tasks:[]} — observed across multiple sources:
        //   - qa_validation (example-ios PRD-012, 2026-05-25): 48 failed tests
        //     dismissed as baseline drift
        //   - ac_verification (2026-05-27): blocking findings dismissed,
        //     workflow jumped from fix_plan → device_testing
        //
        // Override path: POST {action:approve, override:true, overrideReason:"..."}.
        // Override is logged on wf.fixPlanOverrides for visibility.
        const REVIEW_SOURCE_STEPS = new Set([
          'qa_validation', 'ac_verification', 'code_review', 'security_audit',
          'final_review',
        ]);
        const qaStrict = (config.qa_validation && config.qa_validation.strict) !== false;
        // Only enforce on qa_validation when its strict mode is explicitly on;
        // other review sources enforce unconditionally — the very fact that
        // fix_plan was reached means send_to_devs fired, which means the
        // source reported blocking findings.
        const shouldEnforce =
          (sourceStep === 'qa_validation' && qaStrict) ||
          (sourceStep !== 'qa_validation' && REVIEW_SOURCE_STEPS.has(sourceStep));

        if (shouldEnforce) {
          // Detect findings in the source feedback. Any of these signals
          // means "the source step explicitly flagged something":
          const failMatch = sourceFeedback.match(/(\d+)\s+(?:failed|failures)\b/i)
            || sourceFeedback.match(/\*\*Failures:\*\*\s*(\d+)/i)
            || sourceFeedback.match(/\((\d+)\s+failed/i);
          const failureCount = failMatch ? parseInt(failMatch[1]) : 0;
          const blockingMatch = sourceFeedback.match(/\*\*Blocking:\*\*\s*(\d+)/i);
          const blockingCount = blockingMatch ? parseInt(blockingMatch[1]) : 0;
          const approvedNo = /\*\*Approved:\*\*\s*no\b/i.test(sourceFeedback);
          // An explicit clean approval means the source step triaged every
          // failing test as non-blocking (pre-existing / flaky / out of scope).
          // Combined with the fix_planner independently returning 0 tasks, an
          // empty fix plan is correct — not rationalisation (example-ios PRD-025,
          // 2026-06-03: QA "Approved: yes, Blocking: 0, 8 pre-existing iOS-26
          // failures" was miscounted as 8 blocking findings and dead-ended the
          // run). Don't conflate raw test-failure counts with blocking findings
          // when the source explicitly certified zero blockers.
          //
          // The reviewer OWNS the triage: a literal `**Approved:** yes` with
          // zero blocking findings is authoritative on its own. We previously
          // also required an explicit `**Blocking:** 0` line; QA reports that
          // wrote `Approved: yes` + `Failures: N (pre-existing)` WITHOUT that
          // line had their N failures miscounted as blocking findings and the
          // run dead-ended on EVERY PRD with a pre-existing-failure baseline
          // (example-ios PRD-051, example-web EX-104, example-app — 2026-06-18/19, each
          // needing a manual operator override). Trust the approval: drop the
          // blocking-line requirement (blockingCount defaults to 0 when the
          // line is absent). An explicit `Approved: no`, or `Approved: yes`
          // paired with `Blocking: N>0`, still counts as findings.
          const approvedYes = /\*\*Approved:\*\*\s*yes\b/i.test(sourceFeedback);
          const cleanApproval = approvedYes && !approvedNo && blockingCount === 0;
          const totalFindings = cleanApproval ? 0 : (failureCount + blockingCount);
          // `Approved: no` alone is NOT a fix-required signal. A review step
          // can disapprove because items are UNTESTABLE (pending owner action,
          // external upload, manual device install) — those produce zero
          // blockers and zero failing tests, and 0 fix tasks is the correct
          // verdict. Only treat actual counts as "needs fixing". Observed
          // on example-app PRD-007 (2026-05-27): AC verifier emitted
          // `Approved: no | Blocking: 0` because 4 ACs were UNTESTABLE
          // pending owner-side TestFlight upload; fix_planner correctly
          // returned 0 tasks but the old guard blocked it as rationalisation.
          const hasFindings = totalFindings > 0;

          if (hasFindings && !body.override) {
            const summary = totalFindings > 0
              ? `${totalFindings} blocking finding(s)`
              : `Approved: no`;
            wf.steps.fix_plan.status = 'blocked';
            wf.steps.fix_plan.error = `Fix planner returned 0 tasks but source step "${sourceStep}" reported ${summary}. Empty fix plans against a review step that flagged blockers are usually rationalisation — every flagged finding should produce a fix task. To bypass, POST {"action":"approve","override":true,"overrideReason":"<short reason>"} to /api/workflow/advance. The override is logged on wf.fixPlanOverrides.`;
            state.saveWorkflow(wf);
            return res.status(400).json({
              error: wf.steps.fix_plan.error,
              needsOverride: true,
              sourceStep,
              failureCount,
              blockingCount,
              approvedNo,
            });
          }
          if (hasFindings && body.override) {
            wf.fixPlanOverrides = wf.fixPlanOverrides || [];
            wf.fixPlanOverrides.push({
              at: new Date().toISOString(),
              round: wf.round || 1,
              sourceStep,
              failureCount,
              blockingCount,
              reason: (body.overrideReason || '').toString().slice(0, 500) || '(no reason provided)',
            });
            console.log(`[workflow] fix_plan 0-task override accepted (source=${sourceStep}, failures=${failureCount}, blocking=${blockingCount}): ${body.overrideReason || '(no reason)'}`);
          }
        }
        // Advance to the step AFTER the source step in the workflow's OWN active
        // sequence — NOT hard-coded to the execution preset. Previously this skipped
        // any intermediate gates (ac_verification, device_testing, security_audit)
        // whenever fix_plan resolved with 0 tasks. Observed on example-ios PRD-012
        // (2026-05-25): qa_validation → fix_plan (0 tasks) → demo_review, with
        // ac_verification + device_testing + security_audit all silently skipped.
        // A SEPARATE bug (fazon FAZ-187, 2026-07-18): this used to read
        // `config.workflow.execution` unconditionally, so a bugfix run whose
        // qa_validation reported pre-existing-only failures (0 fix tasks, correctly)
        // advanced into `ac_verification` — a step that exists in the execution
        // preset but NOT in the bugfix sequence, wedging the workflow on a step no
        // launch handler recognizes. `stepSequence()` is type-aware (bugfix vs
        // execution) and already exists for exactly this; use it here too.
        const seq = stepSequence(wf, config);
        const srcIdx = sourceStep ? seq.indexOf(sourceStep) : -1;
        // Manual human gates (device_testing, demo_review) must be RE-RUN after a
        // send-back, not advanced past — the owner re-tests on the device / re-reviews
        // the demo. For a REVIEW source step, advancing to srcIdx+1 is correct (re-running
        // the review would just re-approve the now-fixed code). But for a re-test gate,
        // srcIdx+1 silently SKIPS the re-test — e.g. on example-app device_testing is
        // immediately followed by demo_review, so a 0-task fix_plan jumped straight to
        // demo_review and the owner never got to re-test. Route back to the gate instead.
        // (Both gates are execution-only concepts; RERUN_GATES.has(sourceStep) is
        // simply false for every bugfix sourceStep, so this is inert there.)
        const RERUN_GATES = new Set(['device_testing', 'demo_review']);
        // Terminal fallback (source step not found, or already last in sequence):
        // 'demo_review' is a reasonable default for an execution run (everything
        // funnels toward it) but doesn't exist in the bugfix sequence at all —
        // fall back to re-running the source step instead, same treatment as a
        // RERUN_GATES hit.
        const advanceTo = RERUN_GATES.has(sourceStep)
          ? sourceStep
          : (srcIdx >= 0 && srcIdx < seq.length - 1)
            ? seq[srcIdx + 1]
            : (wf.type === 'bugfix' ? (sourceStep || seq[0]) : 'demo_review');
        console.log(`[workflow] Fix plan has 0 tasks — advancing ${sourceStep || '?'} → ${advanceTo}${RERUN_GATES.has(sourceStep) ? ' (re-run manual gate)' : ''}`);
        wf.steps.fix_plan.status = 'completed';
        wf.fixPlan = fixPlan;
        wf.currentStep = advanceTo;
        wf.steps[advanceTo] = { ...(wf.steps[advanceTo] || {}), status: 'pending', agents: [] };
        state.saveWorkflow(wf);
        return res.json({ workflow: wf, needsAdvance: true });
      }

      wf.steps.fix_plan.status = 'completed';
      wf.fixPlan = fixPlan;

      wf.fixExecutionRound = (wf.fixExecutionRound || 0) + 1;
      wf.currentStep = 'fix_execution';
      wf.steps.fix_execution = { status: 'pending', agents: [], completedTasks: [] };
      state.saveWorkflow(wf);
      return res.json({ workflow: wf, needsAdvance: true });
    }

    // --- Fix execution: iterate through fix tasks, one at a time ---
    if (wf.currentStep === 'fix_execution') {
      const fixPlan = wf.fixPlan;
      if (!fixPlan || !fixPlan.tasks) {
        return res.status(400).json({ error: 'No fix plan found. Run the fix plan step first.' });
      }

      const fixStep = wf.steps.fix_execution;

      // Round-based reset: each time fix_plan approves a new plan it increments fixExecutionRound.
      // Reset fixTaskIndex to 0 exactly once per round, regardless of how fix_execution is entered.
      if ((wf.fixExecutionRound || 0) > (wf._lastFixExecutionRound || 0)) {
        wf.fixTaskIndex = 0;
        wf._lastFixExecutionRound = wf.fixExecutionRound;
        console.log(`[workflow] fixTaskIndex reset to 0 for fix round ${wf.fixExecutionRound}`);
      }

      const currentIdx = wf.fixTaskIndex || 0;

      // ── PRD-001: Monolithic fix_execution ──────────────────────────────────
      // Launches ONE agent that handles all fix tasks in a single pass. Saves
      // the per-task context-acquisition overhead (~7× tokens in the PRD-009
      // experiment) and lets the agent address cross-cutting issues in one go.
      //
      // Default flipped to 'monolithic' 2026-05-27 (matches task_execution
      // default). Projects opt out via:
      //   step_strategies:
      //     fix_execution: fine-grained
      const fixStrategy = (config.step_strategies && config.step_strategies.fix_execution) || 'monolithic';

      if (fixStrategy === 'monolithic' && currentIdx === 0) {
        // Monolithic launch: pick a single role (the most common in the plan; tie-break by appearance order)
        const roleCounts = new Map();
        for (const t of fixPlan.tasks) {
          for (const r of (t.roles || [])) {
            roleCounts.set(r, (roleCounts.get(r) || 0) + 1);
          }
        }
        const primaryRole = [...roleCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        const findRole = require('../config').findRole;
        const resolvedRole = primaryRole ? (findRole(config, primaryRole) || findRole(config, primaryRole.replace(/_/g, ' ')) || (config.roles.execution || []).find(r => r.role.toLowerCase() === primaryRole.toLowerCase())) : null;

        if (!resolvedRole) {
          fixStep.status = 'blocked';
          fixStep.error = `Monolithic fix_execution: cannot resolve role from fix plan. Tasks reference: ${[...roleCounts.keys()].join(', ')}. Known: ${(config.roles.execution || []).map(r => r.role).join(', ')}.`;
          state.saveWorkflow(wf);
          return res.status(400).json({ error: fixStep.error, workflow: wf });
        }

        if (action === 'launch' || action === 'next_task' || (fixStep.status === 'pending' && !fixStep.agents?.length)) {
          // Build the fix-task list as a structured block in the prompt
          const taskBlock = fixPlan.tasks.map((t, i) => {
            const issues = (t.issues_addressed || []).join(', ');
            return `### Fix ${i + 1}/${fixPlan.tasks.length} · ${t.id || ''} — ${t.name || t.title || ''}\n\n${t.description || ''}\n\nIssues: ${issues || '(see description)'}`;
          }).join('\n\n---\n\n');

          const agent = {
            role: resolvedRole.role,
            window: `fix-mono-${resolvedRole.role.toLowerCase().replace(/\s+/g, '-').slice(0, 10)}`,
            status: 'pending',
            reportFeedback: true,
            instruction: `You are a ${resolvedRole.role}. Read your role definition at .claude/commands/${resolvedRole.command} first.

You are running in MONOLITHIC FIX MODE — one agent, ${fixPlan.tasks.length} fix tasks, single context.

PRD path: ${wf.prdPath}

## YOUR FIX TASKS (${fixPlan.tasks.length} total)

${taskBlock}

## EXECUTION GUIDANCE

- Work through the tasks in order. They are listed in the order the fix planner emitted them.
- **Commit per task** (one git commit per fix), so each commit message references the fix id (e.g. \`fix(prd-XXX): ... (${fixPlan.tasks[0]?.id || 'task-id'})\`). The dashboard's findings checklist auto-checks items by matching commit messages to finding IDs — accurate commits keep the operator's progress view accurate. ${COMMIT_ON_CURRENT_BRANCH}
- Stay within scope. Do NOT refactor unrelated code or fix pre-existing issues outside these tasks.
- If a task uncovers an issue that's clearly out of scope, note it in your final feedback under "## Out of scope (defer)" but do not address it now.
- After all tasks: rebuild + run the relevant test suite to confirm no regressions, then POST your structured feedback.

Use the /${resolvedRole.skill} skill.
${FIX_EXECUTION_EFFICIENCY_INSTRUCTIONS}${STRUCTURED_FEEDBACK_INSTRUCTIONS}`,
          };

          captureStepAgentTokens(fixStep);
          fixStep.status = 'running';
          fixStep.currentTask = { id: 'monolithic-fix-batch', name: `${fixPlan.tasks.length} fixes in one pass`, roles: [resolvedRole.role] };
          fixStep.agents = launchWorkflowAgents(wf, [agent], { useWorktrees: false });
          fixStep.strategy = 'monolithic';
          state.saveWorkflow(wf);
          return res.json({ workflow: wf });
        }

        if (action === 'approve') {
          const allDone = (fixStep.agents || []).every(a => a.status === 'done' || a.status === 'error');
          if (!allDone) return res.status(400).json({ error: 'Monolithic fix agent has not finished yet.' });

          // Mark all fix tasks completed at once. Findings status (in_progress/done)
          // is inferred separately by extractFindings via commit-message matching.
          if (!fixStep.completedTasks) fixStep.completedTasks = [];
          for (const t of fixPlan.tasks) {
            fixStep.completedTasks.push({
              ...t,
              status: 'completed',
              agentFeedback: (fixStep.agents || []).map(a => ({ role: a.role, feedback: a.feedback })),
            });
          }
          captureStepAgentTokens(fixStep);
          fixStep.status = 'completed';
          wf.fixTaskIndex = fixPlan.tasks.length; // mark all done so the existing "all tasks done" path picks up
          wf.round++;

          if (wf.round > MAX_REVIEW_ROUNDS) {
            wf.currentStep = 'review_cap_reached';
            wf.steps.review_cap_reached = { status: 'blocked', cap: wf.fixSource || 'fix', rounds: wf.round };
            state.saveWorkflow(wf);
            broadcast('workflow-updated', {});
            return res.json({ workflow: wf, warning: `Fix loop reached ${MAX_REVIEW_ROUNDS} rounds.` });
          }
          const returnTo = wf.returnTo || 'code_review';
          wf.currentStep = returnTo;
          wf.steps[returnTo] = { status: 'pending', agents: [] };
          state.saveWorkflow(wf);
          broadcast('workflow-updated', {});
          return res.json({ workflow: wf });
        }
      }

      // All fix tasks done → merge and go to code_review
      if (currentIdx >= fixPlan.tasks.length) {
        fixStep.status = 'completed';
        wf.round++;

        if (wf.round > MAX_REVIEW_ROUNDS) {
          console.log(`[workflow] Fix loop capped at ${MAX_REVIEW_ROUNDS} rounds (source: ${wf.fixSource}). Blocking — requires user decision.`);
          wf.currentStep = 'review_cap_reached';
          wf.steps.review_cap_reached = { status: 'blocked', cap: wf.fixSource || 'fix', rounds: wf.round };
          state.saveWorkflow(wf);
          broadcast('workflow-updated', {});
          return res.json({ workflow: wf, warning: `Fix loop reached ${MAX_REVIEW_ROUNDS} rounds. Choose: advance anyway or cancel.` });
        }

        const returnTo = wf.returnTo || 'code_review';
        wf.currentStep = returnTo;
        wf.steps[returnTo] = { status: 'pending', agents: [] };
        state.saveWorkflow(wf);
        broadcast('workflow-updated', {});
        return res.json({ workflow: wf });
      }

      const currentTask = fixPlan.tasks[currentIdx];

      // Launch fix task — sequential execution: no branches, work directly in project root
      if (action === 'launch' || (fixStep.status === 'pending' && !fixStep.agents?.length) || action === 'next_task') {
        const taskRoles = currentTask.roles || [];
        const devAgents = taskRoles.map(roleName => {
          const normalized = roleName.replace(/_/g, ' ');
          const role = require('../config').findRole(config, roleName) || require('../config').findRole(config, normalized) || (config.roles.execution || []).find(r => r.role.toLowerCase() === normalized.toLowerCase());
          if (!role) return null;
          return {
            role: role.role,
            window: `fix${currentIdx + 1}-${role.role.toLowerCase().replace(/\s+/g, '-').slice(0, 8)}`,
            status: 'pending',
            reportFeedback: true,
            instruction: `You are a ${role.role}. Read your role definition at .claude/commands/${role.command} first.

Fix TASK ${currentIdx + 1} of ${fixPlan.tasks.length}.

PRD path: ${wf.prdPath}

## YOUR FIX TASK (${currentIdx + 1}/${fixPlan.tasks.length})

**${currentTask.name}**

${currentTask.description}

Issues addressed: ${(currentTask.issues_addressed || []).join(', ') || 'see task description'}

## SCOPE — CRITICAL

Only fix what this task describes. Do NOT refactor unrelated code.
Do NOT fix pre-existing issues outside this task's scope.

Use the /${role.skill} skill. Commit your changes when done. ${COMMIT_ON_CURRENT_BRANCH}
${FIX_EXECUTION_EFFICIENCY_INSTRUCTIONS}${STRUCTURED_FEEDBACK_INSTRUCTIONS}`,
          };
        }).filter(Boolean);

        if (devAgents.length === 0) {
          // No role resolved for this fix task — this almost always means the
          // fix planner emitted a role name the lookup doesn't recognise (e.g.
          // "/backend_dev" before findRole tolerated the slash form). Silently
          // skipping every task lets fix_execution "complete" with zero work
          // done, so block instead and surface the issue.
          const requested = (currentTask.roles || currentTask.role || []);
          const requestedStr = Array.isArray(requested) ? requested.join(', ') : String(requested);
          const knownRoles = (config.roles.execution || []).map(r => `${r.role} (/${r.skill})`).join(', ');
          fixStep.status = 'blocked';
          fixStep.error = `Fix task ${currentIdx + 1} ("${currentTask.name || currentTask.id || 'unnamed'}") requested role(s) [${requestedStr}] that don't match any execution role. Known: ${knownRoles}. Relaunch fix_plan and ensure roles match the available execution roles.`;
          state.saveWorkflow(wf);
          return res.status(400).json({ error: fixStep.error, workflow: wf });
        }

        captureStepAgentTokens(fixStep);
        fixStep.status = 'running';
        fixStep.currentTask = currentTask;
        fixStep.agents = launchWorkflowAgents(wf, devAgents, { useWorktrees: false });
        state.saveWorkflow(wf);
        return res.json({ workflow: wf });
      }

      // Approve current fix task → advance to next
      if (action === 'approve') {
        const allDone = (fixStep.agents || []).every(a => a.status === 'done' || a.status === 'error');
        if (!allDone) {
          return res.status(400).json({ error: 'Not all agents have finished this fix task yet.' });
        }

        if (!fixStep.completedTasks) fixStep.completedTasks = [];
        fixStep.completedTasks.push({
          ...currentTask,
          status: 'completed',
          agentFeedback: (fixStep.agents || []).map(a => ({ role: a.role, feedback: a.feedback })),
        });

        captureStepAgentTokens(fixStep);
        wf.fixTaskIndex = currentIdx + 1;
        fixStep.status = 'pending';
        fixStep.agents = [];
        state.saveWorkflow(wf);

        if (wf.fixTaskIndex >= fixPlan.tasks.length) {
          // All fix tasks done — merge and go to code_review
          fixStep.status = 'completed';
          wf.round++;

          if (wf.round > MAX_REVIEW_ROUNDS) {
            console.log(`[workflow] Fix loop capped at ${MAX_REVIEW_ROUNDS} rounds (source: ${wf.fixSource}). Blocking.`);
            wf.currentStep = 'review_cap_reached';
            wf.steps.review_cap_reached = { status: 'blocked', cap: wf.fixSource || 'fix', rounds: wf.round };
            state.saveWorkflow(wf);
            broadcast('workflow-updated', {});
            return res.json({ workflow: wf, warning: `Fix loop reached ${MAX_REVIEW_ROUNDS} rounds.` });
          }

          const returnTo2 = wf.returnTo || 'code_review';
          wf.currentStep = returnTo2;
          wf.steps[returnTo2] = { status: 'pending', agents: [] };
          state.saveWorkflow(wf);
          broadcast('workflow-updated', {});
          return res.json({ workflow: wf });
        }

        return res.json({ workflow: wf, needsAdvance: true });
      }
    }

    // Review cap reached — user must explicitly choose to advance or cancel
    if (wf.currentStep === 'review_cap_reached') {
      const capInfo = wf.steps.review_cap_reached;
      if (action === 'approve' || action === 'skip') {
        wf.steps.review_cap_reached.status = 'skipped';
        const capReturnTo = wf.returnTo || 'code_review';
        wf.currentStep = capReturnTo;
        wf.steps[capReturnTo] = { status: 'pending', agents: [] };
        state.saveWorkflow(wf);
        broadcast('workflow-updated', {});
        return res.json({ workflow: wf });
      }
      return res.status(400).json({ error: 'Review cap reached. Choose "Advance anyway" to skip remaining fixes, or cancel the workflow.' });
    }

    return res.status(400).json({ error: `no valid transition for step=${wf.currentStep} action=${action}` });
  }

  return router;
}

module.exports = {
  createWorkflowRouter,
  // Exported for unit tests (pure bugfix helpers — no I/O).
  DEFAULT_BUGFIX_STEPS,
  bugfixDisciplineBlock,
  bugfixSequence,
  stepSequence,
  nextStepInSequence,
  validateBugfixStart,
  resolveBuilderRole,
  buildBugfixTask,
};
