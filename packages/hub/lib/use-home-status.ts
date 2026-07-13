'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ProjectWithStatus, ProjectStatus } from './types'

const POLL_INTERVAL_MS = 30_000  // fallback poll for stopped/unreachable servers

/**
 * Keeps home-page project statuses up-to-date by:
 * 1. Subscribing to each running project server's SSE stream (direct connection)
 * 2. On any event, fetching fresh status via the hub health API
 * 3. Polling every 30s for projects that aren't running (to detect external starts)
 */
export function useHomeStatus(initial: ProjectWithStatus[]) {
  const [statuses, setStatuses] = useState<Record<string, ProjectStatus | null>>(
    () => Object.fromEntries(initial.map(p => [p.name, p.status]))
  )

  const fetchStatus = useCallback(async (name: string) => {
    try {
      const res = await fetch(`/api/projects/${encodeURIComponent(name)}/health`)
      if (!res.ok) return
      const status: ProjectStatus = await res.json()
      setStatuses(prev => ({ ...prev, [name]: status }))
    } catch {
      // ignore
    }
  }, [])

  // SSE connections for running projects
  useEffect(() => {
    const sources: EventSource[] = []

    for (const project of initial.filter(p => p.status?.running)) {
      const port = project.port
      const name = project.name
      const url = `http://localhost:${port}/api/sse`

      const source = new EventSource(url)
      sources.push(source)

      source.onmessage = () => {
        fetchStatus(name)
      }

      source.onerror = () => {
        // Silently ignore — EventSource auto-reconnects; project may be stopped
      }
    }

    return () => {
      for (const s of sources) s.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.map(p => p.port).join(',')])

  // Polling fallback — refresh all projects periodically
  useEffect(() => {
    const interval = setInterval(() => {
      for (const project of initial) {
        fetchStatus(project.name)
      }
    }, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.map(p => p.name).join(',')])

  return statuses
}
