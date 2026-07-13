import { NextResponse } from 'next/server'
import { recordingStatus, bootedSimulators } from '@/lib/demo/recorder'

export async function GET() {
  try {
    const status = recordingStatus()
    return NextResponse.json({ ...status, booted: 'booted' in status ? status.booted : bootedSimulators() })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
