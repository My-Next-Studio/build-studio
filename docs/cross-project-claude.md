# Cross-Project Conventions

> This file is the shared source of truth for all projects managed by Build Studio.
> Project-specific CLAUDE.md files reference this file. Edit HERE, not in each project.

## Framework & Conventions

Each project defines its own stack — see the project's `CLAUDE.md` and
`ARCHITECTURE.md` (repo root, the maintained component map: read it before
exploring the codebase; whoever changes the component map updates it in the
same commit). Nothing in this file assumes a particular language or framework.
Stack-specific rules (e.g. "always `throw redirect()` in SvelteKit server
functions") belong in the project's own `CLAUDE.md`, never here. Where a
convention below is stack-conditional (e.g. playwright-cli for browser
frontends), the project's preset/config gates it.

## How Projects Work

Each project uses a two-layer system:
1. **Commands** (`.claude/commands/`) — Role identity and project-specific perspective
2. **Installed Skills** (via plugins) — Methodology, frameworks, and best practices

Commands define the *lens*; skills provide the *tools*.

## Directory Conventions (ENFORCED)

These paths are authoritative. All roles must use them. Do not create parallel
structures or use skill-default paths.

| Directory | Purpose | Mutability |
|-----------|---------|------------|
| `docs/inputs/` | Input documents provided before kickoff | Read-only reference |
| `docs/vision.md` | Canonical vision — produced by kickoff | Update via /ceo only |
| `docs/project-state.md` | Single source of truth for project status | Update as state changes |
| `docs/prds/` | PRDs: `PRD-NNN-short-name.md` | One per iteration |
| `docs/adrs/` | Architecture Decision Records | When arch decisions are made |
| `docs/ux/` | UX specs: `UX-NNN-short-name.md` | When PRD requires UX input |
| `docs/brand/` | Brand guidelines and copy specs | When PRD requires brand input |
| `docs/marketing/` | Marketing strategy and content | Marketing deliverables |
| `docs/marketing/seo/` | SEO tab state: `status.json` (monitor output), `actions-log.md` (audit trail) | Written by seo-monitor / seo-fix agents |
| `docs/learnings/` | Known patterns and pitfalls — per-file with frontmatter | Append when learning; curate on review |
| `docs/runbooks/` | Operational runbooks (DR, deployment, rotation) | When ops procedures are defined |
| `tmp/` | Gitignored transient artifacts | Disposable — clean anytime |
| `tmp/.worktrees/` | Git worktrees for agent branches | Managed by dashboard |
| `tmp/.logs/` | Tmux pipe-pane logs | Managed by dashboard |
| `tmp/reviews/` | Throwaway review documents | Disposable |
| `.build-studio/` | Build Studio config | Edit to change team/workflow |
| `.claude/commands/` | Role definitions | Edit to customize roles |

## Rules

- All project state lives in `docs/project-state.md` — update it, not this file
- Commands define roles; skills provide methodology
- Review skill output through the lens of your role command
- Log decisions in the Key Decisions Log with which role made them
- When facing a decision with multiple valid alternatives, stop and consult the user
- PRDs must be small enough to evaluate and throw away
- **When a role is referenced in a prompt** — read the corresponding
  `.claude/commands/<role>.md` file and apply that role's domain and constraints
- **Transient artifacts go in `tmp/`** — never commit review drafts, logs, or
  intermediate outputs to the repo

## Standard Workflow (ENFORCED)

Each iteration is a small, focused PRD — scoped to days, not weeks — that delivers
standalone value and can be evaluated and discarded if the result isn't good enough.
Vision updates are possible but always a conscious decision, not a side effect.

The workflow has three phases: **Preparation** (PRD + companion specs),
**Design** (visual design, when flagged by UX), and **Execution** (tests,
implementation, verification). Each phase ends with an explicit gate; the
next phase MUST NOT begin until its preceding gate passes.

A project's `docs/project-state.md` may add project-specific notes to a phase,
but it MUST NOT remove or reorder these phases or skip the gates. If a project
needs a different workflow, that is a deliberate decision recorded in the
project's `project-state.md` with a justification — not a silent drift.

### Preparation Phase

```text
1. /pm         → Scope next iteration: one small PRD → docs/prds/

[Review rounds — parallel, iterate until PRD approved]
> Output: structured feedback only. No spec files are produced or required in this phase.
> Reviewers must NOT block because companion spec files are missing — they don't exist yet.
2. /brand      → Review PRD for brand coherence
3. /ux         → Review PRD for interaction design concerns
4. /architect  → Review PRD for architectural implications
5. /marketing  → Review PRD for growth/funnel concerns
6. /security   → Review PRD for security design (threat model, auth, data exposure)

[Companion specs — parallel, if PRD identifies them in the Companion Specs delivery table]
> Runs only after PRD review rounds are complete and PRD is approved.
> Spec authors update the Companion Specs delivery table with the file path and Status when delivered.
7. /ux         → Interaction spec → docs/ux/UX-NNN-*.md
8. /brand+/pm  → Copy spec → docs/brand/PRD-NNN-copy.md
9. /architect  → ADR → docs/adrs/ADR-NNN-*.md

[Gate: /pm verifies every Companion Specs delivery-table row marked Required has a file path and the file exists]
```

Not every PRD needs companion specs. The PRD itself defines which specs are
needed via its Companion Specs delivery table (see "Companion Specs Convention"
below). Roles not needed for a given PRD confirm they have no input and move
on. **PM owns the gate check** — do not start the Design or Execution phase
until every Required row in the table is marked **Done**.

### Design Phase

```text
[Gate: only runs when UX flags visual design as Required in the Companion Specs table]
1. Visual design → Create Pencil design using frontend-design skill, informed by PRD + UX interaction spec + brand guidelines
2. Iterate       → Review and refine until design covers all implementation surfaces
3. Gate          → .pen file exists and covers PRD scope → execution may begin
```

Not every PRD needs visual design. UX flags it during PRD review and records
it in the Companion Specs table. When flagged, frontend_dev MUST NOT start
implementation without an approved Pencil file. The frontend-design skill is
required for this step regardless of which role runs it.

### Execution Phase

```text
1. /qa         → Write E2E test spec from PRD + all companion specs → e2e/prd-NNN-*.spec.ts (tests fail intentionally)
2. Agent Team  → Implement (lead + specialists in parallel; /devops joins when PRD requires infra/CI/CD changes)
3. /qa         → Run PRD-scoped tests (new spec + directly affected existing tests); failures → /frontend_dev or /backend_dev to fix
4. /security   → Code-level security audit scoped to PRD changes only; blocking findings → fix before continuing
5. Evaluate    → Keep or discard. If vision needs updating → /ceo
6. Commit & push → Full regression runs in CI/CD pipeline (not per-iteration)
7. Clean up    → Dashboard "Merge Branches" removes worktrees, branches, and logs automatically
               → Mark PRD done in docs/project-state.md (Active PRD + Backlog table + Phase line)
```

**DevOps note:** Standalone infrastructure work (CI/CD pipeline, deployment setup,
monitoring) that isn't tied to a feature PRD gets its own PRD or ADR and follows
the same workflow.

**Solo-developer note:** Steps within a phase may compress into hours, not days
— but the phase boundaries and gates still apply. The gates exist so nothing is
skipped, not to create ceremony.

## Companion Specs Convention (ENFORCED)

Every PRD MUST contain a **Companion Specs delivery table** as a top-level
section. This table is the single source of truth for which companion specs
are required and whether they exist yet. The PM gate check between Preparation
and Execution reads this table — without it, the gate cannot pass.

### Required format

```markdown
## Companion Specs

| Spec | Required | Owner | Path | Status |
|------|----------|-------|------|--------|
| UX interaction spec | Required \| Optional \| N/A | /ux | `docs/ux/UX-NNN-short-name.md` | Pending \| Done \| N/A |
| Copy spec | Required \| Optional \| N/A | /brand | `docs/brand/PRD-NNN-copy.md` | Pending \| Done \| N/A |
| ADR | Required \| Optional \| N/A | /architect | `docs/adrs/ADR-NNN-short-name.md` | Pending \| Done \| N/A |
| Visual design (.pen) | Required \| Optional \| N/A | /designer | `docs/design/PRD-NNN-*.pen` | Pending \| Done \| N/A |
```

### Rules

- The PM authors this table when drafting the PRD. Reviewers may push to add
  or remove rows during the review rounds.
- Each row's **Owner** identifies the role that authors the spec. Each row's
  **Path** is the exact file the spec must be written to.
- **Exactly one owner per row.** Do NOT use `+`, `&`, `,`, or `and` to list
  multiple roles in the Owner column. The execution workflow launches one
  agent per listed role per spec — multiple owners on a single row spawn
  parallel agents that race to write the same file. When a spec naturally
  touches more than one discipline (e.g. copy that is both marketing- and
  brand-flavored), the PM picks the **single** role whose lens fits the
  PRD's emphasis best — `/marketing` if the PRD is acquisition / growth
  flavored, `/brand` if it is voice / identity flavored, etc. The other
  role can still be looped in via review (they appear in the review-round
  roster), but they are not the spec's author. If a single-author choice
  feels wrong because the work is genuinely two specs in disguise, split
  the row into two rows with distinct paths and one owner each.
- When a spec author delivers, they edit this table to flip **Status** from
  `Pending` to `Done`. If they decide the spec isn't needed after all, they
  flip it to `N/A` with a one-line note in the row.
- **No execution starts while any Required row is `Pending`.** This is the
  PM's gate.
- A PRD that includes detailed spec requirements in another section (e.g. a
  prose "Companion specs required" subsection) MUST still surface the
  delivery table — the prose is reviewer-facing detail; the table is the
  machine- and PM-checkable contract.
- **Every row's Path MUST be a real file path** ending in a recognisable
  extension (`.md`, `.txt`, `.pen`). The Path is read mechanically by the
  dashboard's Backlog tab to surface companion specs as openable links; rows
  with no file path are invisible there. The path may point to a file that
  doesn't exist on disk yet — that's exactly what `Pending` means — but it
  must be a path the author will write to.
- **Reviewer-pass-only items do NOT belong in this table.** Items like
  "Brand review of `Theme.swift` on the PR", "Security review of the PR
  posture", "UX review of the artboard mapping" are review *activities* that
  happen as part of the review-round workflow when those roles are on the
  roster — they are not deliverables. Listing them here pollutes the
  contract and confuses the PM gate (which only knows how to check whether
  a file exists). If a reviewer's involvement is required, ensure the role
  is in the review-round roster; that's where the workflow picks them up.
  Don't track it in the Companion Specs table.

### Equivalent existing names

Projects with established history may keep an existing section name (e.g.
valkomna's `## §10. Companion Specs — delivery table`) provided the columns
match this convention. New PRDs in any project should use the canonical
`## Companion Specs` heading above.

## Skill Override Policy

Installed skills provide methodology and workflow patterns.
**Project conventions always override skill defaults.** When a skill specifies
file paths, output formats, or workflow steps that conflict with this project's
conventions, follow the project conventions.

## Review Feedback Format (ENFORCED)

All agents performing reviews, code reviews, QA validation, or security audits
MUST use this structured format when reporting feedback. This format is machine-parsed
by the dashboard — deviating from it will break automated status detection.

### For reviews (code review, architecture review, security audit, PRD review):

```
## Review: [Your Role]

**Approved:** yes | no
**Blocking:** N  |  **Medium:** N  |  **Low:** N

### Summary
[1-3 sentences for the human reviewer — what's the overall state, what matters most,
what's the single most important thing to address.]

### Findings
[Detailed analysis. Group by topic. Use code references where applicable.
Mark each finding with severity: BLOCKING, MEDIUM, or LOW.]

### Action Items
- [ ] [assignee_role] — description of what needs to happen
- [ ] [assignee_role] — description
```

### For QA validation:

```
## QA: [Your Role]

**Approved:** yes | no
**Tests passed:** N/N  |  **Failures:** N
**E2E:** passed | not run (reason)

### Summary
[1-3 sentences — what's blocking, what passed, what couldn't be tested and why.]

### Failures
[Details per failing test: test name, expected vs actual, root cause if known,
which role should fix it.]

### Action Items
- [ ] [assignee_role] — fix description
- [ ] [assignee_role] — fix description
```

### Rules for the format:
- **Approved** must be exactly `yes` or `no` — no "yes, but" or "conditionally"
- **Blocking** count must match the number of BLOCKING findings in the body
- **Action Items** must include the assignee role in brackets: `[backend_dev]`, `[frontend_dev]`, `[architect]`, etc.
- When a previous round's issues have been fixed, state "Fixed" not "Blocking" — do not re-list resolved items as blocking
- If no issues found, set all counts to 0 and Approved to yes

### For dev agents reporting fixes:

Dev agents responding to review/QA feedback should use:

```
## Fix Report: [Your Role]

**All issues addressed:** yes | no
**Committed:** [commit hash]

### Changes
[List each issue and what was done. Reference the original finding.]

### Notes
[Anything the reviewer/QA should re-check, or items that were intentionally
not addressed with justification.]
```

## Visual Design Verification (ENFORCED)

Three modes are supported, picked per project. The mode is recorded in
`docs/project-state.md` Project Conventions and the verification protocol below
branches accordingly.

| Mode | Design source | Verification | Recorded as |
|---|---|---|---|
| **Pencil-controlled** | `.pen` file authored in Pencil | playwright-cli screenshot + heatmap-diff ≥85% vs Pencil PNG export | `Visual design workflow: Pencil-controlled` |
| **Claude Design** | Handoff bundle from claude.ai/design at `design-system/` (canonical path) — HTML/CSS prototypes + a `SKILL.md` Claude Code skill | Frontend Dev invokes the project's design skill, eyeballs the running app vs the bundle's `ui_kits/<name>/index.html` opened in a browser tab. **No heatmap-diff** — the bundle's own README explicitly forbids it. | `Visual design workflow: Claude Design (bundle at design-system/)` |
| **Agent-autonomous** | None — no design source artifact | Owner reviews the running app at end of iteration | `Visual design workflow: agent-autonomous` |

The PRD's Companion Specs delivery table records which artifact (`.pen` path or
ui_kit name) the PRD's UI surface depends on. Frontend_dev must NOT start
implementation until the artifact exists.

The owner picks a mode during kickoff (`pm_scoping` step asks the question)
or onboarding (recorded by the discovery survey). Switching modes mid-project
is allowed but should be a deliberate decision logged in the Key Decisions Log.

### Mode: Pencil-controlled — Screenshot tool: playwright-cli

Use `playwright-cli` (the `@playwright/cli` npm package) for all browser screenshots.
This is a lightweight CLI designed for AI agents — no manual Playwright scripts needed.

```bash
# Open dev server and screenshot at desktop viewport
playwright-cli open http://localhost:<port>/<path>
playwright-cli resize 1440 900
playwright-cli screenshot --filename /tmp/impl-desktop.png --full-page

# Mobile viewport
playwright-cli resize 390 844
playwright-cli screenshot --filename /tmp/impl-mobile.png --full-page

# Close when done
playwright-cli close
```

### Heatmap comparison method:
1. **Export the design** — use Pencil MCP `export_nodes` to export the approved frame as PNG (2x scale) to `/tmp/design.png`
2. **Screenshot the implementation** — use `playwright-cli` at the same viewport size (desktop: 1440×900, mobile: 390×844)
3. **Run the heatmap diff** — compare the two images using PIL/numpy, outputs a red heatmap and match % per 3×3 grid
4. **Fix if < 85% match** — address the highest-deviation sections and re-run
5. **Report match %** in feedback — include overall score and which sections scored lowest

### Who uses playwright-cli and when:
- **Frontend Dev** (task_execution) — screenshot implementation → heatmap diff against Pencil export. Required before reporting done.
- **Code Reviewer** (code_review) — independent screenshot to verify the frontend dev's reported match %.
- **QA** (qa_validation) — screenshot key pages/states to verify visual acceptance criteria.
- **QA** (ac_verification) — screenshot evidence for visual acceptance criteria sign-off.

### Why this matters:
Without verification, frontend agents consistently deviate from approved designs —
implementing their own visual style instead of the approved one. The heatmap catches
drift before code review and closes the feedback loop automatically.

### Code reviewer responsibility:
The code reviewer also checks design conformance. Deviations from the approved design
without justification are BLOCKING.

### Opting out:
Projects without browser-based frontends (mobile-app, api-only presets) have `features.playwright_cli: false`
in their preset. When disabled, skip all playwright-cli steps and heatmap verification.
Per-project override in config.yaml: `features: { playwright_cli: false }`

### Mode: Claude Design — bundle-driven, skill-enforced

When the project records `Visual design workflow: Claude Design` in `project-state.md` Project Conventions:

**Design source.** The handoff bundle exported from claude.ai/design lives at the
canonical path **`design-system/`** at the project root. Export formats vary by
bundle generation — both are valid; the project's `project-state.md` records
which entry doc applies:
- **Skill-format bundle** (e.g. sickla_tunneln): `README.md` (coding-agent
  instructions), `project/SKILL.md` (a Claude Code skill loading brand voice +
  hard rules), `project/colors_and_type.css` (token source),
  `project/ui_kits/<name>/index.html` (pixel-fidelity prototypes),
  `project/assets/`.
- **Flat bundle** (e.g. launch-studio, finance-studio): `NOTES.md` (the entry
  doc — file list, implemented interaction patterns, flagged conflicts),
  `tokens.css` (the canonical token contract the brand guidelines pin),
  `components.css` (components with states), and one `<Screen>.dc.html`
  prototype per screen.

**Frontend_dev workflow:**
1. Read the bundle's entry doc first (`README.md`/`SKILL.md` or `NOTES.md`) and
   follow it — invoke the design skill when the bundle ships one; the entry doc
   carries the hard rules and conflict flags either way.
2. Read the relevant prototype in full (`ui_kits/<name>/index.html` or
   `<Screen>.dc.html`). Follow its imports.
3. Recreate visually pixel-perfect in the project's stack (React/TSX/Vue/
   whatever). Match the visual output; don't copy the prototype's internal HTML
   structure unless it happens to fit.
