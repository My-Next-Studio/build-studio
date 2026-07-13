import { NextResponse } from 'next/server'

// Maps onboardProject's structured error codes → HTTP status. Anything not
// listed here falls through to 500 (genuine server-side failure).
const ERROR_HTTP_STATUS: Record<string, number> = {
  PATH_MISSING: 400,
  NOT_GIT_REPO: 400,
  NO_CODE: 400,
  MONOREPO_NOT_SUPPORTED: 400,
  NAME_REQUIRED: 400,
  PORT_REQUIRED: 400,
  CONFIG_EXISTS: 409,
}

export async function POST(req: Request) {
  const { name, dirPath, port } = await req.json()
  if (!name || !dirPath) {
    return NextResponse.json({ error: 'name and dirPath required' }, { status: 400 })
  }

  // Dynamic requires to dodge Turbopack tracing the filesystem ops.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { registry, paths: sharedPaths } = require(/* turbopackIgnore: true */ '@build-studio/shared')
  const targetPath: string = sharedPaths.resolveUserPath(dirPath)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { onboardProject } = require(/* turbopackIgnore: true */ '@build-studio/project-server/lib/onboard')

  const assignedPort = port || registry.nextAvailablePort()

  try {
    const result = await onboardProject(targetPath, { name, port: assignedPort })
    registry.add(name, targetPath, assignedPort)
    return NextResponse.json({
      ok: true,
      name,
      path: targetPath,
      port: assignedPort,
      preset: result.preset,
      deployment: result.deployment,
      devCommands: result.devCommands,
      written: result.written,
      skipped: result.skipped,
    })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    const code = (e as { code?: string })?.code || ''
    const status = ERROR_HTTP_STATUS[code] || 500
    return NextResponse.json({ error: message, code }, { status })
  }
}
