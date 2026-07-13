'use client'

import { useCallback, useEffect, useState } from 'react'
import { useProject } from '@/lib/project-context'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface GitStatus {
  branch: string
  clean: boolean
  staged: number
  unstaged: number
  untracked: number
  ahead: number
  behind: number
  worktrees: number
}

interface StatusData {
  projectStateSection?: string
  activePrd?: string
  commits?: string[]
  git?: GitStatus
  version?: string
}

type Phase = 'drafted' | 'reviewed' | 'implemented' | 'done' | 'deferred'

interface PrdPhase {
  id: string
  title: string
  path: string | null
  phase: Phase
  phaseSince: string | null
  currentWorkflow: { type: string; currentStep: string; round: number } | null
  mergedSha: string | null
  mergedAt: string | null
  deferred: { reason: string | null; previousPhase: Phase | null; previousPhaseAt: string | null } | null
}

const PHASE_COLOR: Record<Phase, string> = {
  drafted:     'var(--muted)',
  reviewed:    'var(--accent)',
  implemented: 'var(--green)',
  done:        'var(--green)',
  deferred:    'var(--muted)',
}

function relTime(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return 'just now'
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 14) return `${day}d ago`
  return new Date(iso).toLocaleDateString()
}

export function StatusTab() {
  const { baseUrl } = useProject()
  const [status, setStatus] = useState<StatusData | null>(null)
  const [prd, setPrd] = useState<PrdPhase | null>(null)
  const [busy, setBusy] = useState(false)

  const reload = useCallback(() => {
    fetch(`${baseUrl}/api/status`).then(r => r.json()).then(setStatus)
    fetch(`${baseUrl}/api/status/prd-phase`)
      .then(r => r.ok ? r.json() : { prd: null })
      .then(d => setPrd(d.prd))
      .catch(() => setPrd(null))
  }, [baseUrl])

  useEffect(() => {
    reload()
    const t = setInterval(reload, 10000)
    return () => clearInterval(t)
  }, [reload])

  const handleDefer = useCallback(async () => {
    if (!prd) return
    const reason = window.prompt(`Defer ${prd.id}? Briefly, why?`)
    if (!reason || !reason.trim()) return
    setBusy(true)
    try {
      await fetch(`${baseUrl}/api/status/prd-phase/defer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prdId: prd.id, reason: reason.trim() }),
      })
      reload()
    } finally { setBusy(false) }
  }, [prd, baseUrl, reload])

  const handleReactivate = useCallback(async () => {
    if (!prd) return
    setBusy(true)
    try {
      await fetch(`${baseUrl}/api/status/prd-phase/reactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prdId: prd.id }),
      })
      reload()
    } finally { setBusy(false) }
  }, [prd, baseUrl, reload])

  const handleDone = useCallback(async () => {
    if (!prd) return
    if (!window.confirm(`Mark ${prd.id} as done?`)) return
    setBusy(true)
    try {
      await fetch(`${baseUrl}/api/status/prd-phase/done`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prdId: prd.id }),
      })
      reload()
    } finally { setBusy(false) }
  }, [prd, baseUrl, reload])

  if (!status) return <div style={{ padding: 24, fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)' }}>Loading...</div>

  const { git, activePrd, commits, projectStateSection, version } = status

  return (
    <div style={{ padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Git status */}
      {git && (
        <Section title="Git Status">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'center', fontFamily: 'var(--mono)', fontSize: 12 }}>
            <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{git.branch}</span>
            {version && <span style={{ color: 'var(--text-dim)', fontWeight: 500 }}>{version}</span>}
            <span className={`status-pill ${git.clean ? 'done' : 'running'}`}>
              {git.clean ? 'clean' : 'dirty'}
            </span>
            {git.staged > 0 && <><Sep /><span style={{ color: 'var(--green)' }}>{git.staged} staged</span></>}
            {git.unstaged > 0 && <><Sep /><span style={{ color: 'var(--orange)' }}>{git.unstaged} modified</span></>}
            {git.untracked > 0 && <><Sep /><span style={{ color: 'var(--muted)' }}>{git.untracked} untracked</span></>}
            <Sep />
            {git.ahead > 0 && <span style={{ color: 'var(--accent)' }}>↑{git.ahead} ahead</span>}
            {git.behind > 0 && <span style={{ color: 'var(--orange)' }}>↓{git.behind} behind</span>}
            {git.ahead === 0 && git.behind === 0 && <span style={{ color: 'var(--muted)' }}>in sync</span>}
            <Sep />
            {git.worktrees > 0
              ? <span style={{ color: 'var(--orange)' }}>{git.worktrees} worktree{git.worktrees > 1 ? 's' : ''}</span>
              : <span style={{ color: 'var(--muted)' }}>no worktrees</span>}
          </div>
        </Section>
      )}

      {/* Active PRD — phase-aware */}
      {prd && (
        <Section title="Active PRD">
          <div style={{
            background: 'var(--surface2)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            padding: '10px 14px',
            fontFamily: 'var(--mono)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 700 }}>{prd.id}</span>
              <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{prd.title}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '2px 10px', borderRadius: 999,
                fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
                color: PHASE_COLOR[prd.phase] || 'var(--muted)',
                border: `1px solid ${PHASE_COLOR[prd.phase] || 'var(--border)'}`,
                background: 'transparent',
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: prd.phase === 'deferred' ? 'transparent' : (PHASE_COLOR[prd.phase] || 'var(--muted)'),
                  border: prd.phase === 'deferred' ? `1px solid ${PHASE_COLOR[prd.phase]}` : 'none',
                  display: 'inline-block',
                }} />
                {prd.phase}
              </span>
              {prd.currentWorkflow && (
                <span style={{ fontSize: 10, color: 'var(--muted)' }}>
                  {prd.currentWorkflow.type} · {prd.currentWorkflow.currentStep} · round {prd.currentWorkflow.round}
                </span>
              )}
              {prd.phase === 'implemented' && prd.mergedSha && (
                <span style={{ fontSize: 10, color: 'var(--muted)' }}>{prd.mergedSha}</span>
              )}
              {prd.phaseSince && (
                <span style={{ fontSize: 10, color: 'var(--muted)', marginLeft: 'auto' }}>
                  {relTime(prd.phaseSince)}
                </span>
              )}
            </div>
            {prd.deferred && (
              <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
                {prd.deferred.reason}
                {prd.deferred.previousPhase && (
                  <span style={{ color: 'var(--muted)' }}> · was {prd.deferred.previousPhase}</span>
                )}
              </div>
            )}
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              {prd.phase !== 'done' && prd.phase !== 'deferred' && (
                <>
                  <button
                    onClick={handleDefer}
                    disabled={busy}
                    style={{
                      padding: '4px 10px', borderRadius: 4,
                      border: '1px solid var(--border)',
                      background: 'transparent', color: 'var(--muted)',
                      fontFamily: 'var(--mono)', fontSize: 10,
                      cursor: busy ? 'wait' : 'pointer',
                    }}
                  >
                    Defer
                  </button>
                  <button
                    onClick={handleDone}
                    disabled={busy}
                    style={{
                      padding: '4px 10px', borderRadius: 4,
                      border: '1px solid var(--green)',
                      background: 'transparent', color: 'var(--green)',
                      fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                      cursor: busy ? 'wait' : 'pointer',
                    }}
                  >
                    Done
                  </button>
                </>
              )}
              {(prd.phase === 'deferred' || prd.phase === 'done') && (
                <button
                  onClick={handleReactivate}
                  disabled={busy}
                  style={{
                    padding: '4px 10px', borderRadius: 4,
                    border: 'none',
                    background: 'var(--accent)', color: '#000',
                    fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                    cursor: busy ? 'wait' : 'pointer',
                  }}
                >
                  Reactivate
                </button>
              )}
            </div>
          </div>
        </Section>
      )}
      {!prd && activePrd && (
        // Fallback for back-compat when prd-phase endpoint is unavailable.
        <Section title="Active PRD">
          <div style={{
            background: 'var(--surface2)', border: '1px solid var(--border)',
            borderRadius: 6, padding: '10px 14px', fontFamily: 'var(--mono)',
          }}>
            <div style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 700, marginBottom: 4 }}>
              {activePrd.match(/PRD-\d+/)?.[0] ?? ''}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text)' }}>
              {activePrd.match(/\[([^\]]+)\]/)?.[1] ?? activePrd}
            </div>
          </div>
        </Section>
      )}

      {/* Backlog */}
      {projectStateSection && (
        <Section title="Backlog">
          <div className="md-rendered">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{projectStateSection}</ReactMarkdown>
          </div>
        </Section>
      )}

      {/* Recent Commits */}
      {commits && commits.length > 0 && (
        <Section title="Recent Commits">
          {commits.map((c, i) => {
            const sp = c.indexOf(' ')
            return (
              <div key={i} style={{ display: 'flex', gap: 10, fontFamily: 'var(--mono)', fontSize: 11, marginBottom: 4 }}>
                <span style={{ color: 'var(--accent2)', flexShrink: 0 }}>{c.slice(0, sp)}</span>
                <span style={{ color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.slice(sp + 1)}</span>
              </div>
            )
          })}
        </Section>
      )}

    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700,
        textTransform: 'uppercase', letterSpacing: '0.1em',
        color: 'var(--text-dim)', marginBottom: 10,
      }}>
        {title}
      </div>
      {children}
    </div>
  )
}

function Sep() {
  return <span style={{ color: 'var(--border)' }}>|</span>
}
