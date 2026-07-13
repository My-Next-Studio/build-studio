'use client'

import { ProjectWithStatus } from '@/lib/types'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

export function ProjectCard({ project }: { project: ProjectWithStatus }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [optimisticRunning, setOptimisticRunning] = useState<boolean | null>(null)
  const running = optimisticRunning ?? (project.status?.running ?? false)

  // Clear optimistic state once server-side data catches up
  useEffect(() => {
    if (optimisticRunning !== null && project.status?.running === optimisticRunning) {
      setOptimisticRunning(null)
    }
  }, [project.status?.running, optimisticRunning])

  async function toggleServer(e: React.MouseEvent) {
    e.stopPropagation()
    setLoading(true)
    const action = running ? 'stop' : 'start'
    await fetch(`/api/projects/${project.name}/${action}`, { method: 'POST' })
    setOptimisticRunning(!running)
    setLoading(false)
    router.refresh()
  }

  const uptime = project.status?.health?.uptime
  const uptimeStr = uptime
    ? uptime > 3600 ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`
    : uptime > 60 ? `${Math.floor(uptime / 60)}m`
    : `${Math.floor(uptime)}s`
    : null

  return (
    <div
      onClick={() => router.push(`/projects/${project.name}`)}
      className="group"
      style={{
        background: 'var(--surface)',
        border: `1px solid ${running ? 'rgba(34,197,94,0.15)' : 'var(--border-subtle)'}`,
        borderRadius: 'var(--radius-lg)',
        padding: '16px 18px',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
        position: 'relative',
        overflow: 'hidden',
      }}
      onMouseEnter={e => {
        e.currentTarget.style.borderColor = running ? 'rgba(34,197,94,0.3)' : 'var(--border)'
        e.currentTarget.style.background = 'var(--surface2)'
      }}
      onMouseLeave={e => {
        e.currentTarget.style.borderColor = running ? 'rgba(34,197,94,0.15)' : 'var(--border-subtle)'
        e.currentTarget.style.background = 'var(--surface)'
      }}
    >
      {/* Top glow line for running projects */}
      {running && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, height: 1,
          background: 'linear-gradient(90deg, transparent, rgba(34,197,94,0.4), transparent)',
        }} />
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        {/* Status dot */}
        <span style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          background: running ? 'var(--green)' : 'var(--muted)',
          boxShadow: running ? '0 0 8px rgba(34,197,94,0.4)' : 'none',
        }} />
        <span style={{
          fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 13,
          color: 'var(--text)', letterSpacing: '-0.01em',
        }}>
          {project.name}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)',
        }}>
          :{project.port}
        </span>
      </div>

      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)',
        marginBottom: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {project.path}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        {uptimeStr && (
          <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>
            ↑ {uptimeStr}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          onClick={toggleServer}
          disabled={loading}
          className="app-no-drag"
          style={{
            padding: '4px 12px', borderRadius: 'var(--radius)',
            fontFamily: 'var(--mono)', fontWeight: 600, fontSize: 10,
            letterSpacing: '0.03em', textTransform: 'uppercase',
            background: running ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)',
            color: running ? 'var(--red)' : 'var(--green)',
            border: `1px solid ${running ? 'rgba(239,68,68,0.15)' : 'rgba(34,197,94,0.15)'}`,
            cursor: loading ? 'wait' : 'pointer',
            opacity: loading ? 0.5 : 1,
            transition: 'all 0.15s ease',
          }}
        >
          {loading ? '...' : running ? 'Stop' : 'Start'}
        </button>
      </div>
    </div>
  )
}
