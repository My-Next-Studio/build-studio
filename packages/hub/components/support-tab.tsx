'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useProjectApi } from '@/lib/use-project-api'

// ─── Types (mirror the server's summarizeReport shape) ──────────────────────
type ReportStatus = 'new' | 'triaging' | 'proposed' | 'filed' | 'rejected' | 'dismissed'
type Verdict = 'invalid' | 'duplicate' | 'bug' | 'bug_prd_scale' | 'feature' | 'task'

interface Proposal {
  verdict: Verdict
  duplicate_of?: string | null
  title?: string
  body?: string
  role?: string | null
  severity?: 'critical' | 'normal'
  findings?: string
  reasoning?: string
}

interface ReportSummary {
  id: string
  created: string | null
  status: ReportStatus
  excerpt: string
  attachments: string[]
  verdict: Verdict | null
  proposal: Proposal | null
  linked_item: string | null
  linkedItemStatus: string | null
}

interface Attachment { name: string; size: number; base64: string }

const MAX_ATTACHMENTS_BYTES = 25 * 1024 * 1024

// ─── Component ──────────────────────────────────────────────────────────────
export function SupportTab() {
  const api = useProjectApi()
  const [reports, setReports] = useState<ReportSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Composer state
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [submitting, setSubmitting] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const reportsRef = useRef(reports)
  useEffect(() => { reportsRef.current = reports }, [reports])

  const load = useCallback(async () => {
    try {
      const data: { reports?: ReportSummary[]; error?: string } = await api.get('/support/reports')
      if (data.error) { setError(data.error); return }
      setReports(data.reports || [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load reports')
    } finally {
      setLoading(false)
    }
  }, [api])

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  const updateReport = useCallback((r: ReportSummary) => {
    setReports(prev => prev.map(x => (x.id === r.id ? r : x)))
  }, [])

  // Poll triage status every 3s while any report is triaging.
  const anyTriaging = reports.some(r => r.status === 'triaging')
  useEffect(() => {
    if (!anyTriaging) return
    const tick = async () => {
      const triaging = reportsRef.current.filter(r => r.status === 'triaging')
      for (const r of triaging) {
        try {
          const data: { report?: ReportSummary } = await api.get(`/support/reports/${r.id}/triage/status`)
          if (data.report) updateReport(data.report)
        } catch { /* transient — retry next tick */ }
      }
    }
    const id = setInterval(tick, 3_000)
    return () => clearInterval(id)
  }, [anyTriaging, api, updateReport])

  // ─── Composer actions ─────────────────────────────────────────────────────
  const addFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0) return
    const arr = Array.from(files)
    Promise.all(arr.map(f => new Promise<Attachment>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result || '')
        const base64 = result.includes(',') ? result.slice(result.indexOf(',') + 1) : result
        resolve({ name: f.name, size: f.size, base64 })
      }
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(f)
    }))).then(added => {
      setAttachments(prev => [...prev, ...added])
    }).catch(() => setError('Could not read one of the attachments'))
    if (fileInputRef.current) fileInputRef.current.value = ''
  }, [])

  const removeAttachment = (name: string, size: number) => {
    setAttachments(prev => {
      const idx = prev.findIndex(a => a.name === name && a.size === size)
      if (idx < 0) return prev
      const next = [...prev]
      next.splice(idx, 1)
      return next
    })
  }

  const totalBytes = attachments.reduce((s, a) => s + a.size, 0)
  const overLimit = totalBytes > MAX_ATTACHMENTS_BYTES

  const submit = useCallback(async () => {
    if (!text.trim() || overLimit || submitting) return
    setSubmitting(true)
    try {
      const data: { report?: ReportSummary; error?: string } = await api.post('/support/reports', {
        text: text.trim(),
        attachments: attachments.map(a => ({ name: a.name, base64: a.base64 })),
      })
      if (data.error) { setError(data.error); return }
      setText('')
      setAttachments([])
      setError(null)
      load()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Submit failed')
    } finally {
      setSubmitting(false)
    }
  }, [api, text, attachments, overLimit, submitting, load])

  // ─── Report actions ───────────────────────────────────────────────────────
  const runTriage = useCallback(async (id: string) => {
    try {
      const data: { report?: ReportSummary; error?: string } = await api.post(`/support/reports/${id}/triage`, {})
      if (data.error) { setError(data.error); return }
      if (data.report) updateReport(data.report)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start triage')
    }
  }, [api, updateReport])

  const decide = useCallback(async (id: string, accept: boolean, note: string) => {
    try {
      const data: { report?: ReportSummary; error?: string } =
        await api.post(`/support/reports/${id}/decision`, { accept, note: note || undefined })
      if (data.error) { setError(data.error); return }
      if (data.report) updateReport(data.report)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Decision failed')
    }
  }, [api, updateReport])

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div style={{ padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16, fontFamily: 'var(--mono)', overflow: 'auto' }}>
      {/* Header */}
      <div>
        <h1 style={{ fontSize: 14, fontWeight: 700, marginBottom: 4, letterSpacing: '0.02em' }}>Support</h1>
        <p style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5, margin: 0, maxWidth: 700 }}>
          Report an issue in your own words. A propose-only triage agent classifies it; approved
          outcomes are filed to the backlog. Bugs are filed automatically — features and tasks wait for
          your decision.
        </p>
      </div>

      {/* Composer */}
      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)',
        borderRadius: 'var(--radius)', padding: 16, display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <SectionHeader>New report</SectionHeader>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          placeholder="Describe the issue…"
          rows={4}
          style={{
            width: '100%', resize: 'vertical', boxSizing: 'border-box',
            padding: '8px 10px', background: 'var(--surface2)', border: '1px solid var(--border)',
            borderRadius: 4, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text)', lineHeight: 1.5,
          }}
        />

        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {attachments.map(a => (
              <span key={`${a.name}-${a.size}`} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '3px 8px', borderRadius: 4,
                background: 'var(--surface3)', border: '1px solid var(--border)',
                fontSize: 10, color: 'var(--text-dim)',
              }}>
                <span>📎 {a.name}</span>
                <span style={{ color: 'var(--muted)' }}>{formatBytes(a.size)}</span>
                <button
                  onClick={() => removeAttachment(a.name, a.size)}
                  title="Remove"
                  style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 0, fontSize: 12, lineHeight: 1 }}
                >×</button>
              </span>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={e => addFiles(e.target.files)}
            style={{ display: 'none' }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            style={ghostButtonStyle}
          >Attach files</button>
          <span style={{ fontSize: 10, color: overLimit ? 'var(--red)' : 'var(--muted)' }}>
            {formatBytes(totalBytes)} / 25 MB{overLimit ? ' — over limit' : ''}
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={submit}
            disabled={!text.trim() || overLimit || submitting}
            style={{
              ...primaryButtonStyle,
              opacity: (!text.trim() || overLimit || submitting) ? 0.5 : 1,
              cursor: (!text.trim() || overLimit || submitting) ? 'not-allowed' : 'pointer',
            }}
          >{submitting ? 'Submitting…' : 'Submit'}</button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div style={{ padding: '8px 12px', background: 'rgba(255,95,95,0.08)', border: '1px solid var(--red)', borderRadius: 4, color: 'var(--red)', fontSize: 11 }}>
          {error}
        </div>
      )}

      {/* Reports list */}
      <SectionHeader>Reports</SectionHeader>
      {!loading && reports.length === 0 && (
        <div style={{ padding: '16px 0', color: 'var(--muted)', fontSize: 12 }}>
          No reports yet. File one above.
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {reports.map(r => (
          <ReportRow key={r.id} report={r} onRunTriage={runTriage} onDecide={decide} />
        ))}
      </div>
    </div>
  )
}

