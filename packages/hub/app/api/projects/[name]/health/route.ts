import { NextResponse } from 'next/server'

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { processManager } = require(/* turbopackIgnore: true */ '@build-studio/shared')
  const { name } = await params
  const status = await processManager.getStatus(name)
  return NextResponse.json(status)
}