4. Verify by opening the running app in one browser tab + the bundle's HTML in
   another, eyeballing the match.

**Explicitly NOT done in Claude Design mode:**
- ❌ No `playwright-cli` screenshot of the bundle's HTML.
- ❌ No PNG export from the design source.
- ❌ No heatmap-diff. The bundle's README forbids screenshotting; everything an
  agent needs is in the source files.
- ❌ No Pencil MCP tools (`batch_design`, `batch_get`, etc.) — the bundle is a
  static export, not a live-editable .pen file.

**When the design needs to change:** the owner re-iterates in claude.ai/design,
exports a fresh handoff bundle, and overwrites `design-system/`. The frontend_dev
re-reads the relevant `ui_kits/<name>/index.html` and updates the implementation.
Don't edit the bundle in-repo — it'll be overwritten on the next export.

**Code reviewer responsibility (Claude Design mode):**
- Confirm the design skill was invoked (look for skill activation in the agent's
  context or commit messages).
- Confirm the relevant ui_kit's hard rules (Swedish only, no shadows, etc. — per
  the project's SKILL.md) are respected in the implementation.
- Deviations from the bundle's design without an explicit owner decision are BLOCKING.

### Mode: Agent-autonomous

When the project records `Visual design workflow: agent-autonomous`:
- No design-source artifact exists.
- Frontend_dev produces UI code from the PRD + UX spec + brand-guidelines.md alone.
- Verification is owner running the dev server at end of iteration.
- No heatmap-diff, no skill activation, no bundle.
- Best for very small projects, internal tools, or rapid prototypes where design
  fidelity is not a quality bar.