// ─── Report row ─────────────────────────────────────────────────────────────
function ReportRow({ report, onRunTriage, onDecide }: {
  report: ReportSummary
  onRunTriage: (id: string) => void
  onDecide: (id: string, accept: boolean, note: string) => void
}) {
  const isFixed = report.linkedItemStatus === 'Done'
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius)', padding: '12px 14px',
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      {/* Head: id + status + date */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ color: 'var(--text-dim)', fontSize: 11, letterSpacing: '0.04em' }}>{report.id}</span>
        <StatusChip status={report.status} />
        {isFixed && <FixedChip />}
        {report.linked_item && (
          <span style={{ fontSize: 10, color: 'var(--muted)' }}>→ {report.linked_item}</span>
        )}
        <span style={{ flex: 1 }} />
        {report.created && (
          <span style={{ fontSize: 10, color: 'var(--muted)' }}>{formatDate(report.created)}</span>
        )}
      </div>

      {/* Excerpt */}
      <div style={{ fontSize: 12, color: 'var(--text)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
        {report.excerpt || <span style={{ color: 'var(--muted)' }}>(no text)</span>}
      </div>

      {/* Attachments */}
      {report.attachments.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {report.attachments.map(name => (
            <span key={name} style={{
              padding: '2px 7px', borderRadius: 4,
              background: 'var(--surface3)', border: '1px solid var(--border)',
              fontSize: 10, color: 'var(--text-dim)',
            }}>📎 {name}</span>
          ))}
        </div>
      )}

      {/* Actions / triage state */}
      {report.status === 'new' && (
        <div>
          <button onClick={() => onRunTriage(report.id)} style={primaryButtonStyle}>Run triage</button>
        </div>
      )}
      {report.status === 'triaging' && (
        <div style={{ fontSize: 11, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Spinner /> Triaging… the agent is investigating this report.
        </div>
      )}
      {report.status === 'filed' && report.proposal?.verdict === 'bug' && (
        <div style={{ fontSize: 11, color: 'var(--green)' }}>
          Auto-filed as a bug{report.linked_item ? ` — ${report.linked_item}` : ''} (bugs need no approval).
        </div>
      )}
      {report.proposal && (report.status === 'proposed' || report.status === 'filed' || report.status === 'dismissed' || report.status === 'rejected') && (
        <ProposalCard report={report} onDecide={onDecide} />
      )}
    </div>
  )
}

// ─── Proposal card ──────────────────────────────────────────────────────────
function ProposalCard({ report, onDecide }: {
  report: ReportSummary
  onDecide: (id: string, accept: boolean, note: string) => void
}) {
  const p = report.proposal!
  const [note, setNote] = useState('')
  const decidable = report.status === 'proposed' && p.verdict !== 'bug'

  return (
    <div style={{
      background: 'var(--surface2)', border: '1px solid var(--border-subtle)',
      borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <VerdictBadge verdict={p.verdict} />
        {p.severity === 'critical' && (
          <span style={{
            fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
            color: 'var(--red)', background: 'rgba(239,68,68,0.15)', border: '1px solid var(--red)',
            padding: '1px 6px', borderRadius: 3,
          }}>critical</span>
        )}
        {p.role && <span style={{ fontSize: 10, color: 'var(--muted)' }}>· {p.role}</span>}
        {p.duplicate_of && (
          <span style={{ fontSize: 10, color: 'var(--muted)' }}>· duplicate of {p.duplicate_of}</span>
        )}
      </div>

      {p.title && <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{p.title}</div>}

      {p.findings && (
        <div>
          <FieldLabel>Findings</FieldLabel>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{p.findings}</div>
        </div>
      )}
      {p.reasoning && (
        <div>
          <FieldLabel>Reasoning</FieldLabel>
          <div style={{ fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{p.reasoning}</div>
        </div>
      )}

      {decidable ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 }}>
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Optional note…"
            style={{
              padding: '5px 9px', background: 'var(--surface)', border: '1px solid var(--border)',
              borderRadius: 4, fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)',
            }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => onDecide(report.id, true, note)} style={primaryButtonStyle}>
              {acceptLabel(p.verdict)}
            </button>
            <button onClick={() => onDecide(report.id, false, note)} style={ghostButtonStyle}>Reject</button>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 10, color: 'var(--muted)' }}>{outcomeText(report)}</div>
      )}
    </div>
  )
}

