// Agent CLI support — single source of truth for the claude / codex / opencode
// switch. Consumed by project-server (launch path, validation, API) and shared
// with nothing Electron-specific so it stays plain CommonJS.
//
// Three concerns live here:
//   1. Installation-wide availability — ~/.build-studio/config.json
//      `enabled_clis` (which CLIs the operator offers) + binary auto-detection.
//   2. Role classification — which roles follow the per-run developerCli /
//      reviewerCli knobs (mirrors presets.js roles.execution / reviewer steps).
//   3. Per-role resolution — which CLI a given agent in a given workflow run
//      actually launches on, falling back to the project's default CLI.

const fs = require('fs');
const path = require('path');
const { BUILD_STUDIO_DIR } = require('./constants');

// Claude model ids — the canonical map (moved from project-server workflow.js
// so the hub's catalog endpoint can serve the picker list). Keys are the
// config-facing short names; values are the CLI ids passed to --model.
// `opus` and `opus[1m]` resolve to 4.8 (promoted 2026-05-29 after the PRD-009
// orchestration-matrix re-run on 4.8). Configs that say `opus`/`opus[1m]`
// auto-upgrade. `sonnet`/`sonnet[1m]` resolve to Sonnet 5 (promoted 2026-07-01).
// Explicit-version aliases let a config pin a specific generation.
const MODEL_IDS = {
  opus: 'claude-opus-4-8',
  sonnet: 'claude-sonnet-5',
  fable: 'claude-fable-5',
  'opus[1m]': 'claude-opus-4-8[1m]',
  'sonnet[1m]': 'claude-sonnet-5[1m]',
  // Fable 5's 1M window is its default tier; the [1m] alias is kept so
  // configs read uniformly across model families.
  'fable[1m]': 'claude-fable-5[1m]',
  'opus4.7': 'claude-opus-4-7',
  'opus4.7[1m]': 'claude-opus-4-7[1m]',
  'opus4.8': 'claude-opus-4-8',
  'opus4.8[1m]': 'claude-opus-4-8[1m]',
  'sonnet4.6': 'claude-sonnet-4-6',
  'sonnet4.6[1m]': 'claude-sonnet-4-6[1m]',
  'sonnet5': 'claude-sonnet-5',
  'sonnet5[1m]': 'claude-sonnet-5[1m]',
};
const CLAUDE_MODELS = Object.keys(MODEL_IDS);

// Effort options per CLI. Claude: the documented --effort values (xhigh is
// Opus-only — the UI filters it for non-opus models). Codex: fallback
// reasoning efforts when a model carries no variants in the catalog
// (models.dev openai/* reasoning_options are authoritative when present).
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_DEFAULT_EFFORTS = ['low', 'medium', 'high'];

const VALID_CLIS = ['claude', 'codex', 'opencode'];
const HUB_CONFIG_PATH = path.join(BUILD_STUDIO_DIR, 'config.json');

function loadHubConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(HUB_CONFIG_PATH, 'utf8'));
    const enabled = Array.isArray(raw.enabled_clis)
      ? raw.enabled_clis.filter(c => VALID_CLIS.includes(c))
      : null;
    return { ...raw, enabled_clis: enabled && enabled.length ? enabled : null, _fromFile: true };
  } catch (_) {
    return { enabled_clis: null, _fromFile: false };
  }
}

// Which CLIs the hub offers and the server accepts.
//   config file present → its enabled_clis list (operator override)
//   no config file      → every CLI whose binary is detected (claude always
//                         included as the historical default) — this exactly
//                         preserves pre-multi-CLI behaviour: claude + codex
//                         for people who had codex, claude-only otherwise,
//                         and opencode appears only where it's installed.
function resolveEnabledClis() {
  const cfg = loadHubConfig();
  if (cfg._fromFile && cfg.enabled_clis) return cfg.enabled_clis;
  const detected = detectClis();
  const found = VALID_CLIS.filter(c => detected[c]);
  return found.includes('claude') ? found : ['claude', ...found];
}

