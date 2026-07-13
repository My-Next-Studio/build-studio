import { NextResponse } from 'next/server'
import { startSimulator, startWindow, stopRecording, addMarker } from '@/lib/demo/recorder'

// POST { action: 'start-simulator' | 'start-window' | 'stop' | 'marker', project?, label?, type? }
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}))
  try {
    switch (body.action) {
      case 'start-simulator': return NextResponse.json(startSimulator({ project: body.project }))
      case 'start-window': return NextResponse.json(startWindow({ project: body.project }))
      case 'stop': return NextResponse.json(await stopRecording())
      case 'marker': return NextResponse.json(addMarker({ label: body.label, type: body.type }))
      default: return NextResponse.json({ error: 'unknown action' }, { status: 400 })
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 })
  }
}
