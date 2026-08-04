import { NextResponse } from 'next/server'
import http from 'http'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { registry, processManager } = require(/* turbopackIgnore: true */ '@build-studio/shared')

// The cross-project alert list behind the Monitor tab.
//
// This fans out to each running project-server's /api/monitor/alerts, which are
// memory reads over a backoff-refreshed cache — so the fan-out is cheap no
// matter how often the tab polls, and a stopped project simply contributes
// nothing rather than failing the request.
//
// Nothing is stored here or anywhere downstream. The list is derived on every
// call, which is what makes a resolved alert disappear on its own: fix the
// advisory or let the nightly job go green, and the row is gone at the next
// poll with no acknowledgement, no reconciliation and no chance of showing
// something that was fixed last week.

interface Alert {
  source: string
  kind: string
  project: string
  id: string
  severity: string
  title: string
  detail: string
  url: string | null
  since: string | null
}

function httpGetJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { reject(new Error('Invalid JSON')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
  })
}

const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info']

export async function GET() {
  let projects: { name: string; port: number }[]
  try {
    projects = registry.list()
  } catch (e) {
    console.error('[monitor] registry.list() failed', e)
    return NextResponse.json({ alerts: [], projects: [], error: 'registry-read-failed' })
  }
  if (!Array.isArray(projects)) {
    return NextResponse.json({ alerts: [], projects: [], error: 'registry-shape-invalid' })
  }

  const settled = await Promise.allSettled(
    projects.map(async (p) => {
      const status = await processManager.getStatus(p.name)
      if (!status.running) return { name: p.name, running: false, alerts: [] as Alert[] }
      const data = await httpGetJson(`http://localhost:${status.port}/api/monitor/alerts`, 3000) as {
        alerts?: Alert[]; configured?: boolean; warning?: string
      }
      return {
        name: p.name,
        running: true,
        configured: data?.configured ?? false,
        warning: data?.warning,
        alerts: Array.isArray(data?.alerts) ? data.alerts : [],
      }
    })
  )

  const perProject = settled.map((r, i) =>
    r.status === 'fulfilled'
      ? r.value
      : { name: projects[i]?.name ?? 'unknown', running: false, alerts: [] as Alert[], warning: String(r.reason?.message || r.reason) }
  )

  const alerts = perProject.flatMap((p) => p.alerts)
  alerts.sort((a, b) => {
    const d = SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    if (d !== 0) return d
    const p = a.project.localeCompare(b.project)
    return p !== 0 ? p : a.title.localeCompare(b.title)
  })

  return NextResponse.json({
    alerts,
    projects: perProject.map((p) => ({
      name: p.name,
      running: p.running,
      configured: 'configured' in p ? p.configured : false,
      warning: 'warning' in p ? p.warning : undefined,
    })),
  })
}
