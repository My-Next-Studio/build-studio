import { NextResponse } from 'next/server'
import { getRecording } from '@/lib/demo/recordings'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const r = getRecording(id)
    if (!r) return NextResponse.json({ error: 'not found' }, { status: 404 })
    const { dir: _dir, ...rest } = r // don't leak the absolute path
    return NextResponse.json(rest)
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
  }
}