Full workflow details: see `docs/wow/web-design-workflow.md` (in the build-studio repo)

## Learnings

> The `capture_learnings` workflow step's own prompt is the authoritative,
> always-current operational spec — this section is the summary. If they ever
> disagree, the workflow prompt wins.

Learnings are stored as individual files with YAML frontmatter:

```
docs/learnings/<category>/<slug>.md
```

Categories: architecture, backend, frontend, devops, qa, security, workflow.
Frontmatter: title, date, severity, tags, component, and **`evidence`
(required)** — the round + finding / override / gate trip the lesson came from
(e.g. `evidence: "r2 code_review BLOCKING-1"`). No evidence, no learning.

### Capture is failure-gated (restructured 2026-07-03)

- **At most 3 new learnings per workflow run; zero is a good outcome.** Only
  lessons the run's failures actually taught — fix rounds, operator overrides,
  hygiene-gate trips. Never "we did X and it worked" entries.
- **Merge before create** — update an overlapping existing entry (sharpen it,
  add the new evidence) instead of writing a near-duplicate.

### Injection & lifecycle

- Agents receive only relevance-matched entries (capped per prompt), so the
  pool scales without bloating context. Injected entries auto-expire after
  sustained non-application; agents self-report which entries materially
  changed their approach via a `Learnings applied:` line in their feedback.