function saveHubConfig(cfg) {
  fs.mkdirSync(BUILD_STUDIO_DIR, { recursive: true });
  const merged = { ...loadHubConfig(), ...cfg };
  const tmp = `${HUB_CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, HUB_CONFIG_PATH);
  return merged;
}

// Probe a CLI binary the same env the start-*.sh scripts use (zsh + brew
// shellenv), with absolute-path fallbacks. Returns the resolved path or null.
// Cheap enough to call per API request (zsh spawn ~10ms).
function detectCliBinary(bin) {
  const { execFileSync } = require('child_process');
  try {
    execFileSync('zsh', ['-c', `eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null; command -v ${bin} >/dev/null`], { stdio: 'pipe' });
    return bin; // on PATH via shellenv
  } catch (_) {}
  const candidates = [
    `/opt/homebrew/bin/${bin}`,
    `/usr/local/bin/${bin}`,
    `${process.env.HOME || ''}/.npm-global/bin/${bin}`,
    `${process.env.HOME || ''}/.local/bin/${bin}`,
  ];
  return candidates.find(p => p && fs.existsSync(p)) || null;
}

function detectClis() {
  const out = {};
  for (const cli of VALID_CLIS) out[cli] = detectCliBinary(cli);
  return out;
}

// Execution-category developer roles whose CLI follows the per-run
// wf.developerCli knob. Mirrors presets.js → roles.execution — if a developer
// role is added to a preset, add it here too.
const DEVELOPER_ROLE_NAMES = new Set(['Frontend Dev', 'Backend Dev', 'Fullstack Dev', 'iOS Dev', 'Android Dev']);

// Reviewer roles whose CLI follows the per-run wf.reviewerCli knob (execution
// runs only — cross-model review of *code*). Covers code_review (Code
// Reviewer) and security_audit (Security).
const REVIEWER_ROLE_NAMES = new Set(['Code Reviewer', 'Security']);

function isDeveloperRole(roleName) {
  return DEVELOPER_ROLE_NAMES.has(roleName);
}

function isReviewerRole(roleName) {
  return REVIEWER_ROLE_NAMES.has(roleName);
}

// Which CLI launches a given agent role in a given workflow run.
//   developer role          → run's legacy developerCli (in-flight runs only),
//                             then cli.developer_cli, then cli.default
//   reviewer role (execution) → run's legacy reviewerCli, then cli.reviewer_cli,
//                             then cli.default
//   everything else         → cli.default
// Per-run developerCli/reviewerCli pickers were removed (2026-07-21) in favor
// of the per-role selectors on the Agents tab; legacy wf fields are still
// honored so in-flight runs keep their assignment.
function resolveCliForRole(roleName, wf, cliConfig) {
  const cfg = cliConfig || {};
  const projectDefault = cfg.default || 'claude';
  if (isDeveloperRole(roleName)) return wf.developerCli || cfg.developer_cli || projectDefault;
  if (isReviewerRole(roleName) && wf.type === 'execution') {
    return wf.reviewerCli || cfg.reviewer_cli || projectDefault;
  }
  return projectDefault;
}

// Model strings are CLI-namespaced: opencode ids are provider-scoped
// ('openrouter/moonshotai/kimi-k3' — always contain '/'), while claude short
// names ('opus', 'sonnet5') and codex slugs ('gpt-5.2-codex') never do. A
// mismatched pair (e.g. a hand-edited config with an opencode id on a claude
// row) must never reach a CLI flag — return false so resolution drops it.
function isModelCompatibleWithCli(cli, model) {
  if (model === null || model === undefined) return true;
  if (typeof model !== 'string') return false;
  return cli === 'opencode' ? model.includes('/') : !model.includes('/');
}

// The model for a role, from the project's cli block. The slot semantics are
// CLI-agnostic (a row holds whatever model fits its selected CLI): developer
// uses only its dedicated selector, reviewer falls back to default, every
// other role uses default. Returns null when unset or incompatible with the
// resolved CLI — no model flag is passed and the CLI uses its own default.
function resolveModelForRole(cli, roleName, wf, cliConfig) {
  if (!cliConfig) return null;
  let v;
  if (isDeveloperRole(roleName)) v = cliConfig.developer_model || null;
  else if (isReviewerRole(roleName) && wf.type === 'execution') v = cliConfig.reviewer_model || cliConfig.default_model || null;
  else v = cliConfig.default_model || null;
  return isModelCompatibleWithCli(cli, v) ? v : null;
}

// Effort tokens go straight onto a shell command line (`opencode run --variant
// <x>`) — accept only plain word characters (low, high, max, minimal, xhigh…).
const EFFORT_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,31}$/;
function isValidEffortToken(v) {
  return typeof v === 'string' && EFFORT_TOKEN_RE.test(v);
}

