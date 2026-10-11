import { NextResponse } from 'next/server'
import http from 'http'
import fs from 'fs'
import path from 'path'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { registry, processManager } = require(/* turbopackIgnore: true */ '@build-studio/shared')

/**
 * The cross-project overview a remote assistant reads
 * (docs/plans/work-queue-and-remote-overview.md › The overview).
 *
 * Strictly read-only. Each running project server describes itself
 * (GET /api/overview: its work, agents, progress, what needs the owner, and
 * its queue). A project whose server does not answer is read from its state
 * files on disk and marked `persisted`; one with neither is `unavailable`.
 * Neither is ever reported as idle: an unreachable server proves nothing
 * about its work.
 */

type Source = 'live' | 'persisted' | 'unavailable'

function httpGetJson(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = ''
      res.on('data', (chunk: string) => { data += chunk })
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) return reject(new Error(`HTTP ${res.statusCode}`))
        try { resolve(JSON.parse(data)) } catch { reject(new Error('Invalid JSON')) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')) })
  })
}

function readJson(file: string): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

/** What the state files say, for a project whose server is not answering. */
function persisted(name: string, projectPath: string | undefined, reason: string) {
  const observedAt = new Date().toISOString()
  const dir = projectPath ? path.join(projectPath, '.build-studio') : null
  const wf = dir ? readJson(path.join(dir, 'workflow-state.json')) : null
  const queue = dir ? readJson(path.join(dir, 'work-queue.json')) : null
  const source: Source = wf || queue ? 'persisted' : 'unavailable'
  const pending = (queue?.pending as { id: string; item: string; action?: string }[] | undefined) || []
  return {
    name,
    source,
    observedAt,
    serverError: reason,
    note: source === 'persisted'
      ? 'The project server is not answering; this is what its state files last recorded. Running agents and readiness are unknown.'
      : 'The project server is not answering and it has no state files; its status is unknown, not idle.',
    work: wf ? {
      kind: 'workflow', id: wf.id, type: wf.type, item: wf.itemId || null, input: wf.input || null,
      step: wf.currentStep, round: wf.round || 1, updatedAt: wf.updatedAt || null,
    } : null,
    queue: queue ? {
      current: queue.current || null,
      next: pending[0] ? { entryId: pending[0].id, item: pending[0].item, action: pending[0].action || null, ready: null } : null,
      following: pending.slice(1, 4),
      pendingCount: pending.length,
    } : null,
  }
}

export async function GET() {
  let projects: { name: string; port: number; path?: string }[]
  try {
    projects = registry.list()
  } catch (e) {
    return NextResponse.json({ observedAt: new Date().toISOString(), projects: [], error: `registry could not be read: ${(e as Error).message}` })
  }

  const blocks = await Promise.all(projects.map(async (p) => {
    let port = p.port
    try {
      const status = await processManager.getStatus(p.name)
      if (status && status.port) port = status.port
      if (!status || !status.running) return persisted(p.name, p.path, 'not running')
    } catch (e) {
      return persisted(p.name, p.path, (e as Error).message)
    }
    try {
      const live = await httpGetJson(`http://127.0.0.1:${port}/api/overview`, 3000) as Record<string, unknown>
      return { ...live, name: p.name, source: 'live' as Source }
    } catch (e) {
      return persisted(p.name, p.path, (e as Error).message)
    }
  }))

  return NextResponse.json({ observedAt: new Date().toISOString(), projects: blocks })
}