- **Promotion path:** an entry agents repeatedly report applying gets proposed
  for graduation into the project's `CLAUDE.md`, an `ARCHITECTURE.md`
  component section, or a role notes file — the owner decides; a promoted
  entry's learnings file is then deleted.

### Cross-project vs project-specific

- **Cross-project** learnings (patterns valid for any project on similar
  tech) go in BOTH the project's `docs/learnings/` AND the global Build
  Studio learnings pool (the workflow writes both copies).
- **Project-specific** facts are NOT learnings — fix the config or docs
  directly; component facts, guardrails, and test-infrastructure notes belong
  in the project's `ARCHITECTURE.md`.

## CI Security Gates (ENFORCED)

Every applicable project ships with a dependency-audit CI step that fails the
build on `high` or `critical` advisories in runtime dependencies. Supply-chain
CVEs land continuously upstream; the audit step turns "did I remember to check
today" into "CI fails loud the moment a high-severity CVE drops in a dep my
project pins." The step is wired by the DevOps role during project onboarding
or new-project creation, before the first production-ready deploy.

**Where the standard lives.** Full setup procedure, language-equivalent
commands (npm, pnpm, yarn, pip, poetry, go, cargo, ruby, composer, maven,
.NET), the GitHub Actions skeleton, monorepo handling, and CVE-fire response
all live in the DevOps role doc (`docs/agents/devops.md` in the build-studio repo; deployed to each project as `.claude/commands/devops.md`) §"CI security gates (standing setup)".
That is the authoritative source — do not duplicate the table here, edit it
there if anything changes.

