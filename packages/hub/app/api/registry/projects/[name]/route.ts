import { NextResponse } from 'next/server'

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ name: string }> }
) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { registry } = require(/* turbopackIgnore: true */ '@build-studio/shared')
  const { name } = await params
  const removed = registry.remove(name)
  if (!removed) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
