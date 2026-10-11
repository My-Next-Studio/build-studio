'use client'

import { ProjectWithStatus } from '@/lib/types'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

/** This project's block of GET /api/overview (only what the card shows). */
export interface OverviewBlock {
  name: string
  source: 'live' | 'persisted' | 'unavailable'
  work?: { kind: string; item: string | null; type?: string; step?: string; agents?: unknown[]; fromQueue?: boolean } | null
  needsOwner?: { title: string } | null
  queue?: {
    current?: { item: string; status?: { state: string } | null } | null
    next?: { item: string; action: string | null; ready: boolean | null; reason?: string } | null
    pendingCount?: number
  } | null
}

const QUEUE_STATE: Record<string, string> = {
  running: 'running', waiting_for_owner: 'waiting for you', ready_to_merge: 'ready to merge', finished: 'finished', stopped: 'stopped',
}

/** What runs, what needs the owner, and the queue's next job: one line each, only when there is something. */
function WorkSummary({ o }: { o: OverviewBlock }) {
  const line: React.CSSProperties = { fontFamily: 'var(--mono)', fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
  const agents = o.work?.agents?.length || 0
  const current = o.queue?.current
  const next = o.queue?.next
  if (!o.work && !o.needsOwner && !current && !next && o.source === 'live') return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginBottom: 12 }}>
      {o.source !== 'live' && (
        <div style={{ ...line, color: 'var(--muted)' }}>{o.source === 'persisted' ? 'Server down: last recorded state' : 'Server down: status unknown'}</div>
      )}
      {o.work && (
        <div style={{ ...line, color: 'var(--text-dim)' }}>
          ▸ {o.work.item || o.work.kind} · {o.work.type || o.work.kind}{o.work.step ? ` · ${o.work.step}` : ''}{agents ? ` · ${agents} agent${agents === 1 ? '' : 's'}` : ''}
        </div>
      )}
      {!o.work && current?.status && (
        <div style={{ ...line, color: 'var(--text-dim)' }}>▸ {current.item} · {QUEUE_STATE[current.status.state] || current.status.state}</div>
      )}
      {o.needsOwner && <div style={{ ...line, color: 'var(--orange)' }} title={o.needsOwner.title}>⚠ {o.needsOwner.title}</div>}
      {next && (
        <div style={{ ...line, color: next.ready ? 'var(--green)' : 'var(--muted)' }} title={next.reason || ''}>
          Next: {next.item}{next.action ? ` (${next.action})` : ''} · {next.ready === null ? 'readiness unknown' : next.ready ? 'ready' : 'not ready'}
          {(o.queue?.pendingCount || 0) > 1 ? ` · +${(o.queue?.pendingCount || 0) - 1} more` : ''}
        </div>
      )}
    </div>
  )
}

export function ProjectCard({ project, overview }: { project: ProjectWithStatus; overview?: OverviewBlock }) {
  const router = useRouter()
  const [loading, setLoading] = useState(false)
  const [optimisticRunning, setOptimisticRunning] = useState<boolean | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)
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

  async function removeProject() {
    setRemoving(true)
    await fetch(`/api/registry/projects/${encodeURIComponent(project.name)}`, { method: 'DELETE' })
    setRemoving(false)
    setConfirmRemove(false)
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
        <button
          onClick={e => { e.stopPropagation(); setConfirmRemove(true) }}
          title="Remove from Build Studio (files stay on disk)"
          className="app-no-drag"
          style={{
            width: 20, height: 20, padding: 0, lineHeight: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'transparent', border: 'none', borderRadius: 'var(--radius)',
            color: 'var(--muted)', fontFamily: 'var(--mono)', fontSize: 12,
            cursor: 'pointer', transition: 'all 0.15s ease', flexShrink: 0,
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--red)'; e.currentTarget.style.background = 'rgba(239,68,68,0.08)' }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--muted)'; e.currentTarget.style.background = 'transparent' }}
        >
          ✕
        </button>
      </div>

      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)',
        marginBottom: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {project.path}
      </div>

      {overview && <WorkSummary o={overview} />}

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

      {confirmRemove && (
        <div
          onClick={e => { e.stopPropagation(); setConfirmRemove(false) }}
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 100, cursor: 'default',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)',
              padding: '28px 32px',
              maxWidth: 440,
              width: '90vw',
            }}
          >
            <div style={{
              fontFamily: 'var(--mono)', fontWeight: 700, fontSize: 14,
              color: 'var(--text)', marginBottom: 10, letterSpacing: '-0.01em',
            }}>
              Remove {project.name}?
            </div>
            <p style={{
              fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)',
              lineHeight: 1.7, margin: '0 0 6px',
            }}>
              This removes the project from Build Studio and stops its
              project server if it is running.
            </p>
            <p style={{
              fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)',
              lineHeight: 1.7, margin: '0 0 22px',
            }}>
              The project folder and all its files <strong style={{ color: 'var(--text)' }}>remain on disk</strong> at{' '}
              <span style={{ color: 'var(--text)' }}>{project.path}</span> — nothing is deleted there.
              You can bring it back later with &ldquo;↪ Onboard project&rdquo;.
            </p>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button
                onClick={() => setConfirmRemove(false)}
                style={{
                  padding: '7px 16px', borderRadius: 'var(--radius)',
                  background: 'transparent',
                  border: '1px solid var(--border)',
                  color: 'var(--muted)', fontFamily: 'var(--mono)',
                  fontSize: 11, cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={removeProject}
                disabled={removing}
                style={{
                  padding: '7px 16px', borderRadius: 'var(--radius)',
                  background: 'rgba(239,68,68,0.12)',
                  border: '1px solid rgba(239,68,68,0.3)',
                  color: 'var(--red)', fontFamily: 'var(--mono)',
                  fontWeight: 700, fontSize: 11,
                  cursor: removing ? 'wait' : 'pointer',
                  opacity: removing ? 0.5 : 1,
                }}
              >
                {removing ? 'Removing…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