**When skipping is allowed.** A project without third-party runtime dependencies
(pure-HTML/CSS static site, documentation-only repo) may skip the gate. The
DevOps role logs the rationale in the project's `docs/project-state.md` Project
Conventions section. Anything else is "applicable" — wire it.

**How this section is enforced.** When the DevOps role is invoked during
onboarding or new-project creation, the checklist in `devops.md` is the gate.
The role does not call the setup complete until the audit step is committed
and the project's CI has run it green at least once.

## Branching & Deployment Strategy

All Build Studio projects use **trunk-based development** by default:

- **`main`** is always production-ready and deployable
- **Feature branches** are short-lived, created by workflow agents (worktrees), merged back to main when approved
- **No long-lived branches** — no `develop`, `staging`, or `release` branches
- **Hotfixes** go directly to main (or fast branch + merge)

### Versioning

- Semver git tags (`v1.2.3`) are created automatically on merge-to-main
- **Patch** bumps per PRD/feature merge, **minor** for significant features, **major** for breaking changes
- Tags provide rollback targets and changelog anchors

### Auto-deploy

When `deployment.auto_deploy: true`, the workflow pushes to `origin/main` after merge + tag. This triggers the project's CD pipeline (Railway, Cloudflare Pages, Vercel, etc.).

**The default is `false`** — `merge_to_main` merges + tags locally and stops. The operator clicks the Push button on the CI/CD tab when ready to deploy. This matches the cross-project rule "never push to main without explicit user approval" — pushing triggers production. Opt in to `auto_deploy: true` only when you genuinely want the workflow to push automatically (e.g. a low-stakes side project where you accept that merging implies deploying).

