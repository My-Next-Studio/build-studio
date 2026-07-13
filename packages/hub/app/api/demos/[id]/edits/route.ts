import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { recordingDir, nextVersion } from '@/lib/demo/recordings'
import { applyEdits, renderEdl, writeChapters, type Edit } from '@/lib/demo/edl'

// POST { fromVersion, edits: [{from,to,factor?|cut?}] } → split + re-render a new cut.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const fromVersion = Number(body.fromVersion)
  const edits: Edit[] = Array.isArray(body.edits) ? body.edits : []
  if (!fromVersion || !edits.length) return NextResponse.json({ error: 'fromVersion and edits[] required' }, { status: 400 })

  let dir: string
  try { dir = recordingDir(id) } catch { return NextResponse.json({ error: 'bad id' }, { status: 400 }) }
  const baseEdlPath = path.join(dir, `edl.v${fromVersion}.json`)
  if (!fs.existsSync(baseEdlPath)) return NextResponse.json({ error: `edl.v${fromVersion}.json not found` }, { status: 404 })

  try {
    const baseEdl = JSON.parse(fs.readFileSync(baseEdlPath, 'utf8'))
    const next = applyEdits(baseEdl, edits)
    const v = nextVersion(dir)
    next.version = v
    fs.writeFileSync(path.join(dir, `edl.v${v}.json`), JSON.stringify(next, null, 2))
    const file = `rough-cut.v${v}.mp4`
    const durationSec = renderEdl(dir, next, path.join(dir, file))
    writeChapters(next, path.join(dir, `chapters.v${v}.txt`))
    return NextResponse.json({ version: v, file, durationSec, clips: next.clips.length })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
