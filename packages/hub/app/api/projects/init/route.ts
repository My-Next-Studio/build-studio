import { NextResponse } from 'next/server'
import path from 'path'
import fs from 'fs'

export async function POST(req: Request) {
  const { name, dirPath, port } = await req.json()

  if (!name || !dirPath) {
    return NextResponse.json({ error: 'name and dirPath required' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { paths: sharedPaths } = require(/* turbopackIgnore: true */ '@build-studio/shared')
  const targetPath: string = sharedPaths.resolveUserPath(dirPath)
  const configPath = path.join(targetPath, '.build-studio', 'config.yaml')

  if (fs.existsSync(configPath)) {
    return NextResponse.json({ error: 'Project already initialized at this path' }, { status: 409 })
  }

  // Dynamic requires to prevent Turbopack from tracing filesystem operations in these modules
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { registry } = require(/* turbopackIgnore: true */ '@build-studio/shared')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { scaffoldProject } = require(/* turbopackIgnore: true */ '@build-studio/project-server/lib/scaffold')

  const assignedPort = port || registry.nextAvailablePort()

  try {
    scaffoldProject(targetPath, { name, port: assignedPort })
    registry.add(name, targetPath, assignedPort)
    return NextResponse.json({ ok: true, name, path: targetPath, port: assignedPort })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
