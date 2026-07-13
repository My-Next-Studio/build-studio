'use client'

import { useEffect, useState, useCallback } from 'react'
import { useProjectApi } from '@/lib/use-project-api'

interface PlanData {
  content?: string
  config?: {
    tasks: { role: string; branch: string; instruction: string; skill?: string; model?: string }[]
    order?: string
  }
}

export function PlanTab() {
  const api = useProjectApi()
  const [plan, setPlan] = useState<PlanData | null>(null)

  const load = useCallback(async () => {
    const data = await api.get('/execution-plan')
    setPlan(data)
  }, [api])

  useEffect(() => { load() }, [load])

  async function clearPlan() {
    await api.del('/execution-plan')
    setPlan(null)
  }

  if (!plan?.content) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 40 }}>🗺️</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text-dim)', textAlign: 'center' }}>
          No execution plan yet.
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)', textAlign: 'center' }}>
          Queue an instruction → copy coordinator prompt → run in Claude Code.<br />
          The coordinator writes <code style={{ color: 'var(--accent2)' }}>docs/execution-plan.md</code> — it appears here live.
        </div>
      </div>
    )
  }

  // Strip execution config section from display
  const displayContent = plan.content.replace(/## Execution Config[\s\S]*/, '').trim()
  const config = plan.config

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Plan content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)',
          lineHeight: 1.7, whiteSpace: 'pre-wrap',
        }}>
          {displayContent}
        </div>

        {/* Config summary */}
        {config?.tasks && (
          <div style={{ marginTop: 24, padding: 16, background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8 }}>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>
              Execution Config — {config.tasks.length} task{config.tasks.length !== 1 ? 's' : ''}, {config.order || 'parallel'}
            </div>
            {config.tasks.map((t, i) => (
              <div key={i} style={{
                display: 'flex', gap: 12, alignItems: 'baseline',
                fontFamily: 'var(--mono)', fontSize: 11,
                padding: '6px 0', borderTop: i > 0 ? '1px solid var(--border)' : 'none',
              }}>
                <span style={{ color: 'var(--accent)', fontWeight: 600, flexShrink: 0 }}>{t.role}</span>
                <span style={{ color: 'var(--orange)', fontSize: 10 }}>{t.branch}</span>
                <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.instruction}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{
        flexShrink: 0, borderTop: '1px solid var(--border)',
        background: 'var(--surface)', padding: '10px 24px',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <button
          onClick={clearPlan}
          style={{
            padding: '6px 14px', borderRadius: 4,
            border: '1px solid rgba(255,95,95,0.2)', background: 'rgba(255,95,95,0.08)',
            color: 'var(--red)', fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer',
          }}
        >
          ✕ Clear plan
        </button>
      </div>
    </div>
  )
}
