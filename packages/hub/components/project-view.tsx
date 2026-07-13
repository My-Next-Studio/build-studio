'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { ProjectDashboard } from './project-dashboard'

interface Props {
  name: string
  path: string
  port: number
  running: boolean
  health: { ok: boolean; uptime: number } | null
  functionsConfig?: Record<string, { enabled?: boolean }>
  portalsConfig?: Array<{ name: string; url: string }>
}

export function ProjectView({ name, port, running: initialRunning, functionsConfig, portalsConfig }: Props) {
  const router = useRouter()
  const [running, setRunning] = useState(initialRunning)
  const [starting, setStarting] = useState(false)

  async function startServer() {
    setStarting(true)
    await fetch(`/api/projects/${name}/start`, { method: 'POST' })

    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500))
      const res = await fetch(`/api/projects/${name}/health`)
      const status = await res.json()
      if (status.running && status.health?.ok) {
        setRunning(true)
        setStarting(false)
        return
      }
    }
    setStarting(false)
    router.refresh()
  }

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {running ? (
        <ProjectDashboard name={name} port={port} functionsConfig={functionsConfig} portalsConfig={portalsConfig} />
      ) : (
        <div className="flex-1 flex items-center justify-center">
          {starting ? (
            <div className="text-center">
              <div style={{ fontSize: 32, marginBottom: 12 }}>&#9881;</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--text-dim)' }}>Starting server...</div>
            </div>
          ) : (
            <div className="text-center">
              <div style={{ fontSize: 32, marginBottom: 12 }}>&#9632;</div>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 14, color: 'var(--text-dim)', marginBottom: 16 }}>Server is stopped</div>
              <button onClick={startServer} className="rounded px-5 py-2.5" style={{
                background: 'var(--green)', border: 'none', color: '#0d0f14',
                fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 13, cursor: 'pointer',
              }}>
                Start Server
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
