import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { processManager, registry } = require(/* turbopackIgnore: true */ '@build-studio/shared')
  const { name } = await params

  const debug: string[] = []
  try {
    const project = registry.get(name)
    debug.push(`project: ${JSON.stringify(project)}`)

    let cwd: string
    try { cwd = process.cwd() } catch { cwd = 'UNAVAILABLE' }
    debug.push(`hub cwd: ${cwd}`)
    debug.push(`hub __dirname resolves shared to: ${require.resolve('@build-studio/shared')}`)

    const result = await processManager.startProject(name)
    debug.push(`spawn result: pid=${result.pid} port=${result.port} alreadyRunning=${result.alreadyRunning}`)

    return NextResponse.json({ ...result, debug })
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e)
    const stack = e instanceof Error ? e.stack : undefined
    return NextResponse.json({ error: message, stack, debug }, { status: 400 })
  }
}
