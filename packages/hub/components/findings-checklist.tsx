'use client'

import { useState } from 'react'

export type Severity = 'BLOCKING' | 'MEDIUM' | 'LOW'
export type FindingStatus = 'pending' | 'in_progress' | 'done' | 'manual_override'

export interface Finding {
  id: string
  severity: Severity
  source: string
  label: string
  body?: string
  status: FindingStatus
  matchedBy?: string
}

interface Props {
  findings: Finding[]
  /** Called when the operator manually toggles a finding's done state. Optional — UI is still useful in read-only mode. */
  onToggle?: (id: string, nextStatus: FindingStatus) => void
}

/**
 * Findings checklist for monolithic fix_execution (PRD-001 Layer / AC 11-15).
 * Renders the structured findings extracted from the source step (code_review,
 * qa_validation) as a checklist that ticks off as the fix agent addresses them.
 */
export function FindingsChecklist({ findings, onToggle }: Props) {
  const [expanded, setExpanded] = useState<string | null>(null)
  if (!findings || findings.length === 0) return null

  const blocking = findings.filter(f => f.severity === 'BLOCKING')
  const medium = findings.filter(f => f.severity === 'MEDIUM')
  const low = findings.filter(f => f.severity === 'LOW')
  const doneCount = findings.filter(f => f.status === 'done' || f.status === 'manual_override').length

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)',
        }}>
          Findings · {doneCount} / {findings.length} addressed
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)' }}>
          {blocking.length}B · {medium.length}M · {low.length}L
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {findings.map(f => <FindingRow key={f.id} f={f} expanded={expanded === f.id} onExpand={() => setExpanded(expanded === f.id ? null : f.id)} onToggle={onToggle} />)}
      </div>
    </div>
  )
}

function FindingRow({ f, expanded, onExpand, onToggle }: { f: Finding; expanded: boolean; onExpand: () => void; onToggle?: (id: string, nextStatus: FindingStatus) => void }) {
  const isDone = f.status === 'done' || f.status === 'manual_override'
  const isInProgress = f.status === 'in_progress'
  const sevColor = f.severity === 'BLOCKING' ? 'var(--red)' : f.severity === 'MEDIUM' ? 'var(--orange)' : 'var(--text-dim)'
  const statusGlyph = isDone ? '✓' : isInProgress ? '◐' : '○'
  const statusColor = isDone ? 'var(--green)' : isInProgress ? 'var(--orange)' : 'var(--text-dim)'

  function toggleStatus(e: React.MouseEvent) {
    e.stopPropagation()
    if (!onToggle) return
    const next: FindingStatus = isDone ? 'pending' : 'manual_override'
    onToggle(f.id, next)
  }

  return (
    <div style={{
      padding: '6px 10px',
      background: isInProgress ? 'var(--surface2)' : 'var(--surface)',
      border: `1px solid ${isInProgress ? 'var(--orange)' : 'var(--border)'}`,
      borderLeft: `3px solid ${sevColor}`,
      borderRadius: 6,
      opacity: isDone ? 0.65 : 1,
      cursor: 'pointer',
    }}
      onClick={onExpand}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={toggleStatus}
          title={isDone ? 'Mark as pending' : 'Mark as manually done (operator override)'}
          style={{
            background: 'transparent', border: 'none', cursor: onToggle ? 'pointer' : 'default',
            color: statusColor, fontSize: 14, padding: 0, width: 16, textAlign: 'center', lineHeight: 1,
          }}>
          {statusGlyph}
        </button>
        <span style={{
          fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700, color: sevColor, letterSpacing: '0.04em',
          padding: '1px 4px', border: `1px solid ${sevColor}`, borderRadius: 3,
        }}>
          {f.severity[0]}
        </span>
        <span style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--text-dim)', minWidth: 110 }}>
          {f.source} · {f.id.split('-').slice(-1)[0]}
        </span>
        <span style={{
          fontSize: 12, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          textDecoration: isDone ? 'line-through' : 'none',
        }}>
          {f.label}
        </span>
        {f.matchedBy && (
          <span title={`Matched via ${f.matchedBy}`} style={{
            fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--green)',
          }}>
            {f.matchedBy.length > 12 ? f.matchedBy.slice(0, 7) : f.matchedBy}
          </span>
        )}
      </div>
      {expanded && f.body && (
        <div style={{
          marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)',
          fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', lineHeight: 1.5, whiteSpace: 'pre-wrap',
        }}>
          {f.body}
        </div>
      )}
    </div>
  )
}
