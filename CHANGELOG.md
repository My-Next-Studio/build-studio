# Changelog

All notable changes to Build Studio.

Build Studio ships from `main` — there are no tagged releases — so entries are
grouped by date, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

**Read `Upgrade steps` first.** That section lists what you must *do* when
pulling; `Changed` lists behaviour that shifts on an unmodified config, which is
the category most likely to surprise a fork.

---

## 2026-07-28 — Start a run from the Backlog tab

### Added

- **A Start button on every backlog row**, so a run can be kicked off from the
  item instead of retyping its id into the Workflow tab. The run type is derived
  from the item, mirroring the server's own start guardrails:

  | Item | Status | Starts |
  | --- | --- | --- |
  | Bug | `Backlog` or `Blocked` | `bugfix` |
  | Feature / Task | `Drafted` | `review` |
  | Feature / Task | `Reviewed` | `execution` |

  Anything else hides the button rather than offering a click that would 409.
  Run options are fixed per type, matching how these are run in practice:
  review goes out auto-advance + strict, execution and bugfix go out
  auto-advance + skip-demo-review.

- **`GET /workflow/start-readiness`** — reports `activeWorkflow`, `branch`,
  `onDefaultBranch` and `dirty`, so the button can show *why* it is blocked
  before the click. Read-only; it runs the same git reads the start guardrail
  does. The server remains authoritative — this only avoids offering a
  click that would be rejected.

  The two blocked states are coloured differently on purpose, because they ask
  different things of you: **amber "Busy"** (a run is already active) clears by
  itself when that run ends; **red "Blocked"** (uncommitted changes, or not on
  the default branch) waits for you to commit, stash, or switch back. A dirty
  tree blocks execution and bugfix only — review creates no branch and commits
  to the default branch, so it runs fine alongside uncommitted drafts, exactly
  as the server guardrail allows.

## 2026-07-28 — Auto-advance no longer walks past a dead step

### Fixed

- **Opening the app could advance a workflow past a step whose agents all died,
  marking unreviewed work `completed` and merging it.** Auto-advance is
  implemented twice — a server-side tick and a client-side loop in
  `workflow-view.tsx` that runs whenever the workflow view is mounted. Only the
  server had the guard for a step where every agent errored with no feedback; the
  client counted `status: 'error'` as done, found no blocking verdict (there was
  no feedback at all to find one in), and approved the step forward. The server
  would halt and stash `step.autoAdvanceError`, and the next time anyone opened
  the app the client walked straight past it.

  Seen on fazon `faz-197`: a Codex reviewer died three seconds in on an MCP
  authorization error, the server correctly halted for seven hours, and opening
  the app advanced `code_review` through `merge_to_main` — merging five fix
  commits whose round-2 review never ran. The client now mirrors the server's
  guard. Note the guard is deliberately narrow: a step where *some* agents
  reported still advances on those reports; only a step where *nothing* reported
  is treated as dead.

### Known issues

- **Auto-advance still exists in two places.** This fix brings the client back in
  line, but two implementations of one policy will drift again. The durable fix
  is to delete the client loop and let the server tick own advancement.

## 2026-07-27 — Next.js 16.2.12 (nine advisories)

### Fixed

- **`next` 16.2.10 → 16.2.12**, closing nine advisories published that day — four
  high, five medium. They cover SSRF in rewrites and in Server Actions on custom
  servers, a middleware/proxy bypass, unauthenticated disclosure of internal
  Server Function endpoints, denial of service in Server Actions and in the image
  optimization API via SVG, and two cache-confusion issues. All are fixed in
  16.2.11; `packages/hub/package.json` already declared `^16`, so this needed no
  override. Most require network reach to the hub, which the loopback change
  above independently limits to the local machine.
- **`postcss` override tightened to `^8.5.18`** (top-level resolves to 8.5.23).
  The previous `^8.5.10` still permitted 8.5.10–8.5.17, which are vulnerable to a
  path traversal in source-map auto-loading.

### Known issues

- **`next` bundles its own `postcss` 8.4.31**, which is vulnerable to the three
  postcss advisories. `next` pins that version exactly, and unlike 16.2.10 it no
  longer dedupes to the root override — `npm dedupe`, a tightened range, and a
  scoped `next: { postcss }` override all failed to collapse it, so no override
  is left in place pretending to fix it. It is build-time only: `postcss` appears
  in neither the standalone build output nor the shipped `.app`, it processes
  only this repo's own stylesheets during `next build`, and all three advisories
  require attacker-controlled CSS. Expected to resolve when `next` bumps its pin.

## 2026-07-27 — Security: bind to loopback, patch `fast-uri`

### Added

- **`SECURITY.md`** — private vulnerability reporting (enabled on the repo), plus
  an explicit scope: what counts as a vulnerability versus what follows from the
  design. The unauthenticated local API on its loopback binding and agents
  executing code are deliberate; escaping those boundaries is not.
- **A "Security & intended use" section in the README**, above the install
  instructions. Build Studio is a local single-developer tool, not hardened for
  shared or production environments, and it runs AI agents that execute code —
  worth knowing before the first run rather than after.
