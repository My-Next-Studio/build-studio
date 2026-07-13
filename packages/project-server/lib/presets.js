const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');

/**
 * Workflow presets — composable templates for different project types.
 *
 * Each preset defines:
 *   roles    — default role roster (review, execution, standalone)
 *   workflow — step sequences for kickoff, review, execution
 *   step_models — model assignments per step
 *
 * Projects pick a preset and can override:
 *   roles.add     — add roles to a category
 *   roles.remove  — remove roles by name
 *   workflow.<flow>.add    — append steps
 *   workflow.<flow>.remove — remove steps
 *   workflow.<flow>        — replace entirely (array overrides preset)
 */

const PRESETS = {
  'web-app': {
    description: 'Full-stack web application with frontend + backend',
    features: {
      playwright_cli: true,   // screenshot verification against Pencil designs
    },
    roles: {
      review: [
        { role: 'Brand', skill: 'brand', command: 'brand.md' },
        { role: 'Marketing', skill: 'marketing', command: 'marketing.md' },
        { role: 'UX', skill: 'ux', command: 'ux.md' },
        { role: 'Architect', skill: 'architect', command: 'architect.md' },
        { role: 'Security', skill: 'security', command: 'security.md' },
        { role: 'QA', skill: 'qa_review', command: 'qa_review.md' },
      ],
      execution: [
        { role: 'Frontend Dev', skill: 'frontend_dev', command: 'frontend_dev.md', branch_prefix: 'agent-frontend', worktree: true },
        { role: 'Backend Dev', skill: 'backend_dev', command: 'backend_dev.md', branch_prefix: 'agent-backend', worktree: true },
      ],
      standalone: [
        { role: 'PM', skill: 'pm', command: 'pm.md' },
        { role: 'QA', skill: 'qa', command: 'qa.md' },
        { role: 'CEO', skill: 'ceo', command: 'ceo.md' },
        { role: 'DevOps', skill: 'devops', command: 'devops.md' },
        { role: 'Designer', skill: 'designer', command: 'designer.md' },
        { role: 'Code Review', skill: 'code_reviewer', command: 'code_reviewer.md' },
      ],
    },
    workflow: {
      kickoff: ['ceo_synthesis', 'pm_scoping', 'owner_consultations', 'team_review', 'pm_revision', 'companion_specs', 'devops_init'],
      review: ['pm_draft', 'reviewing', 'pm_fix', 'companion_specs'],
      // PRD-001 v1: onboarding workflow for existing projects. Mirrors kickoff
      // but reads existing files instead of docs/inputs/. Owner sign-off
      // gates the first commit. See build-studio/docs/prds/PRD-001-onboard-existing-projects.md.
      onboarding: ['discovery', 'ceo_synthesis', 'architect_backfill', 'pm_synthesis', 'devops_detect', 'team_review', 'pm_revision', 'owner_signoff'],
      execution: ['qa_tests', 'planning', 'task_execution', 'merge_for_review', 'coverage_matrix', 'qa_validation', 'ac_verification', 'security_audit', 'final_review', 'demo_review', 'merge_to_main', 'capture_learnings'],
    },
    step_models: {
      // Review/analysis runs on Sonnet 5 (near-Opus at code analysis, far cheaper);
      // only the recall backstop and the reasoning-heavy planners stay on Opus.
      reviewing: 'sonnet', qa_tests: 'sonnet', team_review: 'sonnet', capture_learnings: 'sonnet',
      code_review: 'sonnet',     // Sonnet 5 ≈ Opus at coding
      security_audit: 'sonnet',  // PRD-scoped security review
      coverage_matrix: 'sonnet', // AC×variant enumeration — Sonnet 5 is sufficient
      final_review: 'opus',      // recall-biased independent backstop — keep max depth
      qa_validation: 'sonnet', ac_verification: 'sonnet',
      // Execution steps — Opus for planning/strategy, Sonnet for implementation
      planning: 'opus', companion_specs: 'opus',
      task_execution: 'sonnet',  // implementation work; Sonnet 4.6 is capable + faster
      fix_plan: 'opus',          // planner-level reasoning
      fix_execution: 'sonnet',   // executing specific tasks per plan
      // Infrastructure — mostly mechanical
      owner_consultations: 'sonnet', devops_init: 'sonnet',
      merge_for_review: 'sonnet', merge_to_main: 'sonnet',
      // PM/strategy — document-heavy, Opus
      pm_draft: 'opus', pm_fix: 'opus', pm_scoping: 'opus', pm_revision: 'opus',
      ceo_synthesis: 'opus',
      // PRD-001 onboarding workflow steps
      discovery: 'sonnet', architect_backfill: 'opus', pm_synthesis: 'opus', devops_detect: 'sonnet',
    },
  },

  'api-only': {
    description: 'Backend API service — no frontend, no visual design',
    features: {
      playwright_cli: false,  // no frontend to screenshot
    },
    roles: {
      review: [
        { role: 'Architect', skill: 'architect', command: 'architect.md' },
        { role: 'Security', skill: 'security', command: 'security.md' },
        { role: 'QA', skill: 'qa_review', command: 'qa_review.md' },
      ],
      execution: [
        { role: 'Backend Dev', skill: 'backend_dev', command: 'backend_dev.md', branch_prefix: 'agent-backend', worktree: true },
      ],
      standalone: [
        { role: 'PM', skill: 'pm', command: 'pm.md' },
        { role: 'QA', skill: 'qa', command: 'qa.md' },
        { role: 'CEO', skill: 'ceo', command: 'ceo.md' },
        { role: 'DevOps', skill: 'devops', command: 'devops.md' },
        { role: 'Code Review', skill: 'code_reviewer', command: 'code_reviewer.md' },
      ],
    },
    workflow: {
      kickoff: ['ceo_synthesis', 'pm_scoping', 'team_review', 'pm_revision', 'devops_init'],
      review: ['pm_draft', 'reviewing', 'pm_fix', 'companion_specs'],
      // PRD-001 v1: onboarding workflow for existing projects. Mirrors kickoff
      // but reads existing files instead of docs/inputs/. Owner sign-off
      // gates the first commit. See build-studio/docs/prds/PRD-001-onboard-existing-projects.md.
      onboarding: ['discovery', 'ceo_synthesis', 'architect_backfill', 'pm_synthesis', 'devops_detect', 'team_review', 'pm_revision', 'owner_signoff'],
      execution: ['qa_tests', 'planning', 'task_execution', 'merge_for_review', 'coverage_matrix', 'qa_validation', 'ac_verification', 'security_audit', 'final_review', 'merge_to_main', 'capture_learnings'],
    },
    step_models: {
      reviewing: 'sonnet', qa_tests: 'sonnet', team_review: 'sonnet', capture_learnings: 'sonnet',
      code_review: 'sonnet', security_audit: 'sonnet',
      coverage_matrix: 'sonnet', final_review: 'opus',
      qa_validation: 'sonnet', ac_verification: 'sonnet',
      planning: 'opus', companion_specs: 'opus',
      task_execution: 'sonnet',
      fix_plan: 'opus', fix_execution: 'sonnet',
      owner_consultations: 'sonnet', devops_init: 'sonnet',
      merge_for_review: 'sonnet', merge_to_main: 'sonnet',
      pm_draft: 'opus', pm_fix: 'opus', pm_scoping: 'opus', pm_revision: 'opus',
      ceo_synthesis: 'opus',
      // PRD-001 onboarding workflow steps
      discovery: 'sonnet', architect_backfill: 'opus', pm_synthesis: 'opus', devops_detect: 'sonnet',
    },
  },

  'mobile-app': {
    description: 'Native mobile app (iOS + Android) with backend API',
    features: {
      playwright_cli: false,  // mobile apps can't be screenshotted via browser
    },
    roles: {
      review: [
        { role: 'Brand', skill: 'brand', command: 'brand.md' },
        { role: 'UX', skill: 'ux', command: 'ux.md' },
        { role: 'Architect', skill: 'architect', command: 'architect.md' },
        { role: 'Security', skill: 'security', command: 'security.md' },
        { role: 'QA', skill: 'qa_review', command: 'qa_review.md' },
      ],
      execution: [
        { role: 'iOS Dev', skill: 'ios_dev', command: 'ios_dev.md', branch_prefix: 'agent-ios', worktree: true },
        { role: 'Android Dev', skill: 'android_dev', command: 'android_dev.md', branch_prefix: 'agent-android', worktree: true },
        { role: 'Backend Dev', skill: 'backend_dev', command: 'backend_dev.md', branch_prefix: 'agent-backend', worktree: true },
      ],
      standalone: [
        { role: 'PM', skill: 'pm', command: 'pm.md' },
        { role: 'QA', skill: 'qa', command: 'qa.md' },
        { role: 'CEO', skill: 'ceo', command: 'ceo.md' },
        { role: 'DevOps', skill: 'devops', command: 'devops.md' },
        { role: 'Designer', skill: 'designer', command: 'designer.md' },
        { role: 'Code Review', skill: 'code_reviewer', command: 'code_reviewer.md' },
      ],
    },
    workflow: {
      kickoff: ['ceo_synthesis', 'pm_scoping', 'owner_consultations', 'team_review', 'pm_revision', 'companion_specs', 'devops_init'],
      review: ['pm_draft', 'reviewing', 'pm_fix', 'companion_specs'],
      // PRD-001 v1: onboarding workflow for existing projects. Mirrors kickoff
      // but reads existing files instead of docs/inputs/. Owner sign-off
      // gates the first commit. See build-studio/docs/prds/PRD-001-onboard-existing-projects.md.
      onboarding: ['discovery', 'ceo_synthesis', 'architect_backfill', 'pm_synthesis', 'devops_detect', 'team_review', 'pm_revision', 'owner_signoff'],
      // security_audit moved AFTER device_testing so it runs once at the end as
      // a final pre-demo gate, not on every fix loop. ac_verification stays
      // earlier (catches missed ACs each fix round, where early signal matters).
      execution: ['qa_tests', 'planning', 'task_execution', 'merge_for_review', 'coverage_matrix', 'qa_validation', 'ac_verification', 'device_testing', 'security_audit', 'final_review', 'demo_review', 'merge_to_main', 'capture_learnings'],
    },
    step_models: {
      reviewing: 'sonnet', qa_tests: 'sonnet', team_review: 'sonnet', capture_learnings: 'sonnet',
      code_review: 'sonnet', security_audit: 'sonnet',
      coverage_matrix: 'sonnet', final_review: 'opus',
      qa_validation: 'sonnet', ac_verification: 'sonnet',
      device_testing: 'sonnet',
      planning: 'opus', companion_specs: 'opus',
      task_execution: 'sonnet',
      fix_plan: 'opus', fix_execution: 'sonnet',
      owner_consultations: 'sonnet', devops_init: 'sonnet',
      merge_for_review: 'sonnet', merge_to_main: 'sonnet',
      pm_draft: 'opus', pm_fix: 'opus', pm_scoping: 'opus', pm_revision: 'opus',
      ceo_synthesis: 'opus',
      // PRD-001 onboarding workflow steps
      discovery: 'sonnet', architect_backfill: 'opus', pm_synthesis: 'opus', devops_detect: 'sonnet',
    },
  },

  'static-site': {
    description: 'Marketing site, documentation, or static content — frontend only',
    features: {
      playwright_cli: true,   // screenshot verification against Pencil designs
    },
    roles: {
      review: [
        { role: 'Brand', skill: 'brand', command: 'brand.md' },
        { role: 'Marketing', skill: 'marketing', command: 'marketing.md' },
        { role: 'UX', skill: 'ux', command: 'ux.md' },
        { role: 'Security', skill: 'security', command: 'security.md' },
        { role: 'QA', skill: 'qa_review', command: 'qa_review.md' },
      ],
      execution: [
        { role: 'Frontend Dev', skill: 'frontend_dev', command: 'frontend_dev.md', branch_prefix: 'agent-frontend', worktree: true },
      ],
      standalone: [
        { role: 'PM', skill: 'pm', command: 'pm.md' },
        { role: 'QA', skill: 'qa', command: 'qa.md' },
        { role: 'CEO', skill: 'ceo', command: 'ceo.md' },
        { role: 'DevOps', skill: 'devops', command: 'devops.md' },
        { role: 'Designer', skill: 'designer', command: 'designer.md' },
        { role: 'Code Review', skill: 'code_reviewer', command: 'code_reviewer.md' },
      ],
    },
    workflow: {
      kickoff: ['ceo_synthesis', 'pm_scoping', 'team_review', 'pm_revision', 'devops_init'],
      review: ['pm_draft', 'reviewing', 'pm_fix', 'companion_specs'],
      // PRD-001 v1: onboarding workflow for existing projects. Mirrors kickoff
      // but reads existing files instead of docs/inputs/. Owner sign-off
      // gates the first commit. See build-studio/docs/prds/PRD-001-onboard-existing-projects.md.
      onboarding: ['discovery', 'ceo_synthesis', 'architect_backfill', 'pm_synthesis', 'devops_detect', 'team_review', 'pm_revision', 'owner_signoff'],
      execution: ['planning', 'task_execution', 'merge_for_review', 'qa_validation', 'ac_verification', 'final_review', 'demo_review', 'merge_to_main', 'capture_learnings'],
    },
    step_models: {
      reviewing: 'sonnet', team_review: 'sonnet', capture_learnings: 'sonnet',
      code_review: 'sonnet',
      final_review: 'opus',
      qa_validation: 'sonnet', ac_verification: 'sonnet',
      planning: 'opus', companion_specs: 'opus',
      task_execution: 'sonnet',
      fix_plan: 'opus', fix_execution: 'sonnet',
      devops_init: 'sonnet',
      merge_for_review: 'sonnet', merge_to_main: 'sonnet',
      pm_draft: 'opus', pm_fix: 'opus', pm_scoping: 'opus', pm_revision: 'opus',
      ceo_synthesis: 'opus',
      // PRD-001 onboarding workflow steps
      discovery: 'sonnet', architect_backfill: 'opus', pm_synthesis: 'opus', devops_detect: 'sonnet',
    },
  },

  'fast-track': {
    description: 'Minor tasks — config changes, copy edits, small additions. Skips team review, security audit, and ceremony.',
    features: {
      playwright_cli: true,   // screenshot verification against Pencil designs
    },
    roles: {
      review: [
        { role: 'Architect', skill: 'architect', command: 'architect.md' },
      ],
      execution: [
        { role: 'Frontend Dev', skill: 'frontend_dev', command: 'frontend_dev.md', branch_prefix: 'agent-frontend', worktree: true },
        { role: 'Backend Dev', skill: 'backend_dev', command: 'backend_dev.md', branch_prefix: 'agent-backend', worktree: true },
      ],
      standalone: [
        { role: 'PM', skill: 'pm', command: 'pm.md' },
        { role: 'QA', skill: 'qa', command: 'qa.md' },
      ],
    },
    workflow: {
      // PM writes a scoped spec — no CEO synthesis, no owner consultations, no companion specs
      kickoff: ['pm_scoping', 'devops_init'],
      // Single Architect pass — no pm_fix round, no companion specs
      review: ['pm_draft', 'reviewing'],
      // Lean execution — no dedicated qa_tests step (write tests inline), no security audit, no demo review
      execution: ['planning', 'task_execution', 'merge_for_review', 'qa_validation', 'ac_verification', 'merge_to_main'],
    },
    step_models: {
      reviewing: 'sonnet',
      qa_validation: 'sonnet', ac_verification: 'sonnet',
      planning: 'sonnet',       // minor tasks don't warrant deep planning
      task_execution: 'sonnet',
      fix_plan: 'sonnet', fix_execution: 'sonnet',
      devops_init: 'sonnet',
      merge_for_review: 'sonnet', merge_to_main: 'sonnet',
      pm_draft: 'sonnet', pm_scoping: 'sonnet',
    },
  },

  'solo': {
    description: 'Lean solo-dev execution — TDD test matrix up front, one monolithic Opus dev agent, cross-model code review (pick Codex as the reviewer CLI at run start), QA gate, merge. Kickoff/review/onboarding stay full; only execution is slimmed (no planner agent under the monolithic default, no coverage/AC/security/final-review steps).',
    features: {
      playwright_cli: true,
    },
    roles: {
      review: [
        { role: 'Brand', skill: 'brand', command: 'brand.md' },
        { role: 'Marketing', skill: 'marketing', command: 'marketing.md' },
        { role: 'UX', skill: 'ux', command: 'ux.md' },
        { role: 'Architect', skill: 'architect', command: 'architect.md' },
        { role: 'Security', skill: 'security', command: 'security.md' },
        { role: 'QA', skill: 'qa_review', command: 'qa_review.md' },
      ],
      // Monolithic task_execution assigns the FIRST execution role as the
      // builder — order matters. Projects override this list with their
      // primary dev role first (e.g. iOS Dev for mobile projects).
      execution: [
        { role: 'Frontend Dev', skill: 'frontend_dev', command: 'frontend_dev.md', branch_prefix: 'agent-frontend', worktree: true },
        { role: 'Backend Dev', skill: 'backend_dev', command: 'backend_dev.md', branch_prefix: 'agent-backend', worktree: true },
      ],
      standalone: [
        { role: 'PM', skill: 'pm', command: 'pm.md' },
        { role: 'QA', skill: 'qa', command: 'qa.md' },
        { role: 'CEO', skill: 'ceo', command: 'ceo.md' },
        { role: 'DevOps', skill: 'devops', command: 'devops.md' },
        { role: 'Designer', skill: 'designer', command: 'designer.md' },
        { role: 'Code Review', skill: 'code_reviewer', command: 'code_reviewer.md' },
      ],
    },
    workflow: {
      kickoff: ['ceo_synthesis', 'pm_scoping', 'owner_consultations', 'team_review', 'pm_revision', 'companion_specs', 'devops_init'],
      review: ['pm_draft', 'reviewing', 'pm_fix', 'companion_specs'],
      onboarding: ['discovery', 'ceo_synthesis', 'architect_backfill', 'pm_synthesis', 'devops_detect', 'team_review', 'pm_revision', 'owner_signoff'],
      // Lean execution: independent TDD matrix (qa_tests) → monolithic build →
      // mechanical merge+scans → code_review (runtime-inserted after
      // merge_for_review; run it on Codex for cross-model eyes) → QA suite gate
      // → merge. qa_validation routes straight to merge_to_main via the
      // preset-driven next-step computation.
      execution: ['qa_tests', 'planning', 'task_execution', 'merge_for_review', 'qa_validation', 'merge_to_main', 'capture_learnings'],
    },
    step_models: {
      reviewing: 'sonnet', qa_tests: 'sonnet', team_review: 'sonnet', capture_learnings: 'sonnet',
      code_review: 'opus',       // applies when reviewing with Claude; ignored when reviewerCli=codex
      qa_validation: 'sonnet',
      planning: 'opus',          // unused under the monolithic default (plan synthesized inline)
      task_execution: 'opus',    // the point of this preset: Opus 4.8 builds the whole PRD in one context
      fix_plan: 'opus', fix_execution: 'opus', // fixes are build work — same tier as the builder
      owner_consultations: 'sonnet', devops_init: 'sonnet',
      merge_for_review: 'sonnet', merge_to_main: 'sonnet',
      pm_draft: 'opus', pm_fix: 'opus', pm_scoping: 'opus', pm_revision: 'opus',
      ceo_synthesis: 'opus', companion_specs: 'opus',
      discovery: 'sonnet', architect_backfill: 'opus', pm_synthesis: 'opus', devops_detect: 'sonnet',
    },
    // Per-step --effort. Effort is the quality knob for the model's thinking
    // depth: keep HIGH (explicit, matches the model default) wherever judgment
    // gates the run — matrix design, review panels, QA triage, code review —
    // and dial DOWN only genuinely mechanical steps, where effort saves output
    // tokens with nothing to lose. xhigh stays an Opus-only per-project
    // override (e.g. example-ios/example-app set task_execution: xhigh in config.yaml;
    // project step_efforts win over these).
    step_efforts: {
      qa_tests: 'high', reviewing: 'high', team_review: 'high',
      qa_validation: 'high', code_review: 'high',
      capture_learnings: 'medium',                 // curator distills — bounded judgment
      devops_init: 'low', discovery: 'low', devops_detect: 'low',
      merge_for_review: 'low', merge_to_main: 'low', // no-agent steps today; harmless guard if they grow agents
    },
  },
};

