import { NextResponse } from 'next/server'
import { listRecordings } from '@/lib/demo/recordings'

export async function GET() {
  try {
    return NextResponse.json(listRecordings())
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
