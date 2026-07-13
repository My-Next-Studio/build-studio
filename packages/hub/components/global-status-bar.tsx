'use client'

import { useEffect, useState } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { WORKFLOW_TYPE_TO_FUNCTION, FUNCTION_SHORT_LABELS } from '@/lib/functions'
import { DemoRecordingControl } from '@/components/demo-recording-control'

interface WorkflowInfo {
  id: string
  type: string
  input: string
  currentStep: string | null
  round: number
  waitingForInput: boolean
  progress: { done: number; total: number }
}

interface ProjectStatus {
  name: string
  port: number
  running: boolean
  workflow: WorkflowInfo | null
}

export function GlobalStatusBar() {
  const router = useRouter()
  const pathname = usePathname()
  const [statuses, setStatuses] = useState<ProjectStatus[]>([])

  useEffect(() => {
    let active = true
    async function poll() {
      try {
        const res = await fetch('/api/global-status')
        if (!res.ok) {
          console.warn(`[global-status] poll non-OK ${res.status} — keeping last statuses`)
          return
        }
        const data = await res.json()
        // Only update when the payload looks valid. A transient empty/undefined
        // response (registry race, Promise.all hiccup, etc.) used to blank the
        // entire project switcher in the top bar; ignore those.
        if (!Array.isArray(data?.statuses)) {
          console.warn('[global-status] poll returned malformed payload, keeping last statuses', data)
          return
        }
        if (active) setStatuses(data.statuses)
      } catch (e) {
        console.warn('[global-status] poll failed, keeping last statuses', e)
      }
    }
    poll()
    const interval = setInterval(poll, 6000)
    return () => { active = false; clearInterval(interval) }
  }, [])

  const currentProject = pathname.startsWith('/projects/')
    ? decodeURIComponent(pathname.split('/')[2])
    : null
  const isProjectPage = !!currentProject

  return (
    <div
      className="app-drag"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 16px 0 80px',
        height: 34,
        borderBottom: '1px solid var(--border-subtle)',
        background: 'var(--bg)',
        flexShrink: 0,
      }}
    >
      {isProjectPage && (
        <>
          <button
            onClick={() => router.push('/')}
            className="app-no-drag"
            style={{
              padding: '3px 8px',
              borderRadius: 'var(--radius)',
              border: 'none',
              background: 'var(--surface2)',
              color: 'var(--text-dim)',
              fontFamily: 'var(--mono)',
              fontSize: 10,
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface3)'; e.currentTarget.style.color = 'var(--text)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--surface2)'; e.currentTarget.style.color = 'var(--text-dim)' }}
          >
            ← projects
          </button>
          <span style={{ width: 1, height: 14, background: 'var(--border-subtle)', margin: '0 4px' }} />
        </>
      )}

      {statuses.map(s => {
        const isCurrent = s.name === currentProject
        const wf = s.workflow
        const waiting = wf?.waitingForInput && wf.currentStep !== 'completed'

        return (
          <button
            key={s.name}
            onClick={() => router.push(`/projects/${s.name}`)}
            className="app-no-drag"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 10px',
              borderRadius: 'var(--radius)',
              border: 'none',
              background: isCurrent ? 'var(--surface2)' : 'transparent',
              cursor: isCurrent ? 'default' : 'pointer',
              fontFamily: 'var(--mono)',
              fontSize: 10,
              color: 'var(--text)',
              fontWeight: 500,
              whiteSpace: 'nowrap',
              transition: 'all 0.15s',
              animation: waiting ? 'pulse-border 2s ease-in-out infinite' : 'none',
              outline: waiting ? '1px solid rgba(249,115,22,0.2)' : 'none',
              outlineOffset: -1,
            }}
            onMouseEnter={e => { if (!isCurrent) e.currentTarget.style.background = 'var(--surface2)' }}
            onMouseLeave={e => { if (!isCurrent) e.currentTarget.style.background = 'transparent' }}
          >
            {/* Status dot */}
            <span style={{
              width: 5, height: 5, borderRadius: '50%', flexShrink: 0,
              background: !s.running ? 'var(--muted)'
                : wf?.currentStep === 'completed' ? 'var(--green)'
                : waiting ? 'var(--orange)'
                : wf ? 'var(--yellow)'
                : 'var(--green)',
              boxShadow: waiting ? '0 0 6px rgba(249,115,22,0.4)' : 'none',
            }} />

            <span style={{ color: isCurrent ? 'var(--text)' : 'var(--text-dim)', fontWeight: isCurrent ? 600 : 500 }}>
              {s.name}
            </span>

            {wf && (
              <>
                <span style={{ color: 'var(--border)' }}>·</span>
                <span style={{ color: 'var(--muted)', fontSize: 9 }}>
                  {wf.currentStep === 'completed' ? 'done' : (wf.currentStep ?? '').replace(/_/g, ' ')}
                </span>
                {wf.progress.total > 0 && (
                  <span style={{ color: 'var(--muted)', fontSize: 9 }}>
                    {wf.progress.done}/{wf.progress.total}
                  </span>
                )}
              </>
            )}

            {waiting && (
              <span style={{
                fontSize: 8, fontWeight: 700, color: 'var(--orange)',
                textTransform: 'uppercase', letterSpacing: '0.06em',
              }}>
                {FUNCTION_SHORT_LABELS[WORKFLOW_TYPE_TO_FUNCTION[wf?.type || ''] || ''] || ''}:input
              </span>
            )}

            {!s.running && (
              <span style={{ color: 'var(--muted)', fontSize: 9 }}>off</span>
            )}
          </button>
        )
      })}

      {/* Right-aligned: Demo Recording control (Electron only; self-hides otherwise) */}
      <div style={{ flex: 1 }} />
      <DemoRecordingControl
        projectName={currentProject}
        port={statuses.find(s => s.name === currentProject)?.port ?? null}
      />
    </div>
  )
}
