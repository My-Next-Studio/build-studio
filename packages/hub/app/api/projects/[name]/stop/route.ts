import { NextResponse } from 'next/server'

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { processManager } = require(/* turbopackIgnore: true */ '@build-studio/shared')
  const { name } = await params
  const result = await processManager.stopProject(name)
  return NextResponse.json(result)
}
