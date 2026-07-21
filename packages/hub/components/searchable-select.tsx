'use client'

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

// Searchable dropdown for long option lists (e.g. OpenCode's `provider/model`
// catalog — hundreds of entries). Filter-as-you-type, keyboard navigable,
// mono-styled per hub conventions. Controlled: `value` + `onChange`.
export function SearchableSelect({ value, options, onChange, placeholder = 'Search…', allowClear = false, disabled = false, style }: {
  value: string | null
  options: string[]
  onChange: (v: string | null) => void
  placeholder?: string
  allowClear?: boolean
  disabled?: boolean
  /** Outer wrapper styles — parent sets width; default fills the container. */
  style?: CSSProperties
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    // Substring match on any part — provider, family, or version. Splitting
    // the query on whitespace gives poor-man's multi-token AND matching.
    const terms = q.split(/\s+/)
    return options.filter(o => {
      const l = o.toLowerCase()
      return terms.every(t => l.includes(t))
    })
  }, [options, query])

  useEffect(() => { setHighlight(0) }, [query])

  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const commit = (v: string | null) => {
    onChange(v)
    setOpen(false)
    setQuery('')
  }

  return (
    <div ref={rootRef} style={{ position: 'relative', width: '100%', minWidth: 0, ...style }}>
      <div
        onClick={() => {
          if (disabled) return
          setOpen(o => !o)
          setTimeout(() => inputRef.current?.focus(), 0)
        }}
        title={value || undefined}
        style={{
          fontFamily: 'var(--mono)', fontSize: 11,
          padding: '6px 10px', borderRadius: 6,
          background: 'var(--surface2)', border: '1px solid var(--border)',
          color: value ? 'var(--text)' : 'var(--muted)',
          cursor: disabled ? 'default' : 'pointer',
          display: 'flex', alignItems: 'center', gap: 6,
          opacity: disabled ? 0.5 : 1,
          overflow: 'hidden',
          maxWidth: '100%',
        }}
      >
        <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {value || placeholder}
        </span>
        {allowClear && value && !disabled && (
          <span
            onClick={(e) => { e.stopPropagation(); commit(null) }}
            style={{ color: 'var(--muted)', cursor: 'pointer', padding: '0 2px' }}
            title="Clear (use CLI default)"
          >×</span>
        )}
        <span style={{ color: 'var(--muted)', fontSize: 9 }}>{open ? '▴' : '▾'}</span>
      </div>

      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 60,
          minWidth: '100%', width: 'max(100%, 280px)', maxWidth: 420,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 6, boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') { setOpen(false); setQuery('') }
              else if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight(h => Math.min(h + 1, filtered.length - 1)) }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight(h => Math.max(h - 1, 0)) }
              else if (e.key === 'Enter') {
                e.preventDefault()
                if (filtered[highlight]) commit(filtered[highlight])
              }
            }}
            placeholder={placeholder}
            style={{
              fontFamily: 'var(--mono)', fontSize: 11,
              padding: '8px 10px', border: 'none', outline: 'none',
              background: 'var(--bg)', color: 'var(--text)',
              borderBottom: '1px solid var(--border)',
            }}
          />
          <div style={{ maxHeight: 260, overflowY: 'auto' }}>
            {filtered.slice(0, 200).map((opt, i) => (
              <div
                key={opt}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => commit(opt)}
                style={{
                  fontFamily: 'var(--mono)', fontSize: 11,
                  padding: '6px 10px', cursor: 'pointer',
                  background: i === highlight ? 'var(--surface2)' : 'transparent',
                  color: opt === value ? 'var(--accent)' : 'var(--text)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}
              >
                {opt}
              </div>
            ))}
            {filtered.length === 0 && (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', padding: '10px' }}>
                No models match "{query}"
              </div>
            )}
            {filtered.length > 200 && (
              <div style={{ fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)', padding: '6px 10px', borderTop: '1px solid var(--border)' }}>
                {filtered.length - 200} more — keep typing to narrow
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
