import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { recordingDir, nextVersion } from '@/lib/demo/recordings'
import { buildAutoEdl, renderEdl, writeChapters } from '@/lib/demo/edl'

// POST { target?, manualShare? } → generate a fresh rough cut from the manifest.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const body = await req.json().catch(() => ({}))
  const target = Number(body.target) || 300
  const manualShare = body.manualShare != null ? Number(body.manualShare) : 0.6

  let dir: string
  try { dir = recordingDir(id) } catch { return NextResponse.json({ error: 'bad id' }, { status: 400 }) }
  const manifestPath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) return NextResponse.json({ error: 'No manifest — external recordings are edited as a single clip (not yet wired here).' }, { status: 400 })

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    const edl = buildAutoEdl(dir, manifest, { target, manualShare })
    const v = nextVersion(dir)
    edl.version = v
    fs.writeFileSync(path.join(dir, `edl.v${v}.json`), JSON.stringify(edl, null, 2))
    const file = `rough-cut.v${v}.mp4`
    const durationSec = renderEdl(dir, edl, path.join(dir, file))
    writeChapters(edl, path.join(dir, `chapters.v${v}.txt`))
    return NextResponse.json({ version: v, file, durationSec, clips: edl.clips.length })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
