import { NextResponse } from 'next/server'
import http from 'http'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { processManager } = require(/* turbopackIgnore: true */ '@build-studio/shared')

// POST /api/monitor/enable-alerts { project } — proxy to that project's server.
//
// Monitor is otherwise read-only; this is the single write path, and it exists
// because the alternative was a link to GitHub's settings page. On a private
// repo that link is a trap: GitHub answers an unauthenticated request with 404
// rather than a sign-in prompt, so a browser that is not logged in looks
// exactly like a broken link. Doing it server-side uses the `gh` credential
// that already reads alerts, and takes the browser out of the loop.

function httpPostJson(url: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: timeoutMs,
        headers: { 'Content-Type': 'application/json', 'Content-Length': '2' } },
      (res) => {
        let data = ''
        res.on('data', (chunk: string) => { data += chunk })
        res.on('end', () => {
          try { resolve({ status: res.statusCode || 0, body: JSON.parse(data) }) }
          catch { resolve({ status: res.statusCode || 0, body: null }) }
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
    req.end('{}')
  })
}

export async function POST(request: Request) {
  let project: string
  try {
    const body = await request.json()
    project = String(body?.project || '')
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }
  if (!project) return NextResponse.json({ error: 'project required' }, { status: 400 })

  try {
    const status = await processManager.getStatus(project)
    if (!status.running) {
      return NextResponse.json({ error: `${project}'s server is not running` }, { status: 409 })
    }
    // Enabling can take a moment — GitHub is doing real work behind the PUT.
    const r = await httpPostJson(`http://localhost:${status.port}/api/monitor/enable-alerts`, 20000)
    const body = (r.body || {}) as { error?: string }
    if (r.status >= 400) {
      return NextResponse.json({ error: body.error || `project server returned ${r.status}` }, { status: r.status })
    }
    return NextResponse.json({ ok: true, project })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
