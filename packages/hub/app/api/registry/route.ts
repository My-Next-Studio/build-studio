import { NextResponse } from 'next/server'

export async function GET() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { registry } = require(/* turbopackIgnore: true */ '@build-studio/shared')
  const projects = registry.list()
  return NextResponse.json({ projects })
}

export async function POST(req: Request) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { registry } = require(/* turbopackIgnore: true */ '@build-studio/shared')
  const { name, path, port } = await req.json()
  if (!name || !path) {
    return NextResponse.json({ error: 'name and path required' }, { status: 400 })
  }
  const assignedPort = port || registry.nextAvailablePort()
  registry.add(name, path, assignedPort)
  return NextResponse.json({ ok: true, name, path, port: assignedPort })
}
