'use client'

import { useEffect, useState, useCallback } from 'react'
import { useProjectApi } from '@/lib/use-project-api'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface RunbookEntry {
  filename: string
  title: string
  mtime: number
}

export function RunbooksTab() {
  const api = useProjectApi()
  const [runbooks, setRunbooks] = useState<RunbookEntry[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<string>('')

  const loadList = useCallback(() => {
    api.get('/runbooks').then((data: { runbooks: RunbookEntry[] }) => {
      setRunbooks(data.runbooks || [])
      // Auto-select first if nothing selected
      if (!selected && data.runbooks?.length > 0) {
        setSelected(data.runbooks[0].filename)
      }
    }).catch(() => {})
  }, [api, selected])

  useEffect(() => { loadList() }, [loadList])

  useEffect(() => {
    if (!selected) { setContent(''); return }
    let cancelled = false
    api.get(`/runbook?filename=${encodeURIComponent(selected)}`).then((data: { content: string }) => {
      if (!cancelled) setContent(data.content || '')
    }).catch(() => {})
    return () => { cancelled = true }
  }, [api, selected])

  if (runbooks === null) {
    return (
      <div style={{ padding: '24px 32px', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>
        Loading...
      </div>
    )
  }

  if (runbooks.length === 0) {
    return (
      <div style={{ padding: '24px 32px', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>
        No runbooks found in docs/runbooks/.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
      {/* Sidebar */}
      <div style={{
        width: 220, flexShrink: 0, overflow: 'auto',
        borderRight: '1px solid var(--border)',
        padding: '12px 0',
      }}>
        <div style={{
          fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: '0.1em',
          color: 'var(--text-dim)', padding: '0 16px', marginBottom: 8,
        }}>
          Runbooks
        </div>
        {runbooks.map(rb => (
          <button
            key={rb.filename}
            onClick={() => setSelected(rb.filename)}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '6px 16px', border: 'none',
              background: selected === rb.filename ? 'var(--surface2)' : 'transparent',
              color: selected === rb.filename ? 'var(--text)' : 'var(--text-dim)',
              fontFamily: 'var(--mono)', fontSize: 11,
              cursor: 'pointer', transition: 'all 0.15s',
            }}
          >
            {rb.title}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflow: 'auto', padding: '20px 32px 40px' }}>
        {selected && (
          <>
            <div style={{
              fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)',
              marginBottom: 16, paddingBottom: 8, borderBottom: '1px solid var(--border)',
            }}>
              docs/runbooks/{selected}
            </div>
            <div className="md-rendered">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
