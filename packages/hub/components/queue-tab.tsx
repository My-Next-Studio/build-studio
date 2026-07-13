'use client'

import { useEffect, useState, useCallback } from 'react'
import { useProjectApi } from '@/lib/use-project-api'
import { roleConfig, avatarSrc } from '@/lib/roles'

interface QueueEntry {
  id?: string
  roles: string[]
  instruction: string
  timestamp: string
}

export function QueueTab() {
  const api = useProjectApi()
  const [entries, setEntries] = useState<QueueEntry[]>([])

  const load = useCallback(async () => {
    const data = await api.get('/queue')
    setEntries(data.entries || [])
  }, [api])

  useEffect(() => { load() }, [load])

  async function dismiss(index: number) {
    const entry = entries[index]
    if (entry?.id) await api.del(`/queue/${entry.id}`)
    load()
  }

  if (entries.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 40 }}>📭</div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text-dim)' }}>
          No instructions queued yet.
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted)' }}>
          Use the Instruct tab to add some.
        </div>
      </div>
    )
  }

  return (
    <div style={{ padding: '20px 24px' }}>
      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>
        {entries.length} instruction{entries.length !== 1 ? 's' : ''} in queue
      </div>
      {entries.map((e, i) => (
        <div key={i} style={{
          background: 'var(--surface2)', border: '1px solid var(--border)',
          borderRadius: 8, padding: 16, marginBottom: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
            {e.roles.map(r => (
              <span key={r} style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                background: 'var(--surface3)', borderRadius: 4, padding: '2px 8px',
                fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)',
              }}>
                {avatarSrc(r)
                  ? <><img src={avatarSrc(r)!} alt={r} style={{ width: 14, height: 14, borderRadius: 2 }} /> {r}</>
                  : <>{roleConfig(r).avatar} {r}</>}
              </span>
            ))}
            <span style={{ marginLeft: 'auto', fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)' }}>
              {new Date(e.timestamp).toLocaleString()}
            </span>
          </div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)', lineHeight: 1.6, whiteSpace: 'pre-wrap', marginBottom: 12 }}>
            {e.instruction}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => dismiss(i)}
              style={{
                padding: '4px 12px', borderRadius: 4, border: '1px solid var(--border)',
                background: 'none', color: 'var(--text-dim)',
                fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer',
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
