'use strict';

/**
 * The kickoff's agent prompts, and the Scaffold run's.
 *
 * Kept apart from the workflow router so tests can read what each step asks for
 * without driving a workflow.
 *
 * The kickoff used to assume every decision could be made at kickoff: the CEO
 * filled in every section of the vision, the Architect selected the stack, and
 * DevOps scaffolded and provisioned it. A project whose inputs deliberately
 * leave decisions open (the stack until an investigation reports, a feature's
 * details until it is drafted, a business model until it is tested) got those
 * decisions made for it anyway. DEFERRED_DECISIONS_RULE is the one statement of
 * how every kickoff step treats them.
 */

/** How kickoff steps treat open decisions that the inputs give a timing. */
const DEFERRED_DECISIONS_RULE = `## Decisions the inputs defer

The inputs may give open decisions a timing: settle at kickoff, settle when a feature is drafted, settle before a later phase. Respect that timing:

- **Kickoff decisions:** settle them, or leave them for the owner interview.
- **Decisions for when a feature is drafted:** do not settle them. Write each onto the backlog item it belongs to, at the end of its body, in this form:
  > **Open question from the kickoff inputs (<YYYY-MM-DD>) → owner:** <the question>. Ask when drafting this story.
  Until that backlog item exists, list the question in the Open Questions section of docs/vision.md, with its timing.
- **Decisions for a later phase:** list them in the Open Questions section of docs/vision.md, with the phase they belong to.
- **Choices that wait on an investigation or spike:** do not select, not even provisionally. Record the candidates, what the investigation must answer and the decision gate. Work that depends on the choice waits for it.
- **Hypotheses stay hypotheses.** A business model, price or later phase that the inputs call a hypothesis is not a decision. Write it as a hypothesis, with how it will be tested if the inputs say.

Where the inputs give no timing, decide as usual.`;

/** The same rule from a reviewer's side: a deferred decision is not a gap. */
const DEFERRED_DECISIONS_REVIEW_RULE = `**A decision the inputs defer is not a gap.** When the inputs time a decision for later (when a feature is drafted, a later phase, after an investigation or spike), an open question recorded for it is correct. Do not raise it as a finding or ask for it to be settled now. Do raise a deferred decision that was settled anyway, and a hypothesis presented as a decision.`;

function guideBlock(inputsGuide) {
  return inputsGuide ? `\n\n${inputsGuide}` : '';
}

function ceoSynthesisPrompt({ skill, inputsGuide, commitRule }) {
  return `You are the CEO/Strategist. Read the inputs in docs/inputs/ (how to read them is below) and produce docs/vision.md — the canonical vision document for this project. Use the /${skill} skill. Fill in each section of the vision template that the inputs support. Where the inputs leave a section open, say so in it rather than inventing an answer.

${DEFERRED_DECISIONS_RULE}${guideBlock(inputsGuide)}

Commit your changes. ${commitRule}`;
}

function pmScopingPrompt({ skill, inputsGuide, commitRule }) {
  return `You are the Product Manager. Read docs/vision.md and docs/inputs/ (how to read the inputs is below). Produce:
1. docs/project-state.md — fill in all template sections (roles, workflow, conventions); the backlog goes in docs/backlog-index.md (step 2)
2. The BACKLOG — use the PRD-004 per-item format, NOT a markdown table. For each planned iteration write a file docs/backlog/<PREFIX>-NNN.md with YAML frontmatter (id, title, type: Feature, status, release, created: null, prd, depends_on: [], cost_actual_usd: null) AND add a matching line "- <PREFIX>-NNN — Title  [Type · Status]" under a "### <Release>" heading between the <!-- BACKLOG-START -->/<!-- BACKLOG-END --> markers in docs/backlog-index.md (every item file MUST have a matching marker line, or it renders as nothing). <PREFIX> = a 2–4 letter uppercase code derived from the project name (e.g. example-graph → EG, example-web → EW), numbered 001+. The first item (the one you draft PRD-001 for) is status Drafted with its prd field set to docs/prds/PRD-001-*.md; the rest are status Backlog. See the /${skill} skill's backlog rules for exact steps.
3. docs/prds/PRD-001-*.md — the first iteration PRD. Start from docs/prds/TEMPLATE.md — copy it and fill it in.

${DEFERRED_DECISIONS_RULE}

For the backlog this means:
- Move each feature-timed question that docs/vision.md lists under Open Questions onto the item it belongs to, in the form above, and remove it from the vision once it is on an item.
- When the inputs call for an investigation or spike before a decision, add it as a backlog item (type Task), so the work is planned and visible. Items that depend on the decision list it in depends_on.
- The first PRD must not settle a decision the inputs defer. If the first iteration cannot start before such a decision, choose an iteration that can, or make PRD-001 the investigation itself.

While scoping, check docs/inputs/ for the owner's preference on visual design workflow. THREE options:
  (a) Pencil-controlled — designer authors .pen files; frontend_dev verifies via heatmap-diff
  (b) Claude Design — designer iterates in claude.ai/design; exports a handoff bundle to design-system/; frontend_dev invokes the bundle's SKILL skill and recreates from HTML prototypes (no heatmap-diff)
  (c) Agent-autonomous — no design source artifact; frontend_dev works from PRD + UX spec + brand-guidelines.md alone

If the input documents don't specify which, flag it in your feedback — the owner needs to decide. Record the decision in project-state.md under Project Conventions, e.g.:
  "Visual design workflow: Pencil-controlled"
  "Visual design workflow: Claude Design (bundle at design-system/)"
  "Visual design workflow: agent-autonomous"

The execution flow uses this convention to decide whether to include or skip the visual_design step and which verification protocol applies.${guideBlock(inputsGuide)}

Use the /${skill} skill. Commit your changes. ${commitRule}`;
}

