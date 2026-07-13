# Build Studio

[![CI](https://github.com/My-Next-Studio/build-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/My-Next-Studio/build-studio/actions/workflows/ci.yml) [![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Mission control for multi-agent [Claude Code](https://claude.com/claude-code) workflows. Run a whole product team of AI agents — PM, architect, designers, developers, QA, security, code review — across multiple projects from a single hub. Each agent runs in its own tmux session, drives a real git workflow, and reports back so you can review and approve at the gates that matter.

> **Built by [My Next Studio](https://mynextstudio.com/).** We use Build Studio to build our own products. See [how we build](https://mynextstudio.com/how-we-build/) — including a demo clip of driving a single story from drafting → review → implementation.

---

## What is Build Studio?

Build Studio turns Claude Code from a single assistant into an orchestrated team. You give a project a vision and some inputs; the dashboard runs structured **workflows** where specialized **agents** take turns — scoping a PRD, reviewing it from multiple angles, implementing it in isolated git worktrees, validating with tests, and merging to main — pausing for your approval at the points where human judgment matters.

It's designed for running **several projects in parallel**. Each managed project gets its own isolated Express server (its own port, its own process), so a crash or a long-running build in one project never affects another. The hub is the single UI on top.

### The philosophy

Build Studio sits deliberately between two failure modes of AI-assisted development.

**Vibe coding** — prompting your way forward change by change — is fast, but structureless: quality drifts, decisions go unrecorded, and after a few weeks neither you nor the agents can say why the product is the way it is. **Specifying the full end product up front** fails the other way: it assumes you know the final destination before you've built anything, and you usually don't.

So Build Studio works like this:

- **Define a vision, not a final spec.** The vision captures why the product exists, who it's for, and what matters. It's the alignment target — not a blueprint of the end state, which is rarely completely defined at the start.
- **Build in small, iterative steps.** Each step is one PRD with a companion spec — deliberately small enough that you can genuinely review it and approve it, send it back, or discard it outright if it takes the product in a direction you don't want.
- **Agents keep every step aligned with the vision.** The review panel checks each PRD against the vision before anything is built; QA, security, and code-review gates then check the implementation against the PRD.
- **The vision itself can change — deliberately.** When a step reveals that the vision is wrong or incomplete, updating the vision is a legitimate, explicit outcome. Intentional course-correction is part of the process; silent drift is not.
- **You stay at the decision points.** Agents draft, build, test, and review; you decide at the gates that matter.

The result is a product that grows step by step — each increment vision-aligned, human-approved, and small enough to reason about — with the vision sharpening as you learn.

### Core concepts

- **Functions** — top-level areas of a project: **Project** (vision, backlog, kickoff), **Development** (review + execution workflows), **Operations** (services, CI/CD, runbooks, UI tests).
- **Workflows** — ordered sequences of steps. Four types: `kickoff` (stand up a new project), `onboarding` (adopt an existing codebase), `review` (iterate a PRD with a review panel), and `execution` (build, test, and merge a PRD).
- **Agents & roles** — each step launches one or more agents playing a role (PM, Architect, Frontend Dev, QA, Security, Code Review, …). Each role is defined by a bundled **command file** the agent invokes, which may draw on skills you have installed (see [Roles, commands & skills](#roles-commands--skills)).
- **Steps & gates** — steps either advance automatically (optionally hands-off via auto-advance) or wait for you at human gates like owner consultations and demo review.

---

## Prerequisites

- **Node.js >= 18** and **npm**
- **[Claude Code](https://claude.com/claude-code)** — the agents are Claude Code sessions
- **tmux** — agent session orchestration (`brew install tmux`)
- **git**
- **Ghostty** (optional) — terminal launch; falls back to macOS Terminal.app

> **Platform note:** the standalone app and terminal launching are currently macOS-oriented. The hub and project servers are plain Node and run anywhere; some Operations features assume a macOS/Xcode toolchain.

## Installation

```bash
git clone https://github.com/My-Next-Studio/build-studio.git
cd build-studio
npm install
npm link   # makes `build-studio` available globally
```

## Quick start

```bash
# 1. Start the hub (opens at http://localhost:18080)
build-studio hub --dev

# 2. On the home screen, click "+ New Project" and point it at a folder.

# 3. Add input documents (business plan, research, notes) to:
#    <project>/docs/inputs/

# 4. Open the project and run the "kickoff" workflow.
```

Prefer the terminal? `build-studio init ~/projects/my-app` does the same as step 2. And if you run the [standalone macOS app](#standalone-macos-app), it's the same hub — no CLI needed at all.

---

## Creating & onboarding projects

There are two ways to bring a project under management — **new** (scaffold from scratch) or **existing** (onboard a codebase you already have). Both are available directly in the app: the home screen has **+ New Project** and **↪ Onboard project** buttons that walk you through it. The CLI commands below are the equivalent for terminal use.

### New project — "+ New Project" or `init`

Scaffolds a fresh project (config, role command files, docs skeleton) and registers it:

```bash
build-studio init ~/projects/my-app
build-studio init ~/projects/my-app --name "My App" --port 3005
```

Creates:
```
my-app/
├── .build-studio/config.yaml   # Team, workflows, settings
├── .claude/commands/              # Role command files (one per role)
├── docs/
│   ├── inputs/                    # Put input documents here
│   ├── prds/
│   ├── project-state.md
│   └── vision.md
├── tmp/                           # Gitignored transient artifacts
├── .gitignore
├── CLAUDE.md
└── (git init + initial commit)
```

Then add your inputs to `docs/inputs/` and run the **kickoff** workflow from the hub: the CEO agent synthesizes a vision, the PM scopes the first PRD and backlog, the team reviews, and you sign off.

### Existing codebase — "↪ Onboard project" or `register`

Bring in a project you already have — click **↪ Onboard project** on the home screen (or register it from the terminal), then run the **onboarding** workflow, which reads the existing code instead of `docs/inputs/`:

```bash
build-studio register ~/projects/existing-project
```

The onboarding workflow (`discovery → ceo_synthesis → architect_backfill → pm_synthesis → devops_detect → team_review → pm_revision → owner_signoff`) backfills `project-state.md`, a baseline PRD, and the docs scaffolding so the project can join the normal loop. Your sign-off gates the first commit.

---

## The daily loop

Day to day, you drive projects through two repeating workflows and step in only at the gates:

1. **Draft** — the PM writes a PRD for the next backlog item (kickoff/standalone).
2. **Review** — the `review` workflow runs a panel of role agents (Brand, Marketing, UX, Architect, Security, QA) against the PRD. They post findings; the PM revises. Loops until approved (capped by `max_review_rounds`).
3. **Execute** — the `execution` workflow writes tests, plans the work, implements it in **isolated git worktrees** (one per dev agent), validates against the test suite, runs AC verification + security audit, shows you a demo, then merges to main and captures learnings.
4. **Approve at the gates** — steps like *owner consultations* and *demo review* always wait for you. Everything else can run on its own.

**Auto-advance** lets the loop run hands-off: when a step's agents finish, the next step starts automatically, so a project can progress while you're away — stopping only at human gates or a failing quality gate.

You watch progress in the hub (status dots, per-step feedback, live tmux output) and jump in to approve, give notes, or course-correct.

---

## Roles, commands & skills

Each role is defined by a **command file** — `.claude/commands/<role>.md`, scaffolded into every project: `pm.md`, `architect.md`, `backend_dev.md`, `frontend_dev.md`, `fullstack_dev.md`, `ios_dev.md`, `android_dev.md`, `qa.md`, `qa_review.md`, `code_reviewer.md`, `security.md`, `ux.md`, `designer.md`, `brand.md`, `devops.md`, `ceo.md`, `marketing.md`, `fix_planner.md`, `planner.md`. The command file defines the role's responsibilities, domain boundaries, and rules, and it is what the workflow invokes when it launches an agent (*"Use `/pm`…"*). **These ship with Build Studio** — every role works out of the box.

Role commands may in turn draw on **Claude Code skills** installed in your own environment:

- Several role commands tell the agent to apply matching installed skills where available — e.g. the PM applies your PM-methodology skills for frameworks and templates; QA uses a browser-testing skill for visual verification when one is present.
- Some steps use Claude Code built-ins — e.g. the review workflow uses the built-in `/code-review`.

> **Skills are not bundled with this repo — and they don't need to be.** Without any extra skills installed, agents work fully from their command files. Skills you install add deeper, reusable methodology on top; the workflows detect and use them opportunistically.

You can add, remove, or customize roles per project — see [Customizing roles](#customizing-roles).

---

## CLI commands

### `build-studio init <path>`
Scaffold a new project and register it. Options: `--name <name>`, `--port <N>`.

### `build-studio hub [--dev] [--port N]`
Start the hub app (default port 18080). `--dev` enables hot reload.

### `build-studio start [path]`
Start a single project server directly (bypasses the hub).

### `build-studio register <path>`
Register an existing project in the hub without re-scaffolding.

### `build-studio list`
List all registered projects.

---

## Standalone macOS app

The hub can be packaged as a native macOS app with Electron.

```bash
# Dev mode
cd packages/desktop && npm run dev

# Build the .app
cd packages/hub && npx next build
cd ../desktop && npx electron-builder --mac --dir
```

The `.app` is output to `packages/desktop/dist/mac-arm64/Build Studio.app`. Copy it to `/Applications` or double-click to run.

---

## Monorepo structure

```
build-studio/
├── packages/
│   ├── hub/              # Next.js app — project switcher + dashboard UI
│   ├── project-server/   # Express server — one per project (workflows, git, tmux)
│   ├── shared/           # Registry, process manager, constants
│   └── desktop/          # Electron wrapper for standalone .app
├── bin/cli.js            # CLI entry point
├── templates/default/    # Project scaffolding templates
├── docs/                 # Agent role docs (docs/agents/), ways-of-working, learnings
└── package.json          # npm workspaces root
```

---

## Config reference

Key fields in `.build-studio/config.yaml` (not exhaustive — presets set sensible defaults):

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | Yes | — | Project name (used for tmux prefix, UI title) |
| `port` | Yes | — | Project server port (auto-assigned on init) |
| `docs_path` | No | `./docs` | Path to docs directory |
| `roles.review` | No | `[]` | Roles launched during review workflow |
| `roles.execution` | No | `[]` | Roles launched during execution (use worktrees) |
| `roles.standalone` | No | `[]` | Roles used by specific workflow steps (PM, QA, CEO) |
| `workflow.kickoff` | No | Standard steps | Kickoff workflow step sequence |
| `workflow.review` | No | Standard steps | Review workflow step sequence |
| `workflow.execution` | No | Standard steps | Execution workflow step sequence |
| `agent_defaults.permission_mode` | No | `auto` | Claude Code permission mode for agent sessions: `auto` (classifier-reviewed, no routine prompts), `bypassPermissions` (skip all checks), `dontAsk` (allowlist-only), `acceptEdits`, `default`, `plan` |
| `agent_defaults.skip_permissions` | No | — | Legacy: `true` = `bypassPermissions`. Use `permission_mode` instead |
| `agent_defaults.unset_api_key` | No | `true` | Unset `ANTHROPIC_API_KEY` in agent sessions |
| `agent_defaults.model` | No | `opus` | Default model (`opus` or `sonnet`) |
| `step_models` | No | `{}` | Per-step model overrides |
| `max_review_rounds` | No | `4` | Hard cap on review iterations |
| `review_mode` | No | `parallel` | `parallel`, `orchestrator`, or `sequential` |
| `worktree_env_files` | No | `[]` | Files to copy into worktrees (e.g., `backend/.env`) |
| `builder_strategy` | No | — | `goal` arms Claude Code's native `/goal` harness on the builder session |
| `simulator.scheme` | No | — | (iOS) Xcode scheme — enables iOS QA scoping & test-impact analysis |
| `simulator.project` | No | `ios/<Scheme>.xcodeproj` | (iOS) explicit `.xcodeproj` path when it differs from the scheme convention |
| `simulator.destination` | No | — | (iOS) stable simulator destination/UDID for `xcodebuild` |
| `simulator.parallel_testing` | No | `true` | (iOS) `false` = serial, number = capped worker count |
| `qa_validation.scope` | No | `full` | `new-uitests` runs only this branch's new/changed XCUITest classes |
| `qa_validation.unit_test_target` | No | `<Scheme>Tests` | (iOS) unit-test target for scoped QA runs |
| `qa_validation.honor_clean_approval` | No | `false` | Strict gate accepts the QA agent's certified-clean verdict |

Each role entry:
```yaml
- role: PM              # Display name
  skill: pm             # Slash command the agent invokes (usually the role's command file)
  command: pm.md        # File in .claude/commands/
  branch_prefix: agent-pm  # (execution only) worktree branch prefix
  worktree: true           # (execution only) use git worktree
```

---

## Customizing roles

Edit `.claude/commands/<role>.md` to change what a role does. Edit `.build-studio/config.yaml` to add, remove, or recategorize roles.

**Add a role:**
1. Create `.claude/commands/support.md` with the role definition.
2. Add it to config:
   ```yaml
   standalone:
     - role: Support
       skill: support
       command: support.md
   ```
3. Restart the project server (or refresh the hub).

**Remove a role:** delete it from config and optionally remove the command file.

---

## Troubleshooting

**An agent is stuck (no progress, a step won't advance, a gate misfired).**
This happens occasionally — an interactive prompt, an environment hiccup, a flaky test, a transient API error, or an edge case in a workflow step. First stop: open the agent's log in the workflow view and click **⌁ Live terminal** — that attaches a real bidirectional terminal to the agent's session, so you can answer a prompt, press Enter, or type a nudge directly from the hub. For deeper problems, **open Claude Code in the project repo (or in this dashboard's repo) and drive it to diagnose and unstick the run** — read the step's feedback, check the tmux output, patch the workflow or the project, and re-advance. This is exactly the kind of maintenance Build Studio itself is built and maintained with. For workflow-engine bugs, the project-server logs and `packages/project-server/lib/api/workflow.js` are the place to look.

**Port already in use:** the server auto-increments ports on conflict. To pin one, set it in `.build-studio/config.yaml` or pass `--port` when registering.

**tmux not found:** `brew install tmux`.

**Stale workflow (agents marked as lost):** the server was restarted while a workflow was running. Click "Cancel Workflow" in the UI to clear and start fresh.

**Hub shows a project as "stopped":** click "Start" on the project card, or just navigate into the project view (it auto-starts).

**Config validation errors:** usually a missing `name`/`port`, a role `command` file that doesn't exist in `.claude/commands/`, or a port outside 1024–65535.

**Ghostty window doesn't open:** it falls back to Terminal.app. If neither works, attach manually: `tmux attach-session -t <session-name>`.

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first — in particular, every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/) (`git commit -s`).

## License

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution requirements.

---

Built with care by [My Next Studio](https://mynextstudio.com/) · [How we build](https://mynextstudio.com/how-we-build/)