// ─── Small presentational helpers ───────────────────────────────────────────
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
      color: 'var(--text-dim)',
    }}>{children}</div>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
      color: 'var(--muted)', marginBottom: 2,
    }}>{children}</div>
  )
}

const STATUS_META: Record<ReportStatus, { color: string; bg: string; label: string }> = {
  new:       { color: 'var(--muted)',   bg: 'var(--surface2)',        label: 'new' },
  triaging:  { color: 'var(--accent)',  bg: 'rgba(245,158,11,0.15)',  label: 'triaging' },
  proposed:  { color: 'var(--accent2)', bg: 'rgba(139,92,246,0.15)',  label: 'proposed' },
  filed:     { color: 'var(--green)',   bg: 'rgba(34,197,94,0.15)',   label: 'filed' },
  rejected:  { color: 'var(--red)',     bg: 'rgba(239,68,68,0.12)',   label: 'rejected' },
  dismissed: { color: 'var(--muted)',   bg: 'var(--surface2)',        label: 'dismissed' },
}

function StatusChip({ status }: { status: ReportStatus }) {
  const m = STATUS_META[status] || STATUS_META.new
  return (
    <span style={{
      fontSize: 9, padding: '2px 8px', borderRadius: 999,
      textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700,
      color: m.color, background: m.bg, border: `1px solid ${m.color}`,
    }}>{m.label}</span>
  )
}