/** What each companion-spec role produces at kickoff. */
const COMPANION_SPEC_ROLES = [
  { roleName: 'Brand', output: 'docs/brand/', desc: 'brand guidelines, identity, tone, and visual language' },
  { roleName: 'UX', output: 'docs/ux/', desc: 'UX principles, user flows, and interaction patterns' },
  { roleName: 'Marketing', output: 'docs/marketing/', desc: 'go-to-market direction and growth approach' },
  { roleName: 'Architect', output: 'docs/adrs/', desc: 'ADR-001: the tech stack and system architecture — or, when the inputs defer the stack, the pending decision (see below)' },
  { roleName: 'DevOps', output: 'docs/adrs/', desc: 'ADR-002: CI/CD pipeline and deployment strategy — the parts that do not wait on a deferred stack decision (see below)' },
];

const ARCHITECT_NOTE = `

Before deciding on deployment model, hosting, database, or other infrastructure: check docs/inputs/ for any information about what the owner already uses. Prefer reusing existing infrastructure over introducing new platforms. If the input documents do not mention the owner's current infrastructure, flag this in your feedback — the owner needs to provide this context before you can make well-informed decisions.

**When the inputs defer the stack.** If the inputs make the technology stack, or part of it, wait for an investigation, a spike or a later decision, do not select it, not even provisionally. Write ADR-001 with \`**Status:** Pending\` near the top, and record:
- the candidates;
- the evaluation criteria;
- the investigation: what it must answer, and who leads it;
- the decision gate: what evidence decides, and who approves;
- what is blocked until then (the scaffold and any provisioning are).
Once the decision is made, ADR-001 becomes Accepted and a Scaffold run (Project → Workflow) builds the scaffold. Nothing is scaffolded or provisioned while ADR-001 is Pending.`;

const DEVOPS_NOTE = `

Before deciding on CI/CD tooling: check docs/inputs/ for the owner's existing CI/CD setup. GitHub Actions is the default recommendation, but verify this matches the owner's preferences. Also determine whether CI/CD should be set up from the start or deferred while the project runs locally during early iterations. If the input documents don't clarify these points, flag them in your feedback — the owner needs to decide, and the PM needs this to plan which phase includes CI/CD setup.

**When the inputs defer the stack.** If the inputs make the technology stack wait for an investigation or a later decision (the Architect then writes ADR-001 as Pending, alongside you), write the parts of ADR-002 that do not depend on it, such as environments, branching and review gates, and the secrets policy, and mark the stack-dependent parts as pending on ADR-001. Do not choose CI tooling or a deployment target that presupposes a stack.`;

/** The companion_specs agents for the roles this project has. */
function companionSpecAgents({ findRole, config, inputsGuide, commitRule }) {
  const agents = [];
  for (const spec of COMPANION_SPEC_ROLES) {
    const role = findRole(config, spec.roleName);
    if (!role) continue;
    const roleNote = spec.roleName === 'Architect' ? ARCHITECT_NOTE : spec.roleName === 'DevOps' ? DEVOPS_NOTE : '';
    const readsInputs = spec.roleName === 'Architect' || spec.roleName === 'DevOps';
    agents.push({
      role: spec.roleName, window: spec.roleName.toLowerCase().slice(0, 12), status: 'pending', reportFeedback: true,
      instruction: `You are the ${spec.roleName}. Read docs/vision.md, docs/project-state.md, and the PRD in docs/prds/.${roleNote}

Produce ${spec.desc} in ${spec.output}.

${DEFERRED_DECISIONS_RULE}${readsInputs ? guideBlock(inputsGuide) : ''}

Use the /${role.skill} skill. Create concrete, actionable specs that the team can use immediately when starting the first PRD iteration — except where the inputs defer a decision: there, record the open decision precisely instead of filling it. Commit your changes. ${commitRule}`,
    });
  }
  return agents;
}

