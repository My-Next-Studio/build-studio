const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { resolvePreset, PRESETS } = require('./presets');

const DEFAULTS = {
  docs_path: './docs',
  agent_defaults: { skip_permissions: true, unset_api_key: true, model: 'opus' },
  max_review_rounds: 4,
  review_mode: 'parallel',
  // builder_strategy: how the monolithic task_execution builder is driven.
  //   'role' — classic role-prompted session (default).
  //   'goal' — additionally arms Claude Code's native /goal harness on the
  //            builder session: the CLI re-checks the done-condition (full
  //            suite green + per-AC evidence table + feedback POSTed) after
  //            every response and keeps working until it is met. Claude-only,
  //            monolithic-only; ignored for Codex builders and fine-grained.
  builder_strategy: 'role',
  worktree_env_files: [],
  // Execution-phase recall gates (project-agnostic; see docs). All hot-reloaded.
  // coverage_matrix: ADVISORY post-implementation coverage check (non-blocking).
  //   The full spec-derived AC×variant matrix is enumerated + tested up front at
  //   qa_tests; this step only surfaces residual gaps (impl-introduced variants,
  //   silent drops). `variants` is an optional per-project taxonomy the critic uses.
  coverage_matrix: { variants: null },
  // final_review: independent recall-biased review run as a hard gate before the
  //   merge/demo gate. `effort` is the /code-review skill effort (low|medium|high|max).
  final_review: { effort: 'high' },
  // code_review: in-flow review effort (#2-lite — multi-angle, recall-biased).
  code_review: { effort: 'high' },
  // hygiene: mechanical pre-merge grep gate for test scaffolding leaked into prod
  //   source. `extra_patterns` are project-specific regexes; `allow` are path
  //   substrings or `path:regex` pairs exempted from the scan.
  hygiene: { enabled: true, extra_patterns: [], allow: [] },
  // learnings: capture is gated to signal-bearing runs by default ('failures' —
  //   runs with fix rounds, overrides, or gate trips; clean first-pass runs skip
  //   the curator). 'always' restores unconditional capture; 'off' disables.
  //   max_injected caps the Known Learnings entries per agent PROMPT (relevance-
  //   ranked); max_entries_per_domain caps the curator's per-domain file count.
  //   Agents self-report which entries they applied; never-applied entries are
  //   auto-archived after 30 injections.
  learnings: { enabled: true, capture: 'failures', max_injected: 6, max_entries_per_domain: 25, auto_capture: true },
  dev_commands: [],
  deployment: {
    strategy: 'trunk',           // trunk | gitflow
    versioning: 'semver',        // semver | calver | none
    auto_tag: true,              // create git tag on merge-to-main
    auto_deploy: false,          // push to remote after merge (triggers CD)
    tag_prefix: 'v',             // tag format: v1.2.3
    initial_version: '0.1.0',    // first tag if none exists
  },
  functions: {
    project: { enabled: true },
    development: { enabled: true },
    operations: { enabled: true },
  },
};

