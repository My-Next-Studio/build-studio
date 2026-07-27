import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { demoRecordings } = require(/* turbopackIgnore: true */ '@build-studio/shared')

// Where demo recordings are written/read. GET reports the resolved folder and
// which precedence tier won; PUT sets (or clears) the `demoRecordingsDir` user
// setting in ~/.build-studio/config.json. An env override always wins over both.
export async function GET() {
  try {
    return NextResponse.json(demoRecordings.resolveDemoRecordingsInfo())
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function PUT(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const raw = body.demoRecordingsDir

    // null / '' clears the setting (falls back to the heuristic).
    if (raw !== null && raw !== undefined && typeof raw !== 'string') {
      return NextResponse.json({ error: 'demoRecordingsDir must be a string, empty string, or null' }, { status: 400 })
    }
    const trimmed = typeof raw === 'string' ? raw.trim() : ''
    // Guard against relative paths, which would resolve against the server's cwd.
    if (trimmed && !trimmed.startsWith('/') && !trimmed.startsWith('~')) {
      return NextResponse.json({ error: 'Path must be absolute (start with / or ~)' }, { status: 400 })
    }

    demoRecordings.setConfiguredDir(trimmed || null)
    return NextResponse.json(demoRecordings.resolveDemoRecordingsInfo())
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