/** The features block DevOps reviews while scaffolding. */
function devopsFeaturesContext(config) {
  const presetFeatures = config.features || {};
  return `\n\n## PROJECT FEATURES CONFIGURATION\n\nThe project preset (${config.preset || 'web-app'}) provides default feature flags. Review these and override in \`.build-studio/config.yaml\` if the project's actual tech stack differs from the preset defaults.\n\nCurrent feature defaults from preset:\n- \`playwright_cli: ${presetFeatures.playwright_cli !== false}\` — browser screenshot verification against Pencil designs\n\n**Decision rule for playwright_cli:**\n- Set to \`true\` if the project has a web frontend that runs in a browser (SvelteKit, Next.js, React, Vue, etc.)\n- Set to \`false\` if the project is mobile-only (iOS/Android native), API-only, or has no browser-renderable UI\n\nIf the preset default is wrong for this project, add a \`features:\` section to \`.build-studio/config.yaml\`:\n\`\`\`yaml\nfeatures:\n  playwright_cli: false  # no web frontend to screenshot\n\`\`\`\n\nIf \`playwright_cli\` is \`true\`, ensure \`@playwright/cli\` is installed globally (\`npm install -g @playwright/cli\`).`;
}

/**
 * devops_init: scaffold (and, where the ADRs say, provision) the project.
 * `approvedPlan` is the Scaffold run's plan, approved by the owner; a kickoff
 * passes none and keeps the original instruction.
 */
function devopsInitPrompt({ skill, config, commitRule, approvedPlan }) {
  const plan = approvedPlan
    ? `\n\n## The plan the owner approved\n\nCarry out this plan. Creating, linking or provisioning anything it does not name needs the owner first: stop and report it in your feedback instead.\n\n${approvedPlan}`
    : '';
  return `You are DevOps. Read docs/project-state.md, docs/vision.md, the PRD in docs/prds/, and all ADRs in docs/adrs/.\n\nYour job is to initialize the project scaffold so that Frontend and Backend developers can start from a clean, working base — no duplicate scaffolding, no merge conflicts.\n\nBased on the ADRs and PRD, do what is needed:\n- Initialize the framework (e.g. create-next-app) if not already done\n- Set up deployment target (e.g. vercel link) if applicable\n- Provision storage/database if specified in ADRs\n- Install shared dependencies from ADRs (framework, DB client, CSS, fonts)\n- Create initial config files (tsconfig, eslint, tailwind, postcss, etc.)\n- Run DB migrations/schema if applicable\n- Set up environment variables template (.env.example)\n- In the project's CI workflow, add a step right after dependency install, run from the repo root: \`node scripts/check-docs-budget.mjs --self-test && node scripts/check-docs-budget.mjs\` (the script is already in scripts/; it keeps docs/project-state.md and ARCHITECTURE.md within their limits and fails on a path ARCHITECTURE.md names that doesn't exist)\n- If docs/project-state.md indicates "Visual design: Pencil-controlled", create an initial .pen file for the project using the Pencil MCP tools (open_document with 'new') so it is ready for the visual_design step in execution iterations\n- Commit a clean, building scaffold that passes lint\n\nIf the project is already scaffolded and no infra work is needed, report that and commit nothing.${plan}${devopsFeaturesContext(config)}\n\nUse the /${skill} skill. Commit your changes. ${commitRule}`;
}

/**
 * scaffold_plan: the Scaffold run's first step. DevOps writes down what it
 * would build and provision, and changes nothing; the owner approves the plan
 * before devops_init carries it out.
 */
function scaffoldPlanPrompt({ skill, adrFile }) {
  return `You are DevOps. ${adrFile ? `ADR-001 (\`${adrFile}\`)` : 'ADR-001'} has settled the technology stack. Before anything is built or provisioned, write the scaffold plan for the owner to approve.

Read docs/project-state.md, docs/vision.md, all ADRs in docs/adrs/, ARCHITECTURE.md, and what the repository already contains.

**Change nothing in this step:** no files, no commits, no installs, no accounts, no cloud resources. Report the plan as your feedback, in this order:
1. **Scaffold:** the framework init command(s), shared dependencies and config files, each with the ADR it comes from.
2. **Provisioning:** every external resource you would create or link (hosting project, database, storage, DNS, monitoring), with provider, region and expected cost where known. Write "None" when nothing is provisioned.
3. **CI:** the workflow you would add, including the docs-budget check (\`node scripts/check-docs-budget.mjs\`).
4. **Needs the owner:** accounts, credentials or choices you cannot make yourself.
5. **Already in place:** what the repository already has, which you would leave as it is.

The owner approves this plan; the next step carries it out and nothing beyond it. Use the /${skill} skill.`;
}

module.exports = {
  DEFERRED_DECISIONS_RULE, DEFERRED_DECISIONS_REVIEW_RULE, COMPANION_SPEC_ROLES,
  ceoSynthesisPrompt, pmScopingPrompt, companionSpecAgents,
  devopsInitPrompt, devopsFeaturesContext, scaffoldPlanPrompt,
};