const PRESET_LOOKUP_DIRS = (projectRoot) => [
  projectRoot && path.join(projectRoot, '.build-studio', 'presets'),
  path.join(os.homedir(), '.build-studio', 'presets'),
].filter(Boolean);

/**
 * Load a preset from YAML files in lookup dirs, or fall back to built-ins.
 * Returns { preset, source } where source is 'project', 'user', or 'builtin'.
 */
function loadPresetDefinition(presetName, projectRoot = null) {
  for (const dir of PRESET_LOOKUP_DIRS(projectRoot)) {
    const filePath = path.join(dir, `${presetName}.yaml`);
    if (fs.existsSync(filePath)) {
      try {
        const raw = yaml.load(fs.readFileSync(filePath, 'utf8'));
        const source = dir.includes('.build-studio/presets') && projectRoot && dir.startsWith(projectRoot)
          ? 'project'
          : 'user';
        return { preset: raw, source };
      } catch (e) {
        throw new Error(`Failed to parse preset file ${filePath}: ${e.message}`);
      }
    }
  }
  if (PRESETS[presetName]) return { preset: PRESETS[presetName], source: 'builtin' };
  return null;
}

/**
 * Resolve a preset with project overrides.
 *
 * @param {string} presetName - Name of the preset
 * @param {object} overrides - Project-level overrides from config.yaml
 * @param {string|null} projectRoot - Project root for custom preset lookup
 * @returns {{ roles, workflow, step_models }}
 */
