import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadHubConfig, saveHubConfig, normalizeCliBlock, hasGlobalCliDefaults, validateCliPatch, normalizeStepGroups } = require(/* turbopackIgnore: true */ '@build-studio/shared/cli')

// Global (installation-wide) agent-CLI defaults — ~/.build-studio/config.json
// under `cli`, edited from the hub's Model tab. Projects opt into these via
// their Model page "Use default" toggle (local.json → cli.use_global).
//
// Settings are keyed by STEP GROUP rather than by agent role; the grouping
// itself is configuration (`step_groups`), returned here so the page can
// render a row per group without a rebuild.
export async function GET() {
  try {
    const cfg = loadHubConfig()
    const raw = cfg.cli
    return NextResponse.json({
      cli: hasGlobalCliDefaults(raw) ? normalizeCliBlock(raw) : null,
      step_groups: normalizeStepGroups(cfg.step_groups || null),
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    // Same validator as the project route — one shape, one implementation.
    const { patch, error } = validateCliPatch(body)
    if (error) return NextResponse.json({ error }, { status: 400 })

    // Merge over the existing block. The UI sends partial patches; cleared
    // fields arrive as explicit nulls and stay cleared. `groups` is replaced
    // wholesale when present, so the page sends the complete group map.
    const current = normalizeCliBlock(loadHubConfig().cli)
    const merged = { ...current, groups: { ...current.groups } }
    for (const [key, value] of Object.entries(patch)) {
      if (key === 'groups') continue
      if (key === 'use_global') continue // meaningless installation-wide
      merged[key as keyof typeof merged] = value as never
    }
    if (patch.groups) merged.groups = patch.groups

    saveHubConfig({ cli: merged })
    return NextResponse.json({ cli: hasGlobalCliDefaults(merged) ? normalizeCliBlock(merged) : null })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
