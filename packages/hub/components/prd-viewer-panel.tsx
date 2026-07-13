'use client'

import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useProjectApi } from '@/lib/use-project-api'

/**
 * Read-only PRD viewer that sits in the right column of the project page.
 * Pairs with the backlog tab's "Open PRD" button. Sized 100% to fit a parent
 * container (the dashboard's right-column wrapper, shared with TerminalPanel
 * via vertical split).
 */
export function PRDViewerPanel({ path, onClose }: { path: string; onClose: () => void }) {
  const api = useProjectApi()
  const [content, setContent] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    // The backlog item's `prd` field stores paths like `docs/prds/PRD-005…md`.
    // The /api/file endpoint resolves relative to docsPath (the `docs/` dir),
    // so strip a leading `docs/` if present.
    const apiPath = path.replace(/^docs\//, '')
    api.get(`/file?path=${encodeURIComponent(apiPath)}`)
      .then((d: { content: string }) => { if (!cancelled) { setContent(d.content || ''); setLoading(false) } })
      .catch(e => { if (!cancelled) { setError(e instanceof Error ? e.message : 'Could not load PRD'); setLoading(false) } })
    return () => { cancelled = true }
  }, [api, path])

  // First H1 heading → display title in the header bar.
  const titleMatch = content.match(/^#\s+(.+)$/m)
  const title = titleMatch ? titleMatch[1].trim() : path

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      flex: 1, minHeight: 0, width: '100%',
      background: 'var(--bg)',
    }}>
      {/* Header bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '5px 12px',
        background: 'var(--surface2)',
        borderBottom: '1px solid var(--border)',
        flexShrink: 0,
      }}>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
          color: 'var(--accent)', letterSpacing: '0.08em', textTransform: 'uppercase',
        }}>
          PRD
        </span>
        <span style={{
          flex: 1,
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {title}
        </span>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          maxWidth: 240,
        }}>{path}</span>
        <button
          onClick={onClose}
          style={{
            padding: '2px 8px', borderRadius: 3, border: '1px solid var(--border)',
            background: 'none', color: 'var(--muted)', fontFamily: 'var(--mono)',
            fontSize: 10, cursor: 'pointer',
          }}>
          ✕
        </button>
      </div>

      {/* Body */}
      <div className="md-rendered" style={{
        flex: 1, overflow: 'auto', minHeight: 0,
        padding: '14px 18px',
        fontFamily: 'var(--sans)', fontSize: 13, lineHeight: 1.6,
        color: 'var(--text)',
      }}>
        {loading && <div style={{ color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 11 }}>Loading…</div>}
        {error && (
          <div style={{
            padding: '8px 12px',
            background: 'rgba(239,68,68,0.08)', border: '1px solid var(--red)',
            borderRadius: 4, color: 'var(--red)', fontSize: 11,
            fontFamily: 'var(--mono)',
          }}>
            {error}
          </div>
        )}
        {!loading && !error && <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>}
      </div>
    </div>
  )
}