### DB migrations

Use **expand-then-contract** for zero-downtime deploys:
1. Add new columns/tables (backward-compatible) — deploy
2. Migrate data if needed — deploy
3. Drop old columns in a later PRD — deploy

Never rename or drop columns in the same deploy as the code that stops using them.

### Per-project overrides

Override in `.build-studio/config.yaml`:

```yaml
deployment:
  auto_tag: false        # disable auto-tagging
  auto_deploy: false     # disable auto-push (manual deploy)
  versioning: calver     # use date-based versioning: 2026.04.04
  initial_version: 1.0.0 # start from v1.0.0 instead of v0.1.0
```

## Development Philosophy

This project works in short, iterative sprints. Each iteration:
- Produces a focused PRD scoped to days, not weeks
- Delivers something valuable on its own
- Can be evaluated and discarded if the result isn't good enough
- May inform updates to the vision — but only as a conscious decision

## Agent Teams

Agent Teams are enabled. Use them for parallel implementation of well-defined PRDs.
Always start from a clean git state and commit checkpoints frequently.

## Shell Commands

Avoid compound commands (`&&`, `;`, `|` chains) in Bash tool calls. Run each
command as a separate Bash tool call instead.

When submitting structured JSON output via Bash, write to a temp file first
and use that — do not attempt complex JSON escaping inline.

