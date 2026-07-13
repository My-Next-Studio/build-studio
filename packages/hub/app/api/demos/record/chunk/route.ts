import { NextResponse } from 'next/server'
import { appendChunk } from '@/lib/demo/recorder'

// Receives raw MediaRecorder webm chunks from the renderer during window capture.
export async function POST(req: Request) {
  try {
    const buf = Buffer.from(await req.arrayBuffer())
    appendChunk(buf)
    return new NextResponse(null, { status: 204 })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
  }
}
