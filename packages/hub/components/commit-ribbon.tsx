'use client'

import { useEffect, useState, useCallback } from 'react'
import { useProjectApi } from '@/lib/use-project-api'

export interface RibbonCommit {
  sha: string
  shortSha: string
  subject: string
  type: string
  isoDate: string
  additions: number
  deletions: number
}

interface Props {
  /** ISO timestamp — commits made on or after this are shown. Usually task_execution.startedAt. */
  sinceISO: string | null
  /** Whether the implementing agent is still running. Controls the pulsing live-dot + "min since last commit" pill. */
  isRunning: boolean
  /** Optional preloaded commits — when provided, the component skips the API fetch (used by the preview page). */
  commitsOverride?: RibbonCommit[]
}

/**
 * Horizontal commit timeline for monolithic task_execution (PRD-001 Layer 1).
 * Each commit becomes a clickable block. Pulses with a live dot while the agent is active.
 */
export function CommitRibbon({ sinceISO, isRunning, commitsOverride }: Props) {
  const api = useProjectApi()
  const [commits, setCommits] = useState<RibbonCommit[]>(commitsOverride || [])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  // Poll commits — 10s while running, slower when idle. Skip when an override is supplied (preview mode).
  useEffect(() => {
    if (commitsOverride) { setCommits(commitsOverride); return }
    if (!sinceISO) return
    let cancelled = false
    async function load() {
      const r = await api.get(`/workflow/branch-commits?since=${encodeURIComponent(sinceISO!)}`)
      if (!cancelled && r.commits) setCommits(r.commits)
    }
    load()
    const intervalMs = isRunning ? 10_000 : 30_000
    const id = setInterval(load, intervalMs)
    return () => { cancelled = true; clearInterval(id) }
  }, [api, sinceISO, isRunning, commitsOverride])

  // Per-minute tick so the "min since last commit" pill updates without re-fetching
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])

  const lastCommitISO = commits[0]?.isoDate
  const minsSinceLast = lastCommitISO
    ? Math.floor((Date.now() - new Date(lastCommitISO).getTime()) / 60_000)
    : null
  // tick is read to force a re-render once per minute
  void tick

  // Color thresholds: green <20m, yellow <50m, red >=50m
  const pillColor = minsSinceLast == null ? 'var(--text-dim)'
    : minsSinceLast < 20 ? 'var(--green)'
    : minsSinceLast < 50 ? 'var(--orange)'
    : 'var(--red)'

  // Type → color for commit blocks
  const blockColor = useCallback((t: string) => {
    switch (t) {
      case 'feat': return 'var(--accent)'
      case 'fix': return 'var(--orange)'
      case 'test': return 'var(--blue, #4a9eff)'
      case 'refactor': return 'var(--text-dim)'
      case 'docs': return 'var(--muted)'
      case 'chore': return 'var(--border)'
      default: return 'var(--text-dim)'
    }
  }, [])

  if (!sinceISO) return null

  // Sort oldest → newest for left-to-right timeline
  const ordered = [...commits].reverse()
  const maxAdds = Math.max(50, ...ordered.map(c => c.additions))
  const blockWidth = (c: RibbonCommit) => {
    const min = 28, max = 140
    const ratio = Math.min(1, c.additions / maxAdds)
    return Math.round(min + ratio * (max - min))
  }

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <span style={{
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)'
        }}>Commit Ribbon · {commits.length} commits</span>
        {minsSinceLast != null && (
          <span style={{
            fontFamily: 'var(--mono)', fontSize: 10, color: pillColor, padding: '2px 8px',
            border: `1px solid ${pillColor}`, borderRadius: 10, opacity: 0.85,
          }} title="Time since last commit landed. Pulses red after 50m without a commit.">
            {minsSinceLast}m since last commit
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'stretch', gap: 4, overflowX: 'auto', paddingBottom: 4 }}>
        {ordered.length === 0 && (
          <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', padding: '6px 8px' }}>
            (no commits yet)
          </div>
        )}
        {ordered.map(c => {
          const w = blockWidth(c)
          const isOpen = expanded === c.sha
          return (
            <button
              key={c.sha}
              onClick={() => setExpanded(isOpen ? null : c.sha)}
              title={`${c.shortSha} · ${c.subject}\n+${c.additions} -${c.deletions}`}
              style={{
                flex: '0 0 auto', width: w, height: 28,
                background: blockColor(c.type), color: 'var(--bg)',
                border: 'none', borderRadius: 4,
                fontFamily: 'var(--mono)', fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
                textTransform: 'uppercase',
                cursor: 'pointer', padding: '0 6px',
                display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
                overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
                opacity: isOpen ? 1 : 0.85,
                outline: isOpen ? '2px solid var(--text)' : 'none',
              }}>
              {c.type}
            </button>
          )
        })}
        {isRunning && (
          <div title="Agent running" style={{
            flex: '0 0 auto', width: 14, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <span style={{
              width: 10, height: 10, borderRadius: '50%',
              background: 'var(--green)',
              animation: 'wf-pulse 1.4s ease-in-out infinite',
            }} />
          </div>
        )}
      </div>

      {expanded && (() => {
        const c = ordered.find(x => x.sha === expanded)
        if (!c) return null
        return (
          <div style={{
            marginTop: 8, padding: '8px 10px',
            background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 6,
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)', lineHeight: 1.4,
          }}>
            <div style={{ marginBottom: 4, color: 'var(--text-dim)' }}>
              {c.shortSha} · {new Date(c.isoDate).toLocaleTimeString()} · +{c.additions} -{c.deletions}
            </div>
            <div>{c.subject}</div>
          </div>
        )
      })()}

    </div>
  )
}