## Testing

### Prerequisites (run before any E2E test suite)

- [ ] Verify the backend server is running on the expected port. Start it if needed.
- [ ] Check and use the correct port configuration — worktrees run on offset ports,
      not default ports. Never assume a default port when running E2E tests.

### Port configuration

Worktrees use offset ports (base + worktree index). Always resolve the actual
port from the worktree config or dev_commands before executing E2E tests.

### Simulator hygiene (iOS / XCTest projects)

`xcodebuild test -parallel-testing-enabled YES` clones the destination simulator
into a **global** device set at `~/Library/Developer/XCTestDevices`, shared by
every project on the machine. Cancelled or force-killed runs orphan their clones,
which pile up (2–5 GB each) and fill the boot drive.

- **The dashboard reaps leaked clones automatically:** before/after every
  server-driven UITest run (`ops/uitests`) and via a 15-minute LaunchAgent sweep
  (`scripts/install-xctest-sweep.sh`).
- **When you run `xcodebuild test` yourself** (QA agent or manual), reap before
  AND after the run — and after any `kill`:
  ```
  node "$XCTEST_CLEAN" --quiet
  ```
  `$XCTEST_CLEAN` is exported into the agent environment for iOS projects; the
  script also lives at `packages/project-server/lib/xctest-clean.js`.
- The reaper deletes **only** Shutdown + idle clones, so it is safe to run while a
  **different** project is mid-test — booted or freshly-created clones are never
  touched. This is why cleanup in one project never disturbs another.
- **Never** put `xcrun simctl shutdown all` or `rm -rf ~/Library/Developer/XCTestDevices/*`
  in a test script — those destroy another project's in-flight run. Use the reaper.
- To stop generating clones entirely (slower, no parallelism), set
  `xcode_parallel_workers: 0` in `.build-studio/config.yaml`.

## Code Changes

After deleting files or removing functions, always grep for remaining
imports/references and update affected files (especially test files) before
committing. Stale imports cause silent build or runtime failures that are
hard to trace after the fact.
