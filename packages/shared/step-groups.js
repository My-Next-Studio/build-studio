'use strict';

/**
 * Which workflow steps share a CLI / model / effort setting.
 *
 * Agents used to be configured per ROLE — a Default slot, a Developer slot and
 * a Reviewer slot. That cut across the grain of the actual decision: what you
 * want from a model depends on what the STEP is doing, not on the job title of
 * the agent doing it. The `reviewing` step, for instance, ran Security on the
 * reviewer slot and Brand on the default slot purely because of their role
 * names, though both are doing the same kind of work on the same PRD.
 *
 * The other extreme — a slot per step — is unusable: ~25 steps across five
 * workflow types, most of which you would set identically.
 *
 * So: groups. The grouping is a judgement about which steps you would plausibly
 * configure the same way, and reasonable people will disagree, which is exactly
 * why THIS FILE ONLY SUPPLIES THE DEFAULT. The mapping lives in config
 * (`step_groups`), at both the installation and project level, so anyone can
 * regroup — split the expensive backstop out of Review, add a cheap bucket for
 * mechanical steps — without touching code.
 *
 * Steps that launch no agent are deliberately absent: the human gates
 * (owner_consultations, owner_signoff, demo_review, device_testing) and the
 * mechanical git steps (merge_for_review, merge_to_main). They have no model to
 * pick, so offering one would be a lie.
 */

/**
 * The shipped default. Ordered — the UI renders groups in this order.
 *
 * `plan`   — turns ambiguity into a written decision. Low volume, high
 *            consequence: `planning` decomposes a PRD into 8-25 sized,
 *            sequenced, role-assigned tasks, and getting that wrong costs the
 *            whole run. Cheap to run a strong model here.
 * `build`  — writes code into the repo. Wants the strongest coding model and
 *            the largest context, and is the group most likely to sit on a
 *            different CLI from everything else.
 * `review` — judges work that already exists. The bulk of token spend (a
 *            review workflow fans out six of these per round), and the one
 *            place cross-model diversity is the point: a reviewer sharing the
 *            builder's model shares its blind spots.
 */
const DEFAULT_STEP_GROUPS = [
  {
    key: 'plan',
    label: 'Plan & specify',
    hint: 'PRDs, specs, decomposition — reasoning-heavy, low volume',
    steps: [
      'ceo_synthesis', 'pm_scoping', 'pm_draft', 'pm_revision', 'pm_fix',
      'pm_synthesis', 'discovery', 'architect_backfill', 'companion_specs',
      'planning', 'fix_plan',
    ],
  },
  {
    key: 'build',
    label: 'Build',
    hint: 'writes code into the repo — implementation, fixes, tests, scaffolding',
    steps: ['task_execution', 'fix_execution', 'qa_tests', 'devops_init', 'devops_detect'],
  },
  {
    key: 'review',
    label: 'Review & verify',
    hint: 'judges existing work — reviews, audits, QA, verification, learnings',
    steps: [
      'reviewing', 'team_review', 'code_review', 'security_audit',
      'qa_validation', 'ac_verification', 'coverage_matrix', 'final_review',
      'capture_learnings',
    ],
  },
];

/** A group key must be usable as a config key and a DOM id. */
const GROUP_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;

/**
 * Validate and normalize a `step_groups` definition from config.
 *
 * Falls back to the shipped default when the value is absent or unusable —
 * a malformed grouping must never leave steps unconfigurable. Individual bad
 * entries are dropped rather than failing the whole set.
 *
 * @param {unknown} raw  array form `[{key,label,hint,steps}]`, or object form
 *                       `{ key: { label, hint, steps } }`
 * @returns {{key:string,label:string,hint:string,steps:string[]}[]}
 */
function normalizeStepGroups(raw) {
  let entries = [];
  if (Array.isArray(raw)) {
    entries = raw.map((g) => (g && typeof g === 'object' ? { ...g } : null)).filter(Boolean);
  } else if (raw && typeof raw === 'object') {
    entries = Object.entries(raw).map(([key, v]) => (v && typeof v === 'object' ? { key, ...v } : null)).filter(Boolean);
  } else {
    return DEFAULT_STEP_GROUPS.map(cloneGroup);
  }

  const seen = new Set();
  const out = [];
  for (const g of entries) {
    const key = typeof g.key === 'string' ? g.key.trim() : '';
    if (!GROUP_KEY_RE.test(key) || seen.has(key)) continue;
    const steps = Array.isArray(g.steps)
      ? [...new Set(g.steps.filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim()))]
      : [];
    seen.add(key);
    out.push({
      key,
      label: typeof g.label === 'string' && g.label.trim() ? g.label.trim() : key,
      hint: typeof g.hint === 'string' ? g.hint : '',
      steps,
    });
  }
  return out.length ? out : DEFAULT_STEP_GROUPS.map(cloneGroup);
}

function cloneGroup(g) {
  return { key: g.key, label: g.label, hint: g.hint, steps: [...g.steps] };
}

/**
 * Which group a step belongs to.
 *
 * A step listed in more than one group belongs to the first — the definition is
 * ordered, so "first wins" is predictable rather than arbitrary. A step in no
 * group returns null, and the caller falls back to the block-level default,
 * which is what keeps a newly-added step runnable before anyone has grouped it.
 *
 * @returns {string|null} group key
 */
function groupForStep(stepKey, groups) {
  if (!stepKey) return null;
  for (const g of groups || []) {
    if (g && Array.isArray(g.steps) && g.steps.includes(stepKey)) return g.key;
  }
  return null;
}

/** Every step named by a grouping — used to spot steps nobody has assigned. */
function groupedSteps(groups) {
  const out = new Set();
  for (const g of groups || []) for (const s of g.steps || []) out.add(s);
  return out;
}

module.exports = {
  DEFAULT_STEP_GROUPS, GROUP_KEY_RE,
  normalizeStepGroups, groupForStep, groupedSteps,
};
