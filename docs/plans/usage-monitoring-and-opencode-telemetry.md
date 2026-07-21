# Plan: Agent telemetry + global usage monitoring

> **Status: implemented 2026-07-20.** FU-2: `packages/shared/usage-collectors.js`
> (+ tests), hub route `app/api/usage/route.ts`, `components/usage-tab.tsx`
> wired as the third Home tab after Demos; all three collectors verified live.
> FU-1: `packages/project-server/lib/opencode-telemetry.js` (+ tests), launch
> now runs `opencode run --format json | tee <events.jsonl>`, telemetry hooks
> in both feedback handlers + a writeWorklog completion sweep, model badge
> prefers `agent.actualModel` (title shows actual + configured). Deployed to
> the .app bundle; takes effect per project-server/app restart.

Two related follow-ups from the multi-CLI work (2026-07-20). Both are about
seeing what the agents actually cost — per run (FU-1) and against account
limits (FU-2). Neither blocks anything; either can ship alone.

---

## FU-1: OpenCode run capture — resolved model + tokens + cost per agent

**Problem.** OpenCode agents report `agent.model` as the *configured* string
(e.g. `openrouter/auto`, `opencode/deepseek-v4-flash-free`) and no token/cost
data at all. `openrouter/auto` is therefore a black box, and cost comparison
across CLIs is impossible. (Claude has `computeTokenUsage` from
`~/.claude/projects/*.jsonl`; codex has nothing either.)

**Facts (verified 2026-07-20, opencode 1.18.3).** `opencode run --format json`
streams NDJSON events: `step_start` / `text` / `step_finish` with `sessionID`
and per-step `tokens{input,output,reasoning,cache}` + `cost` (USD). Full model
resolution (which model actually served, e.g. behind `openrouter/auto`) is in
the session data — retrievable post-hoc via `opencode export <sessionID>`.

**Design.**

1. Launch branch changes to:
   `opencode run --format json <flags> < prompt.txt | tee <logsPath>/<window>-<wfid>.events.jsonl`
   The tmux pipe-pane log already captures stdout; `tee` keeps a clean raw
   event file. **Tradeoff:** the live pane shows NDJSON instead of the pretty
   renderer. Acceptable (pane is for debugging; workflow state is the real UI).
   Optional polish if `jq` is present: filter pane output to text parts only.
2. On agent completion (overseer marks done/error) + a final sweep at workflow
   completion: parse the events file → `sessionID`, sum tokens + cost. If
   `sessionID` found, best-effort `opencode export <sessionID>` (timeout 15s)
   to resolve the actual model ID; fall back to the configured string.
3. State: `agent.actualModel` (badge shows actual when present, else
   configured — title attr shows both), and fill the EXISTING
   `agent.tokenUsage` shape so the current token/cost badge in
   `AgentFeedbackCard` lights up for opencode with zero UI changes.
   Cost comes from the events (real OpenRouter charges), not TOKEN_COSTS.
4. Codex: no equivalent stream — stays `null` (documented).

**Verification.** E2E on a scratch project with an `openrouter/auto` model:
badge must show the routed model, and the token badge must match
`opencode stats` within a small tolerance.

---

## FU-2: Global usage monitor (Claude / Codex / OpenRouter limits)

**Problem.** Avoiding a mid-workflow wall requires checking three places by
hand (claude.ai usage page, ChatGPT, OpenRouter). Build Studio should surface
remaining limits where the work is launched.

**All three sources verified live on 2026-07-20** (real numbers, this machine):

| Provider | Endpoint | Credentials | Data |
|---|---|---|---|
| Claude | `GET https://api.anthropic.com/api/oauth/usage` (unofficial; same one Claude Code's `/usage` and ccstatusline use) | macOS Keychain `Claude Code-credentials` (Linux: `~/.claude/.credentials.json`) | `five_hour.utilization`, `seven_day.utilization` + per-model buckets, `resets_at`, `extra_usage` |
| OpenRouter | `GET /api/v1/key` + `GET /api/v1/credits` (**official**) | `~/.local/share/opencode/auth.json` → `openrouter.key` (or `OPENROUTER_API_KEY`) | usage daily/weekly/monthly, `limit_remaining` (per-key cap), `total_credits − total_usage` (balance) |
| Codex | `GET https://chatgpt.com/backend-api/wham/usage` (unofficial) | `~/.codex/auth.json` → `tokens.access_token` + `chatgpt-account-id: tokens.account_id` | plan_type, `rate_limit.primary_window.used_percent` + `reset_at`, additional per-model limits |

**Architecture.**

- **Hub-level, not project-server.** This is a global resource; it must work
  with zero project-servers running. New Next.js route
  `app/api/usage/route.ts` doing server-side collection (client never sees
  credentials).
- Collectors read credentials lazily per request, call the three endpoints in
  parallel with `Promise.allSettled` (any provider may be absent/down → card
  shows "unavailable", never breaks the page).
- **Cache 5 min** in `~/.build-studio/usage-cache.json` (+ in-memory). Cache
  ONLY usage numbers/timestamps — never tokens. Stale data shown with its
  `fetchedAt` timestamp.
- Security: hub binds localhost; tokens never logged, never written, never in
  the response (response = utilization numbers only).
- Failure modes: claude/codex endpoints are unofficial → defensive parsing +
  "unavailable" state. Codex `access_token` is short-lived; on 401 show
  "open codex once to refresh" (automatic refresh via `refresh_token` is a
  stretch goal).

**UI — home-view Usage tab (agreed direction).** `home-tabs.tsx` gains a third
tab after Demos: `usage`. Three provider cards (Claude / Codex / OpenRouter):

- Claude: 5-hour window bar + reset countdown, weekly bar + reset countdown,
  extra-usage line when enabled.
- Codex: weekly window bar + reset countdown, plan badge, notable
  additional_rate_limits.
- OpenRouter: credits remaining ($), usage day/week/month, per-key limit bar
  when a cap is set.
- Threshold coloring: ≥80% orange, ≥95% red. Client polls `/api/usage` every
  60s while the tab is visible; server cache caps upstream calls at 5-min.

**Display alternatives considered** (see discussion):

| Option | Verdict |
|---|---|
| A. Home tab after Demos | **Chosen** — matches the global scope, trivial slot-in, no chrome changes |
| B. Ambient header strip (always visible, click → tab) | Later — real glanceability inside projects, but needs compact design + layout surgery |
| C. Per-project Agents tab | Rejected — global resource; per-project placement confuses scope |
| D. Pre-flight guard: warn when starting a workflow while the target CLI's window ≥90% | Later, cheap — server already knows the CLI at `/workflow/start`; return a warning the UI surfaces before launch |

**Verification.** Unit: collectors parse fixture payloads; cache honors TTL;
missing credentials → clean "unavailable". Live: open the tab, compare against
`/usage` in claude, ChatGPT plan page, and the OpenRouter dashboard.

---

## Suggested order

1. **FU-2 core** (route + home tab) — biggest daily-quality win, zero workflow
   coupling. (Claude weekly was at 97% when this was written — the pain is real.)
2. **FU-1** — makes `openrouter/auto` and per-agent cost comparison real.
3. FU-2 extras: header strip (B), pre-flight guard (D), codex token refresh.
