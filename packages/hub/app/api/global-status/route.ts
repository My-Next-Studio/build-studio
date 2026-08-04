import { NextResponse } from 'next/server'
import http from 'http'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { registry, processManager } = require(/* turbopackIgnore: true */ '@build-studio/shared')

interface CiSummary {
  status: string
  conclusion: string | null
  url: string | null
  title: string | null
  id: number
}

interface AlertCounts {
  critical: number; high: number; moderate: number; low: number; info: number
  total: number; actionable: number
}

interface MonitorSummary {
  configured: boolean
  ci: CiSummary | null
  counts: AlertCounts
  stale: boolean
}

interface ProjectStatus {
  name: string
  port: number
  running: boolean
  workflow: {
    id: string
    type: string
    input: string
    currentStep: string
    round: number
    waitingForInput: boolean
    progress: { done: number; total: number }
  } | null
  // CI state and alert counts ride along with the workflow poll so the tab
  // selector, the status bar and the Monitor tab can all read them without
  // being open. Cheap to include: the project-server serves both from an
  // in-memory cache, so this adds no GitHub traffic at this cadence.
  ci?: CiSummary | null
  alerts?: AlertCounts | null
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

export async function GET() {
  let projects: { name: string; port: number }[]
  try {
    projects = registry.list()
  } catch (e) {
    console.error('[global-status] registry.list() failed', e)
    return NextResponse.json({ statuses: [], error: 'registry-read-failed' })
  }
  if (!Array.isArray(projects)) {
    console.error('[global-status] registry.list() returned non-array', projects)
    return NextResponse.json({ statuses: [], error: 'registry-shape-invalid' })
  }
  if (projects.length === 0) {
    console.warn('[global-status] registry.list() returned 0 projects')
  }

  // Use allSettled so one project's getStatus or fetch failure can't take the
  // whole response down. A failed sub-promise just yields a placeholder and the
  // others still appear in the bar.
  const settled = await Promise.allSettled(
    projects.map(async (p: { name: string; port: number }) => {
      const status = await processManager.getStatus(p.name)
      if (!status.running) {
        return { name: p.name, port: p.port, running: false, workflow: null } as ProjectStatus
      }

      // Monitor summary is fetched alongside the workflow, not instead of it:
      // a project with no workflow still has CI and alerts worth reporting, and
      // a monitor failure must never cost us the workflow status. Hence the
      // separate catch rather than one try around both.
      let monitor: MonitorSummary | null = null
      try {
        monitor = await httpGetJson(`http://localhost:${status.port}/api/monitor/summary`, 2000) as MonitorSummary
      } catch {
        monitor = null
      }
      const ci = monitor?.ci ?? null
      const alerts = monitor?.counts ?? null

      try {
        const wfData = await httpGetJson(`http://localhost:${status.port}/api/workflow`, 2000) as { workflow?: Record<string, unknown> }
        const wf = wfData?.workflow as Record<string, unknown> | undefined
        if (!wf) {
          return { name: p.name, port: status.port, running: true, workflow: null, ci, alerts }
        }

        // Calculate progress: count done agents in current step
        const steps = (wf.steps || {}) as Record<string, { agents?: { status: string }[]; status?: string }>
        const currentStep = wf.currentStep as string
        const currentStepData = steps[currentStep]
        const agents = currentStepData?.agents || []
        const done = agents.filter((a: { status: string }) => a.status === 'done' || a.status === 'error').length
        const total = agents.length

        // Determine if waiting for user input
        const allDone = total > 0 && done === total
        const isPending = currentStepData?.status === 'pending' && total === 0
        const isErrorOrBlocked = currentStepData?.status === 'error' || currentStepData?.status === 'blocked'
        const waitingForInput = allDone || isPending || isErrorOrBlocked || currentStep === 'completed'

        return {
          name: p.name,
          port: status.port,
          running: true,
          workflow: {
            id: wf.id as string,
            type: wf.type as string,
            input: wf.input as string,
            currentStep,
            round: (wf.round || 1) as number,
            waitingForInput,
            progress: { done, total },
          },
          ci,
          alerts,
        }
      } catch {
        return { name: p.name, port: status.port, running: true, workflow: null, ci, alerts } as ProjectStatus
      }
    })
  )

  const statuses: ProjectStatus[] = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value
    const p = projects[i]
    console.warn(`[global-status] sub-status for ${p?.name} failed`, r.reason)
    return { name: p?.name ?? 'unknown', port: p?.port ?? 0, running: false, workflow: null }
  })

  return NextResponse.json({ statuses })
}
