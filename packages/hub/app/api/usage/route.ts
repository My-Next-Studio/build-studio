import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { usageCollectors } = require(/* turbopackIgnore: true */ '@build-studio/shared')

// Global usage monitor (FU-2) — Claude / Codex / OpenRouter remaining limits.
// Collection is server-side so credentials never reach the client; the
// response contains utilization numbers/timestamps only. Any provider may be
// absent or down — per-provider status fields carry the failure, never a 500.
export async function GET() {
  try {
    const result = await usageCollectors.collectUsage()
    return NextResponse.json(result)
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
