import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { loadHubConfig, saveHubConfig, normalizeCliBlock, hasGlobalCliDefaults, isValidEffortToken, VALID_CLIS } = require(/* turbopackIgnore: true */ '@build-studio/shared/cli')

// Global (installation-wide) agent-CLI defaults — ~/.build-studio/config.json
// under `cli`, edited from the hub's Model tab. Projects opt into these via
// their Agents tab "Use default" toggle (local.json → cli.use_global).
export async function GET() {
  try {
    const raw = loadHubConfig().cli
    return NextResponse.json({
      cli: hasGlobalCliDefaults(raw) ? normalizeCliBlock(raw) : null,
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const errors: string[] = []
    if (body.default !== undefined && body.default !== null && !VALID_CLIS.includes(body.default)) {
      errors.push(`default must be one of ${VALID_CLIS.join(', ')}`)
    }
    for (const key of ['developer_cli', 'reviewer_cli']) {
      if (body[key] !== undefined && body[key] !== null && !VALID_CLIS.includes(body[key])) {
        errors.push(`${key} must be one of ${VALID_CLIS.join(', ')} or null`)
      }
    }
    for (const key of ['default_model', 'developer_model', 'reviewer_model']) {
      if (body[key] !== undefined && body[key] !== null && typeof body[key] !== 'string') {
        errors.push(`${key} must be a string (provider/model) or null`)
      }
    }
    for (const key of ['default_effort', 'developer_effort', 'reviewer_effort']) {
      if (body[key] !== undefined && body[key] !== null && !isValidEffortToken(body[key])) {
        errors.push(`${key} must be an effort token (e.g. low, high, max) or null`)
      }
    }
    if (errors.length > 0) return NextResponse.json({ error: errors.join('; ') }, { status: 400 })

    // Merge over the existing block — the UI sends partial patches; cleared
    // fields arrive as explicit nulls and stay cleared.
    const current = normalizeCliBlock(loadHubConfig().cli)
    const merged = { ...current }
    for (const key of Object.keys(current) as (keyof typeof current)[]) {
      if (body[key] !== undefined) merged[key] = body[key]
    }
    saveHubConfig({ cli: merged })
    return NextResponse.json({ cli: hasGlobalCliDefaults(merged) ? normalizeCliBlock(merged) : null })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
