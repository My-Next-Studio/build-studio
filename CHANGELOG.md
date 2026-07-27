# Changelog

All notable changes to Build Studio.

Build Studio ships from `main` — there are no tagged releases — so entries are
grouped by date, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

**Read `Upgrade steps` first.** That section lists what you must *do* when
pulling; `Changed` lists behaviour that shifts on an unmodified config, which is
the category most likely to surprise a fork.

---

## 2026-07-27 — Model catalog auto-discovery, uniform role slots

Claude model list auto-discovery, uniform role slots, and per-step overrides
that reach every CLI.

### Added

- **Claude models are discovered from models.dev** instead of a hand-maintained
  list — the same source that already backed the Codex and OpenCode pickers. New
  Anthropic releases appear without a code change. `[1m]` variants are
  synthesized only for models whose context window is actually 1M, so Haiku 4.5
  and Opus 4.1/4.5 correctly don't get one.
- **Per-model Claude effort options**, read from models.dev `reasoning_options`.
  Replaces the static ladder plus a `model.startsWith('opus')` heuristic that
  stripped `xhigh` from Fable. Where models.dev has no entry the documented
  ladder is still offered — its Anthropic coverage is partial (`claude-sonnet-5`
  reports none despite supporting the full range), and hiding a real control is
  worse than offering one the CLI ignores.
- **`step_models` / `step_efforts` accept a per-CLI map**, so a step can pin a
  model on any CLI rather than Claude alone:

  ```yaml
  step_models:
    code_review:
      claude: sonnet5
      codex: gpt-5.6-sol
      opencode: openrouter/moonshotai/kimi-k3
  ```

- `buildCliFlags(cli, model, effort)` in `@build-studio/shared/cli` — the single
  place mapping a resolved triple to command-line fragments, now used by both the
  pure resolver and the workflow launcher.

### Changed

Behaviour that shifts on an unmodified config:

- **The Reviewer slot applies in every workflow type**, not just `execution`.
  Reviewers in bugfix / review / kickoff / demo_review runs now follow
  `reviewer_cli` / `reviewer_model` / `reviewer_effort` instead of the Default
  slot. The legacy per-run `wf.reviewerCli` knob stays execution-scoped so
  in-flight runs keep their assignment.
- **`Final Reviewer` follows the Reviewer slot** (was the Default slot).
- **`developer_model` / `developer_effort` inherit the Default slot when unset**,
  matching the Reviewer slot. Previously an unset Developer model meant "let the
  CLI pick its own default" — if that was deliberate, pin the Developer row
  explicitly to restore it.
- **`step_efforts` and `agent_defaults.effort` apply to every CLI.** The token
  vocabulary is shared (`claude --effort`, `codex model_reasoning_effort`,
  `opencode --variant`), so these were Claude-only by accident. Note not every
  model accepts every level — older Codex models stop at `high`; use a per-CLI
  map to narrow. `step_models` values stay Claude-only in their bare string form
  by design, because those are Claude short names.
- **One-shot and run-task agents change model.** `lib/oneshot.js` and
  `lib/api/run.js` each carried a private map pinned to `claude-opus-4-6` /
  `claude-sonnet-4-6`; both now use the shared `MODEL_IDS`, so those paths move
  to whatever `opus` / `sonnet` resolve to (currently Opus 4.8 / Sonnet 5).
- **The Claude picker lists CLI aliases plus full model ids** (`claude-opus-5`,
  `claude-sonnet-5[1m]`). Version-pinned legacy keys (`opus4.7`, `sonnet4.6`,
  `sonnet5`, …) still resolve in stored configs but are no longer offered as
  options. Nothing breaks; the spelling in the dropdown changes.
- **Per-project catalog endpoints are backed by the shared `getCatalog`.**
  `/api/opencode/models` and `/api/opencode/model-efforts` no longer hand-roll
  their own fetch, TTL and stale-fallback logic; they share one
  `.build-studio/cli-catalog-cache.json` instead of two separate files.
- `opus` still resolves to Opus 4.8 — deliberately **not** promoted to Opus 5,
  which is selectable explicitly as `claude-opus-5`.

### Fixed

- **A catalog cache written before a field existed satisfied the TTL check and
  served that field as `undefined` for up to 24h after an upgrade**, which made
  the Claude picker silently fall back to its static list. Cache reads are now
  schema-guarded: a payload missing any currently-read field forces a refetch,
  while still serving as the offline fallback.
- **An inherited Developer/Reviewer CLI rendered identically to an explicitly
  chosen one**, so moving the Default row looked like it silently moved the
  others. Inherited picks now render dashed/outlined, and re-clicking a pinned
  CLI hands the slot back to Default.
- **Per-step overrides never reached Codex or OpenCode agents.** The launcher
  hand-rolled its own flag strings for Claude and reused the shared resolver only
  for the other two, so the step layer existed on one path only.
- **`.gitignore` enumerated cache files by name and missed
  `opencode-model-efforts-cache.json`**, which was committed into managed
  projects. Now a `.build-studio/*-cache.json` glob covering present and future
  cache files.
- Model/effort resolution validates on the way out: a model incompatible with its
  CLI, or an effort that isn't a plain token, yields no flag rather than reaching
  a shell command line.

### Upgrade steps

1. **Rebuild, inject, restart.** Both `hub/` and `project-server/`+`shared/`
   changed, so `--sync-only` is not enough:

   ```bash
   cd packages/hub && npx next build
   cd packages/desktop && node inject-resources.js
   ```

   Then restart the app. Project-servers run in-process inside the Electron main
   process, so the app restart covers them — no per-project stop/start needed.

2. **Check each managed project for a committed cache file.** This is the one
   thing that fails silently, because the efforts cache was never gitignored:

   ```bash
   git ls-files '.build-studio/*-cache.json'
   git rm --cached <anything listed>
   ```

   Re-onboarding adds the `.build-studio/*-cache.json` glob automatically;
   otherwise add it by hand.

3. **Nothing to migrate in `config.yaml`.** Bare `step_models` / `step_efforts`
   values keep working unchanged.

4. **Caches self-heal.** The hub's `~/.build-studio/opencode-catalog-cache.json`
   refetches on schema mismatch. Per-project, a new `cli-catalog-cache.json`
   replaces `opencode-models-cache.json` and
   `opencode-model-efforts-cache.json`; the old two are orphaned and safe to
   delete.

5. **Review the `Changed` section above** — several items alter agent behaviour
   without any config edit.

### Notes for forks

- `CLAUDE_MODELS` is no longer the picker source; it now serves only as the
  offline fallback. A fork reading it directly will silently get the old static
  list.
- If you add a field to the catalog cache payload, add it to
  `isCurrentCatalogSchema()` too — and never the reverse. A field in the schema
  check that the payload never produces makes every read miss the TTL and refetch
  on every request.