function FixedChip() {
  return (
    <span style={{
      fontSize: 9, padding: '2px 8px', borderRadius: 999,
      textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700,
      color: 'var(--green)', background: 'rgba(34,197,94,0.15)', border: '1px solid var(--green)',
    }}>fixed</span>
  )
}

const VERDICT_META: Record<Verdict, { color: string; bg: string; label: string }> = {
  invalid:       { color: 'var(--muted)',   bg: 'var(--surface3)',        label: 'invalid' },
  duplicate:     { color: 'var(--yellow)',  bg: 'rgba(234,179,8,0.15)',   label: 'duplicate' },
  bug:           { color: 'var(--red)',     bg: 'rgba(239,68,68,0.15)',   label: 'bug' },
  bug_prd_scale: { color: 'var(--red)',     bg: 'rgba(239,68,68,0.15)',   label: 'bug · PRD-scale' },
  feature:       { color: 'var(--accent2)', bg: 'rgba(139,92,246,0.15)',  label: 'feature' },
  task:          { color: 'var(--accent)',  bg: 'rgba(245,158,11,0.15)',  label: 'task' },
}

function VerdictBadge({ verdict }: { verdict: Verdict }) {
  const m = VERDICT_META[verdict] || { color: 'var(--muted)', bg: 'var(--surface3)', label: verdict }
  return (
    <span style={{
      fontSize: 9, padding: '2px 8px', borderRadius: 3,
      textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700,
      color: m.color, background: m.bg, border: `1px solid ${m.color}`,
    }}>{m.label}</span>
  )
}

function Spinner() {
  return (
    <span style={{
      width: 10, height: 10, borderRadius: '50%',
      border: '2px solid var(--accent)', borderTopColor: 'transparent',
      display: 'inline-block', animation: 'support-spin 0.8s linear infinite',
    }}>
      <style>{'@keyframes support-spin { to { transform: rotate(360deg) } }'}</style>
    </span>
  )
}

const primaryButtonStyle: React.CSSProperties = {
  padding: '5px 14px', borderRadius: 4,
  background: 'var(--accent)', color: 'var(--surface)', border: '1px solid var(--accent)',
  fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 600, cursor: 'pointer',
}

const ghostButtonStyle: React.CSSProperties = {
  padding: '5px 12px', borderRadius: 4,
  background: 'var(--surface2)', color: 'var(--text-dim)', border: '1px solid var(--border)',
  fontFamily: 'var(--mono)', fontSize: 11, cursor: 'pointer',
}

function acceptLabel(verdict: Verdict): string {
  if (verdict === 'duplicate') return 'Dismiss as duplicate'
  if (verdict === 'invalid') return 'Mark invalid'
  return 'Accept & file'
}

function outcomeText(report: ReportSummary): string {
  switch (report.status) {
    case 'filed': return report.linked_item ? `Filed as ${report.linked_item}.` : 'Filed to the backlog.'
    case 'dismissed': return report.linked_item ? `Dismissed as a duplicate of ${report.linked_item}.` : 'Dismissed as a duplicate.'
    case 'rejected': return 'Marked invalid — nothing filed.'
    default: return ''
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