function loadConfig(projectRoot) {
  const configPath = path.join(projectRoot, '.build-studio', 'config.yaml');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}\nRun "build-studio init" to create a project.`);
  }

  let raw;
  try {
    raw = yaml.load(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse config: ${e.message}`);
  }

  if (!raw || typeof raw !== 'object') {
    throw new Error('Config file is empty or not a YAML object');
  }

  // Resolve preset if specified, otherwise use legacy format
  let roles, workflow, step_models, step_efforts, features, presetName;

  if (raw.preset) {
    // New format: preset-based config
    const resolved = resolvePreset(raw.preset, {
      roles: raw.roles,
      workflow: raw.workflow,
      step_models: raw.step_models,
      step_efforts: raw.step_efforts,
      features: raw.features,
    }, projectRoot);
    roles = resolved.roles;
    workflow = resolved.workflow;
    step_models = resolved.step_models;
    step_efforts = resolved.step_efforts;
    features = resolved.features;
    presetName = resolved.preset;
  } else if (raw.roles && (raw.roles.review || raw.roles.execution || raw.roles.standalone)) {
    // Legacy format: full role and workflow definitions inline
    roles = {
      review: raw.roles.review || [],
      execution: raw.roles.execution || [],
      standalone: raw.roles.standalone || [],
    };
    workflow = {
      kickoff: (raw.workflow && raw.workflow.kickoff) || PRESETS['web-app'].workflow.kickoff,
      review: (raw.workflow && raw.workflow.review) || PRESETS['web-app'].workflow.review,
      execution: (raw.workflow && raw.workflow.execution) || PRESETS['web-app'].workflow.execution,
    };
    step_models = { ...PRESETS['web-app'].step_models, ...(raw.step_models || {}) };
    step_efforts = raw.step_efforts || {};
    features = { ...PRESETS['web-app'].features, ...(raw.features || {}) };
    presetName = null;
  } else {
    // No roles defined — default to web-app preset
    const resolved = resolvePreset('web-app', {}, projectRoot);
    roles = resolved.roles;
    workflow = resolved.workflow;
    step_models = resolved.step_models;
    step_efforts = resolved.step_efforts;
    features = resolved.features;
    presetName = 'web-app';
  }

  const config = {
    ...DEFAULTS,
    ...raw,
    roles,
    workflow,
    step_models,
    step_efforts,
    features,
    preset: presetName,
    agent_defaults: { ...DEFAULTS.agent_defaults, ...(raw.agent_defaults || {}) },
    deployment: { ...DEFAULTS.deployment, ...(raw.deployment || {}) },
    functions: { ...DEFAULTS.functions, ...(raw.functions || {}) },
  };

  // Inferred default for `deployment.deployedOnPush` (PRD lifecycle status):
  // — true  when no manual ci_workflow is configured (push to main = deploy, example-site shape)
  // — false when ci_workflow is configured (push triggers CI but production deploy is a separate Deploy click, example-web shape)
  // Owner can override explicitly in config.yaml.
  if (config.deployment.deployedOnPush === undefined) {
    config.deployment.deployedOnPush = !config.deployment.ci_workflow;
  }

  // Validation
  const errors = [];
  if (!config.name || typeof config.name !== 'string') {
    errors.push('Missing required field: name (string)');
  }
  if (!config.port || typeof config.port !== 'number' || config.port < 1024 || config.port > 65535) {
    errors.push('Missing or invalid field: port (number 1024-65535)');
  }

  const allRoles = getAllRoles(config);
  for (const role of allRoles) {
    if (role.command) {
      const cmdPath = path.join(projectRoot, '.claude', 'commands', role.command);
      if (!fs.existsSync(cmdPath)) {
        console.warn(`[config] Warning: Role "${role.role}" references command "${role.command}" but file not found: ${cmdPath}`);
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Config validation failed:\n  - ${errors.join('\n  - ')}`);
  }

  config.projectRoot = projectRoot;
  config.docsPath = path.resolve(projectRoot, config.docs_path);
  config.tmpPath = path.join(projectRoot, 'tmp');
  config.worktreesPath = path.join(projectRoot, 'tmp', '.worktrees');
  config.logsPath = path.join(projectRoot, 'tmp', '.logs');
  config.statePath = path.join(projectRoot, '.build-studio');

  return config;
}

function getAllRoles(config) {
  return [
    ...(config.roles.review || []),
    ...(config.roles.execution || []),
    ...(config.roles.standalone || []),
  ];
}

function findRole(config, roleName, preferredCategory) {
  if (!roleName) return undefined;
  // Tolerate every form planners and reviewers actually emit:
  //   "Backend Dev"  → role name
  //   "backend_dev"  → skill name
  //   "/backend_dev" → skill invocation form
  //   "/Backend Dev" → defensive
  // Strip leading slash, lowercase, then match against either role name or skill.
  // Underscores in the input are treated as spaces so role names round-trip.
  const raw = roleName.replace(/^\//, '').toLowerCase();
  const spaced = raw.replace(/_/g, ' ');
  const matches = (r) => {
    const role = r.role.toLowerCase();
    const skill = (r.skill || '').toLowerCase();
    return role === raw || role === spaced || skill === raw || skill === spaced;
  };
  // When a name is duplicated across categories (e.g. mobile-app has BOTH
  // review:QA (skill: qa_review) and standalone:QA (skill: qa)), the caller's
  // intent disambiguates which one to use. Without `preferredCategory` we
  // return the first match across review→execution→standalone, preserving
  // pre-existing behaviour.
  if (preferredCategory && Array.isArray(config.roles?.[preferredCategory])) {
    const inCategory = config.roles[preferredCategory].find(matches);
    if (inCategory) return inCategory;
  }
  return getAllRoles(config).find(matches);
}

/**
 * Watch `.build-studio/config.yaml` and mutate the existing config object
 * in place when it changes — so downstream consumers (workflow router,
 * overseer, etc.) that captured the config reference at startup pick up
 * changes without a project-server restart.
 *
 * Fields that can't change at runtime (port, projectRoot, statePath) are
 * NOT updated even if the file is edited — they're set once and rebinding
 * would break in-flight HTTP connections / state file paths. Everything else
 * (step_strategies, step_models, step_efforts, agent_defaults, roles,
 * workflow.execution lists) is hot-swapped.
 *
 * Returns a function that stops the watcher.
 */
function watchConfig(config, onReload) {
  const configPath = path.join(config.projectRoot, '.build-studio', 'config.yaml');
  if (!fs.existsSync(configPath)) return () => {};

  let debounceTimer = null;
  const FROZEN_KEYS = new Set(['projectRoot', 'port', 'docsPath', 'tmpPath', 'worktreesPath', 'logsPath', 'statePath']);

  const onChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        const fresh = loadConfig(config.projectRoot);
        // Apply: replace mutable keys, preserve frozen ones, delete keys no longer present.
        for (const k of Object.keys(config)) {
          if (FROZEN_KEYS.has(k)) continue;
          if (!(k in fresh)) delete config[k];
        }
        for (const k of Object.keys(fresh)) {
          if (FROZEN_KEYS.has(k)) continue;
          config[k] = fresh[k];
        }
        console.log(`[config] hot-reloaded ${configPath} — step_strategies=${JSON.stringify(config.step_strategies || {})}, step_models keys=[${Object.keys(config.step_models || {}).join(',')}]`);
        if (typeof onReload === 'function') {
          try { onReload(config); } catch (e) { console.error('[config] onReload hook error:', e.message); }
        }
      } catch (e) {
        console.error(`[config] hot-reload failed (keeping previous config): ${e.message}`);
      }
    }, 200);
  };

  const watcher = fs.watch(configPath, { persistent: false }, onChange);
  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    try { watcher.close(); } catch (_) {}
  };
}

module.exports = { loadConfig, getAllRoles, findRole, DEFAULTS, watchConfig };
