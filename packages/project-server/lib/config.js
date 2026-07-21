const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { resolvePreset, PRESETS } = require('./presets');
const { VALID_CLIS, loadHubConfig, resolveEffectiveCliConfig } = require('@build-studio/shared/cli');

// Per-project agent-CLI defaults. `default` applies to every role NOT covered
// by the per-run developerCli/reviewerCli knobs (kickoff, onboarding, review
// workflow, QA, PM, CEO, planners, …). The three model fields are OpenCode
// `provider/model` strings used when the matching role resolves to opencode
// (null = let opencode use its own configured default model). Settable in
// config.yaml (`cli:`) and overridable from the hub — hub writes go to
// .build-studio/local.json (machine-managed, gitignored), never to config.yaml,
// so hand-maintained comments in config.yaml survive hub edits.
const CLI_DEFAULTS = {
  default: 'claude', developer_cli: null, reviewer_cli: null,
  default_model: null, developer_model: null, reviewer_model: null,
  default_effort: null, developer_effort: null, reviewer_effort: null,
};

const DEFAULTS = {
  docs_path: './docs',
  agent_defaults: { unset_api_key: true, model: 'opus' },
  cli: CLI_DEFAULTS,
  max_review_rounds: 4,
  review_mode: 'parallel',
  // builder_strategy: how the monolithic task_execution builder is driven.
  //   'role' — classic role-prompted session (default).
  //   'goal' — additionally arms Claude Code's native /goal harness on the
  //            builder session: the CLI re-checks the done-condition (full
  //            suite green + per-AC evidence table + feedback POSTed) after
  //            every response and keeps working until it is met. Claude-only,
  //            monolithic-only; ignored for Codex/OpenCode builders and fine-grained.
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
  // bugfix workflow: a lean execution flow driven by a Bug backlog item (no PRD,
  // no planning step, no review panel). auto_merge=true lands the fix
  // automatically once code_review approves instead of waiting at the manual
  // merge_to_main gate; default false keeps the merge a deliberate operator step.
  bugfix: { auto_merge: false },
  // support view: auto-commit filed items (pathspec-scoped, on the current
  // branch) so filings never wait on a manual Operations-tab commit.
  support: { auto_commit: true },
  // final_review: rounds past the owner-approved cap run in wrap-up mode
  // (closure contract — regressions block, fresh-lens findings file as
  // follow-up proposals). `effort` may also be set here (default 'high').
  final_review: { wrapup_past_cap: true },
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

// Machine-written per-project overrides (.build-studio/local.json). The hub's
// CLI settings card writes here; loadConfig merges this OVER config.yaml.
// Never hand-edited config.yaml — comments and formatting there are sacred.
// Returns {} when absent or unreadable (a corrupt local.json must not kill
// the project server — the yaml config remains authoritative).
function loadLocalOverrides(projectRoot) {
  const localPath = path.join(projectRoot, '.build-studio', 'local.json');
  try {
    const raw = JSON.parse(fs.readFileSync(localPath, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (_) {
    return {};
  }
}

// Atomic read-modify-write of local.json. `patch` is shallow-merged per
// top-level key (e.g. { cli: { default: 'opencode' } } merges into the
// existing cli block, preserving its other fields).
function saveLocalOverrides(projectRoot, patch) {
  const localPath = path.join(projectRoot, '.build-studio', 'local.json');
  const current = loadLocalOverrides(projectRoot);
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && current[k] && typeof current[k] === 'object') {
      current[k] = { ...current[k], ...v };
    } else {
      current[k] = v;
    }
  }
  const tmp = `${localPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, localPath);
  return current;
}

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

  // local.json overlays config.yaml (hub-written settings win).
  const local = loadLocalOverrides(projectRoot);

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
    agent_defaults: { ...DEFAULTS.agent_defaults, ...(raw.agent_defaults || {}), ...(local.agent_defaults || {}) },
    // Effective CLI block = yaml + local, or the installation-wide global
    // defaults when local.cli.use_global is true (shared/cli
    // resolveEffectiveCliConfig is the single source of truth — also unit-tested).
    cli: resolveEffectiveCliConfig({ localCli: local.cli, yamlCli: raw.cli, globalCli: loadHubConfig().cli }),
    deployment: { ...DEFAULTS.deployment, ...(raw.deployment || {}) },
    functions: { ...DEFAULTS.functions, ...(raw.functions || {}) },
    bugfix: { ...DEFAULTS.bugfix, ...(raw.bugfix || {}) },
    support: { ...DEFAULTS.support, ...(raw.support || {}) },
    final_review: { ...DEFAULTS.final_review, ...(raw.final_review || {}) },
  };

  // (use_global merge handled inside resolveEffectiveCliConfig above)
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
  if (!VALID_CLIS.includes(config.cli.default)) {
    console.warn(`[config] Warning: cli.default "${config.cli.default}" is not one of ${VALID_CLIS.join('/')} — falling back to 'claude'.`);
    config.cli.default = 'claude';
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
 * Re-apply a fresh loadConfig() onto the live config object in place — shared
 * by watchConfig (fs.watch on config.yaml + local.json) and the CLI-settings
 * API (which writes local.json then needs the change live immediately).
 */
function reloadConfig(config) {
  const fresh = loadConfig(config.projectRoot);
  const FROZEN_KEYS = new Set(['projectRoot', 'port', 'docsPath', 'tmpPath', 'worktreesPath', 'logsPath', 'statePath']);
  for (const k of Object.keys(config)) {
    if (FROZEN_KEYS.has(k)) continue;
    if (!(k in fresh)) delete config[k];
  }
  for (const k of Object.keys(fresh)) {
    if (FROZEN_KEYS.has(k)) continue;
    config[k] = fresh[k];
  }
  return config;
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
  const localPath = path.join(config.projectRoot, '.build-studio', 'local.json');
  if (!fs.existsSync(configPath)) return () => {};

  let debounceTimer = null;

  const onChange = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      try {
        reloadConfig(config);
        console.log(`[config] hot-reloaded ${configPath} — step_strategies=${JSON.stringify(config.step_strategies || {})}, step_models keys=[${Object.keys(config.step_models || {}).join(',')}]`);
        if (typeof onReload === 'function') {
          try { onReload(config); } catch (e) { console.error('[config] onReload hook error:', e.message); }
        }
      } catch (e) {
        console.error(`[config] hot-reload failed (keeping previous config): ${e.message}`);
      }
    }, 200);
  };

  const watchers = [fs.watch(configPath, { persistent: false }, onChange)];
  // local.json may not exist yet — watch the directory entry for it instead.
  // fs.watch on a missing file throws, so guard it.
  try { watchers.push(fs.watch(localPath, { persistent: false }, onChange)); } catch (_) {}
  return () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const w of watchers) { try { w.close(); } catch (_) {} }
  };
}

module.exports = { loadConfig, loadLocalOverrides, saveLocalOverrides, reloadConfig, getAllRoles, findRole, DEFAULTS, CLI_DEFAULTS, watchConfig };