// ── Global (installation-wide) agent-CLI defaults ───────────────────────────
// Stored in ~/.build-studio/config.json under `cli`. A project opts into them
// via its local.json cli block (use_global: true) — the project's own values
// stay stored and return when the toggle is switched off.

// Shape a raw cli block (any source) into the canonical 9-field form, nulls
// for unset. `default: null` means "not configured globally" — callers merge
// over their own fallback (CLI_DEFAULTS.claude at project level).
function normalizeCliBlock(raw) {
  const b = raw && typeof raw === 'object' ? raw : {};
  return {
    default: VALID_CLIS.includes(b.default) ? b.default : null,
    developer_cli: VALID_CLIS.includes(b.developer_cli) ? b.developer_cli : null,
    reviewer_cli: VALID_CLIS.includes(b.reviewer_cli) ? b.reviewer_cli : null,
    default_model: typeof b.default_model === 'string' ? b.default_model : null,
    developer_model: typeof b.developer_model === 'string' ? b.developer_model : null,
    reviewer_model: typeof b.reviewer_model === 'string' ? b.reviewer_model : null,
    default_effort: isValidEffortToken(b.default_effort) ? b.default_effort : null,
    developer_effort: isValidEffortToken(b.developer_effort) ? b.developer_effort : null,
    reviewer_effort: isValidEffortToken(b.reviewer_effort) ? b.reviewer_effort : null,
  };
}

// Does a global cli block carry any configured value? An all-null block is
// "not set" — projects in use_global mode then keep their own values.
function hasGlobalCliDefaults(globalCli) {
  const b = normalizeCliBlock(globalCli);
  return Object.values(b).some(v => v !== null);
}

// Merge the global block OVER a base defaults object, skipping nulls so unset
// global fields keep the base's value. Returns a fresh 7-field block.
function mergeGlobalCli(base, globalCli) {
  const b = normalizeCliBlock(globalCli);
  const out = { ...base };
  for (const [k, v] of Object.entries(b)) if (v !== null) out[k] = v;
  return out;
}

// The effort for a role, from the project's cli block — CLI-agnostic token
// (claude --effort, opencode --variant, codex -c model_reasoning_effort=).
// Mirrors resolveModelForRole's slot semantics. Returns null when
// unset/invalid — no effort flag is passed and the CLI uses its own default.
function resolveEffortForRole(roleName, wf, cliConfig) {
  if (!cliConfig) return null;
  let v;
  if (isDeveloperRole(roleName)) v = cliConfig.developer_effort || null;
  else if (isReviewerRole(roleName) && wf.type === 'execution') v = cliConfig.reviewer_effort || cliConfig.default_effort || null;
  else v = cliConfig.default_effort || null;
  return isValidEffortToken(v) ? v : null;
}

// Canonical empty slot defaults (mirrors project-server CLI_DEFAULTS, without
// use_global). Used by resolveEffectiveCliConfig + tests.
const CLI_SLOT_DEFAULTS = {
  default: 'claude',
  developer_cli: null, reviewer_cli: null,
  default_model: null, developer_model: null, reviewer_model: null,
  default_effort: null, developer_effort: null, reviewer_effort: null,
};

/**
 * Effective cli block a project-server would put on `config.cli` after loading
 * yaml + local.json + (optionally) the installation-wide global block.
 * Pure — unit-tested in place of "start a tmux agent and inspect flags".
 *
 * @param {{ localCli?: object, yamlCli?: object, globalCli?: object }} layers
 */
function resolveEffectiveCliConfig({ localCli, yamlCli, globalCli } = {}) {
  const local = localCli || {};
  if (local.use_global === true && hasGlobalCliDefaults(globalCli)) {
    return { ...mergeGlobalCli(CLI_SLOT_DEFAULTS, globalCli), use_global: true };
  }
  const merged = { ...CLI_SLOT_DEFAULTS, ...(yamlCli || {}), ...local };
  if (!VALID_CLIS.includes(merged.default)) merged.default = 'claude';
  // Drop use_global from the effective shape when it's false/null so consumers
  // looking at use_global === true only treat global mode as active.
  return merged;
}