function resolvePreset(presetName, overrides = {}, projectRoot = null) {
  const found = loadPresetDefinition(presetName, projectRoot);
  if (!found) {
    const builtinNames = Object.keys(PRESETS).join(', ');
    throw new Error(`Unknown workflow preset: "${presetName}". Built-in presets: ${builtinNames}`);
  }
  const { preset } = found;

  // --- Resolve roles ---
  let roles = JSON.parse(JSON.stringify(preset.roles)); // deep copy

  if (overrides.roles) {
    // Full replacement per category
    for (const cat of ['review', 'execution', 'standalone']) {
      if (Array.isArray(overrides.roles[cat])) {
        roles[cat] = overrides.roles[cat];
      }
    }

    // Add roles
    if (overrides.roles.add) {
      for (const cat of ['review', 'execution', 'standalone']) {
        if (Array.isArray(overrides.roles.add[cat])) {
          roles[cat] = [...roles[cat], ...overrides.roles.add[cat]];
        }
      }
    }

    // Remove roles by name
    if (Array.isArray(overrides.roles.remove)) {
      const removeSet = new Set(overrides.roles.remove.map(r => r.toLowerCase()));
      for (const cat of ['review', 'execution', 'standalone']) {
        roles[cat] = roles[cat].filter(r => !removeSet.has(r.role.toLowerCase()));
      }
    }
  }

  // --- Resolve workflow ---
  let workflow = JSON.parse(JSON.stringify(preset.workflow));

  if (overrides.workflow) {
    for (const flow of ['kickoff', 'review', 'execution']) {
      if (!overrides.workflow[flow]) continue;

      const flowOverride = overrides.workflow[flow];

      // Full replacement (array)
      if (Array.isArray(flowOverride)) {
        workflow[flow] = flowOverride;
        continue;
      }

      // Add steps (append by default, or insert after a specific step)
      if (Array.isArray(flowOverride.add)) {
        for (const item of flowOverride.add) {
          if (typeof item === 'string') {
            workflow[flow].push(item);
          } else if (item.step && item.after) {
            const idx = workflow[flow].indexOf(item.after);
            if (idx >= 0) workflow[flow].splice(idx + 1, 0, item.step);
            else workflow[flow].push(item.step);
          } else if (item.step && item.before) {
            const idx = workflow[flow].indexOf(item.before);
            if (idx >= 0) workflow[flow].splice(idx, 0, item.step);
            else workflow[flow].unshift(item.step);
          }
        }
      }

      // Remove steps
      if (Array.isArray(flowOverride.remove)) {
        const removeSet = new Set(flowOverride.remove);
        workflow[flow] = workflow[flow].filter(s => !removeSet.has(s));
      }
    }
  }

  // --- Resolve step_models ---
  const step_models = { ...preset.step_models, ...(overrides.step_models || {}) };

  // --- Resolve step_efforts (per-step --effort for Claude agents; shallow
  // merge, project config wins — e.g. example-ios keeps task_execution: xhigh) ---
  const step_efforts = { ...(preset.step_efforts || {}), ...(overrides.step_efforts || {}) };

  // --- Resolve features ---
  const features = { ...(preset.features || {}), ...(overrides.features || {}) };

  return { roles, workflow, step_models, step_efforts, features, preset: presetName, presetDescription: preset.description };
}