- **`license: "Apache-2.0"` in every `package.json`.** The repo has always been
  Apache-2.0 via `LICENSE` and `NOTICE`, but the package metadata declared no
  licence at all, which is the kind of inconsistency that matters for anyone
  consuming or redistributing the packages.

### Fixed

- **The hub and every project-server listened on all network interfaces.** The
  hub set `HOSTNAME: '0.0.0.0'` explicitly and project-server called
  `server.listen(port)` with no host, which Node defaults to `0.0.0.0`. On any
  shared network — café, coworking space, hotel, client office — anyone could
  reach the dashboard and every project-server API, none of which require
  authentication: they start and stop workflows, write project config, read
  project files, and proxy tmux sessions. The only client is the Electron app on
  the same machine, over `localhost`, so nothing was gained by binding wide.
  Both now bind `127.0.0.1`. `next dev` was doing the same in dev mode and is now
  pinned too.

  Set `BUILD_STUDIO_LISTEN_HOST=0.0.0.0` to opt back in deliberately — e.g. to
  reach the hub from a phone on the same network. Treat that as exposing an
  unauthenticated API, and prefer an SSH tunnel where you can.

- **`fast-uri` bumped to 3.1.4** (CVE-2026-16221, GHSA-v2hh-gcrm-f6hx, CVSS 7.5)
  via a root `overrides` entry. It arrives through
  `electron-builder → app-builder-lib → ajv`, all build-time, so the vulnerable
  code never shipped in the app — but the patch is within `ajv`'s declared
  `^3.0.1` range, so there is no reason not to take it.

### Known issues

- **`sharp` 0.34.5 (GHSA-f88m-g3jw-g9cj) is still present**, pulled in by
  `next@16.2.10`. The libvips CVEs require processing untrusted image input, and
  no such path exists today: `images.remotePatterns` is unset so every remote URL
  is rejected, the only same-origin sources are repo-shipped files under
  `public/` and the `/avatars/[...path]` route (locked to
  `^\d+\/[\w-]+\.png$` with a traversal guard), and nothing in the app accepts an
  image upload. There is no clean fix yet — even `next@16.2.12` pins
  `sharp: ^0.34.5`, so the first patched release (0.35.0) is outside the range
  Next declares. **Re-evaluate before adding any image upload, any
  user-supplied avatar, or an `images.remotePatterns` entry.**

## 2026-07-27 — Demo recorder: output folder, narration, signature re-seal

### Added

- **The demo recordings folder is configurable** from the Demos tab. Precedence:
  `DEMO_RECORDINGS_DIR` env → your setting → a folder next to your managed
  projects → `~/Movies/build-studio-demos`. The panel shows which tier won, and
  goes read-only when the env var overrides. Backed by
  `GET`/`PUT /api/demos/settings`, which writes `demoRecordingsDir` into
  `~/.build-studio/config.json`.

### Fixed

- **Narration was dropped from rendered demos.** The EDL render passed `-an`, so
  microphone audio on manual segments never reached the output. Segments with an
  audio stream now keep it, speed-matched to the video via an `atempo` chain
  (ffmpeg clamps `atempo` to 0.5–2.0, so larger factors chain), and silent
  clips — automation timelapses have no audio — are padded with `anullsrc` so
  everything concatenates uniformly.
- **Injecting into the `.app` broke its code signature and silently revoked
  Screen Recording.** Writing files into an already-signed bundle invalidates the
  sealed-resource hashes; macOS then treats the app as tampered and drops its TCC
  grants, so `desktopCapturer` fails with "Failed to get sources".
  `inject-resources.js` now re-seals after every inject, auto-detecting an Apple
  Development identity (override with `BUILD_STUDIO_SIGN_IDENTITY`) and falling
  back to ad-hoc signing. Added `NSScreenCaptureUsageDescription` so the prompt
  explains itself.
- **The recorder and the hub resolved the recordings folder with two separate
  copies of the same logic**, which could drift and have the recorder write where
  the hub does not look. Both now call
  `@build-studio/shared/demo-recordings`.

### Upgrade steps

- **Re-grant Screen Recording once** if you injected before this landed: macOS
  may still hold a revoked grant for the tampered bundle. System Settings →
  Privacy & Security → Screen Recording, toggle Build Studio off and on, then
  restart the app. With a cert-signed build the grant is keyed to the designated
  requirement, so it survives all later rebuilds; an ad-hoc fallback needs a
  re-grant after each rebuild.
- Existing recordings are unaffected — the default resolution order is unchanged,
  so a folder that resolved before still resolves the same way.

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

   Then restart the app — **and this time restart the project-servers too.**

   Project-servers are detached `node` processes that deliberately outlive the
   app, so an update can land without interrupting in-flight workflows or their
   tmux sessions; the app re-adopts them on launch. That property is usually what
   you want, but it means a surviving server keeps running the code it started
   with. This change lives in project-server, so any server left running stays
   bound to `0.0.0.0` and the fix looks like it silently failed.

   `inject-resources.js` lists servers on stale code after every run. Either stop
   and start each project from the hub, or:

   ```bash
   node inject-resources.js --restart-projects
   ```

   To confirm nothing is left on the old build:

   ```bash
   lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(18080|300[0-9])'
   ```

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