/**
 * Which account-usage providers are relevant for a cli block — the default
 * slot plus developer/reviewer (falling back to default when unset). Used by
 * the compact usage meter on the workflow panel and the Model tabs.
 *   claude   → 'claude'
 *   codex    → 'codex'
 *   opencode → 'openrouter'
 * @returns {('claude'|'codex'|'openrouter')[]}
 */
function providersFromCliConfig(cliConfig) {
  const cfg = cliConfig || {};
  const def = VALID_CLIS.includes(cfg.default) ? cfg.default : 'claude';
  const slots = [
    def,
    VALID_CLIS.includes(cfg.developer_cli) ? cfg.developer_cli : def,
    VALID_CLIS.includes(cfg.reviewer_cli) ? cfg.reviewer_cli : def,
  ];
  const out = [];
  const seen = new Set();
  for (const cli of slots) {
    const p =
      cli === 'claude' ? 'claude' :
      cli === 'codex' ? 'codex' :
      cli === 'opencode' ? 'openrouter' : null;
    if (p && !seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
}

/**
 * Pure resolution of {cli, model, effort} + the flag fragments the launch
 * path attaches to each CLI's command line (step_models / step_efforts are
 * deliberately NOT applied here — those are step-level overrides layered by
 * the launcher on top of this result for claude).
 *
 * This is the function to unit-test whenever a "which settings does a new
 * tmux agent actually get?" checklist comes up.
 */
function resolveAgentLaunchSettings(roleName, wf, cliConfig) {
  const cli = resolveCliForRole(roleName, wf || {}, cliConfig);
  const model = resolveModelForRole(cli, roleName, wf || {}, cliConfig);
  const effort = resolveEffortForRole(roleName, wf || {}, cliConfig);
  let modelFlag = '';
  let effortFlag = '';
  if (cli === 'claude') {
    if (model) modelFlag = ` --model ${MODEL_IDS[model] || model}`;
    if (effort) effortFlag = ` --effort ${effort}`;
  } else if (cli === 'opencode') {
    if (model) modelFlag = ` -m ${model}`;
    if (effort) effortFlag = ` --variant ${effort}`;
  } else if (cli === 'codex') {
    if (model) modelFlag = ` --model ${model}`;
    if (effort) effortFlag = ` -c model_reasoning_effort=${effort}`;
  }
  return { cli, model, effort, modelFlag, effortFlag };
}

// Deterministic "auto" reviewer CLI: cross-model review is the point, so auto
// always picks a DIFFERENT CLI than the developer — the first enabled CLI
// (in VALID_CLIS order) that isn't the developer's. Returns the developer CLI
// unchanged when it's the only one enabled (same-CLI self-review is then
// unavoidable; the hub surfaces a warning for that case).
//
// SOURCE OF TRUTH: the server resolves 'auto' with this function at
// /workflow/start. The hub keeps a display-only mirror of this one-liner in
// components/workflow-view.tsx (autoReviewerCli) for its explainer text —
// if you change the rule, change both.
function resolveAutoReviewerCli(developerCli, enabledClis) {
  const enabled = (enabledClis || []).filter(c => VALID_CLIS.includes(c));
  if (!enabled.length) return developerCli; // degenerate input — no basis to flip
  return enabled.find(c => c !== developerCli) || developerCli;
}

module.exports = {
  VALID_CLIS,
  HUB_CONFIG_PATH,
  MODEL_IDS,
  CLAUDE_MODELS,
  CLAUDE_EFFORTS,
  CODEX_DEFAULT_EFFORTS,
  loadHubConfig,
  saveHubConfig,
  resolveEnabledClis,
  detectCliBinary,
  detectClis,
  DEVELOPER_ROLE_NAMES,
  REVIEWER_ROLE_NAMES,
  isDeveloperRole,
  isReviewerRole,
  resolveCliForRole,
  resolveModelForRole,
  isModelCompatibleWithCli,
  resolveEffortForRole,
  resolveEffectiveCliConfig,
  resolveAgentLaunchSettings,
  providersFromCliConfig,
  CLI_SLOT_DEFAULTS,
  isValidEffortToken,
  normalizeCliBlock,
  hasGlobalCliDefaults,
  mergeGlobalCli,
  resolveAutoReviewerCli,
};
