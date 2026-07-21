import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { opencodeCatalog } = require(/* turbopackIgnore: true */ '@build-studio/shared')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { CLAUDE_MODELS, CLAUDE_EFFORTS, CODEX_DEFAULT_EFFORTS } = require(/* turbopackIgnore: true */ '@build-studio/shared/cli')

// Unified agent model catalog for the CLI/model/effort cascade (Agents tab +
// global Model tab): per-CLI model lists, and per-model effort variants.
//   claude  — static list (the CLI has no models command; ids from shared/cli)
//   codex   — models.dev openai provider (codex CLI has no models command)
//   opencode — `opencode models` + models.dev reasoning_options
// Cached installation-wide; works with zero project-servers running.
export async function GET(req: Request) {
  try {
    const refresh = new URL(req.url).searchParams.get('refresh')
    const cat = await opencodeCatalog.getCatalog({ refresh: refresh === '1' || refresh === 'true' })
    const efforts = cat.efforts || {}
    const codexEfforts: Record<string, string[]> = {}
    for (const id of cat.openaiModels || []) {
      if (efforts[`openai/${id}`]) codexEfforts[id] = efforts[`openai/${id}`]
    }
    return NextResponse.json({
      fetchedAt: cat.fetchedAt,
      cached: cat.cached,
      ...(cat.stale ? { stale: true } : {}),
      claude: { models: CLAUDE_MODELS, efforts: CLAUDE_EFFORTS },
      codex: { models: cat.openaiModels || [], efforts: codexEfforts, defaultEfforts: CODEX_DEFAULT_EFFORTS },
      opencode: { models: cat.models || [], efforts },
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: message }, { status: 502 })
  }
}
