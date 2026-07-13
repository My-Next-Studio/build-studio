import { NextResponse } from 'next/server'
import http from 'http'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { registry, processManager } = require(/* turbopackIgnore: true */ '@build-studio/shared')

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

      try {
        const wfData = await httpGetJson(`http://localhost:${status.port}/api/workflow`, 2000) as { workflow?: Record<string, unknown> }
        const wf = wfData?.workflow as Record<string, unknown> | undefined
        if (!wf) {
          return { name: p.name, port: status.port, running: true, workflow: null }
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
        }
      } catch {
        return { name: p.name, port: status.port, running: true, workflow: null } as ProjectStatus
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