/**
 * List all available presets: custom (project + user) + built-ins.
 *
 * @param {string|null} projectRoot - Project root to include project-level presets
 */
function listPresets(projectRoot = null) {
  const seen = new Set();
  const result = [];

  // Collect custom presets from lookup dirs
  for (const dir of PRESET_LOOKUP_DIRS(projectRoot)) {
    if (!fs.existsSync(dir)) continue;
    const source = projectRoot && dir.startsWith(projectRoot) ? 'project' : 'user';
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml')); } catch (_) { continue; }
    for (const file of files) {
      const name = path.basename(file, '.yaml');
      if (seen.has(name)) continue;
      seen.add(name);
      try {
        const p = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
        result.push({
          name,
          source,
          description: p.description || '',
          roles: {
            review: (p.roles?.review || []).map(r => r.role),
            execution: (p.roles?.execution || []).map(r => r.role),
            standalone: (p.roles?.standalone || []).map(r => r.role),
          },
          workflow: p.workflow || {},
        });
      } catch (e) {
        console.warn(`[presets] Failed to parse preset file ${path.join(dir, file)}: ${e.message}`);
      }
    }
  }

  // Built-in presets (skip names already provided by custom)
  for (const [name, p] of Object.entries(PRESETS)) {
    if (seen.has(name)) continue;
    result.push({
      name,
      source: 'builtin',
      description: p.description,
      roles: {
        review: p.roles.review.map(r => r.role),
        execution: p.roles.execution.map(r => r.role),
        standalone: p.roles.standalone.map(r => r.role),
      },
      workflow: p.workflow,
    });
  }

  return result;
}

module.exports = { PRESETS, resolvePreset, listPresets, loadPresetDefinition };
