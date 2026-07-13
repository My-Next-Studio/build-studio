import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { recordingDir } from '@/lib/demo/recordings'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const p = path.join(recordingDir(id), 'notes.json')
    return NextResponse.json(fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : { notes: [] })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const dir = recordingDir(id)
    const body = await req.json()
    if (!body || !Array.isArray(body.notes)) return NextResponse.json({ error: 'notes[] required' }, { status: 400 })
    fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify(body, null, 2))
    return NextResponse.json({ ok: true, count: body.notes.length })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
  }
}
