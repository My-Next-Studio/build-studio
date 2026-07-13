import { NextResponse } from 'next/server'
import path from 'path'

const ERROR_HTTP_STATUS: Record<string, number> = {
  PATH_MISSING: 400,
  NOT_GIT_REPO: 400,
  NO_CODE: 400,
  MONOREPO_NOT_SUPPORTED: 400,
}

export async function POST(req: Request) {
  const { dirPath } = await req.json()
  if (!dirPath) {
    return NextResponse.json({ error: 'dirPath required' }, { status: 400 })
  }
  const targetPath = path.resolve(dirPath)

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { previewOnboard } = require(/* turbopackIgnore: true */ '@build-studio/project-server/lib/onboard')

  try {
    const preview = await previewOnboard(targetPath)
    return NextResponse.json({ ok: true, preview })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    const code = (e as { code?: string })?.code || ''
    const status = ERROR_HTTP_STATUS[code] || 500
    return NextResponse.json({ error: message, code }, { status })
  }
}
