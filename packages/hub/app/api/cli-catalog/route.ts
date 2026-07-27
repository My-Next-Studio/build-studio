import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { opencodeCatalog } = require(/* turbopackIgnore: true */ '@build-studio/shared')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  MODEL_IDS, CLAUDE_MODELS, CLAUDE_ALIASES, CLAUDE_EFFORTS,
  LONG_CONTEXT_MIN_TOKENS, CODEX_DEFAULT_EFFORTS,
} = require(/* turbopackIgnore: true */ '@build-studio/shared/cli')

// Unified agent model catalog for the CLI/model/effort cascade (Agents tab +
// global Model tab): per-CLI model lists, and per-model effort variants.
//   claude  — CLI aliases + models.dev anthropic provider (no models command)
//   codex   — models.dev openai provider (codex CLI has no models command)
//   opencode — `opencode models` + models.dev reasoning_options
// Cached installation-wide; works with zero project-servers running.
export async function GET(req: Request) {
  try {
    const refresh = new URL(req.url).searchParams.get('refresh')
    const cat = await opencodeCatalog.getCatalog({ refresh: refresh === '1' || refresh === 'true' })
    const efforts = cat.efforts || {}
    const contexts = cat.contexts || {}
    const codexEfforts: Record<string, string[]> = {}
    for (const id of cat.openaiModels || []) {
      if (efforts[`openai/${id}`]) codexEfforts[id] = efforts[`openai/${id}`]
    }

    // Claude picker: the CLI's moving aliases first, then every discovered
    // anthropic id, each followed by its `[1m]` variant when the model is
    // actually long-context. Efforts are keyed to match — aliases resolve
    // through MODEL_IDS and `[1m]` variants share their base model's values.
    // models.dev lists each model twice for older families — a bare id and a
    // dated snapshot (`claude-sonnet-4-5` + `claude-sonnet-4-5-20250929`).
    // The snapshots are exact duplicates for picker purposes, so drop them and
    // sort what's left; models.dev's own order is arbitrary.
    const discovered: string[] = (cat.anthropicModels || [])
      .filter((id: string) => !/-\d{8}$/.test(id))
      .sort()
    const claudeEfforts: Record<string, string[]> = {}
    const effortsFor = (id: string) => efforts[`anthropic/${id}`] || CLAUDE_EFFORTS
    const claudeModels: string[] = []
    for (const alias of CLAUDE_ALIASES) {
      const base = String(MODEL_IDS[alias] || alias).replace(/\[1m\]$/, '')
      if (!discovered.includes(base)) continue // alias points at a model models.dev dropped
      claudeModels.push(alias)
      claudeEfforts[alias] = effortsFor(base)
    }
    for (const id of discovered) {
      claudeModels.push(id)
      claudeEfforts[id] = effortsFor(id)
      if ((contexts[`anthropic/${id}`] || 0) >= LONG_CONTEXT_MIN_TOKENS) {
        claudeModels.push(`${id}[1m]`)
        claudeEfforts[`${id}[1m]`] = effortsFor(id)
      }
    }
    // models.dev unreachable and no cache — fall back to the static alias
    // list so the picker degrades to "fewer options", never to empty.
    const claude = claudeModels.length > 0
      ? { models: claudeModels, efforts: claudeEfforts, defaultEfforts: CLAUDE_EFFORTS }
      : { models: CLAUDE_MODELS, efforts: {}, defaultEfforts: CLAUDE_EFFORTS }

    return NextResponse.json({
      fetchedAt: cat.fetchedAt,
      cached: cat.cached,
      ...(cat.stale ? { stale: true } : {}),
      claude,
      codex: { models: cat.openaiModels || [], efforts: codexEfforts, defaultEfforts: CODEX_DEFAULT_EFFORTS },
      opencode: { models: cat.models || [], efforts },
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
