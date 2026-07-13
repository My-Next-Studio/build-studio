'use client'

/**
 * Pathology panel for monolithic task_execution (PRD-001 Layer 3).
 * Renders a horizontal strip of vital-signs badges so the operator can read
 * "is this run healthy?" at a glance instead of dropping into tmux.
 */

export interface PathologySignals {
  /** True when last `xcodebuild` (or equivalent build) exited 0 in pane recently. */
  building?: boolean
  /** Minutes since last commit landed on the working branch. */
  minutesSinceLastCommit?: number | null
  /** True when pane shows "Conversation compacted" or "context_compacted" marker. */
  compactionDetected?: boolean
  /** True when overseer fired the format-POST nudge for any running agent. */
  formatPostRetried?: boolean
  /** Seconds since pane last had output. <60 = active, >300 = stalled. */
  secondsSincePaneActivity?: number | null
}

type Severity = 'info' | 'warn' | 'block'

interface Badge {
  label: string
  active: boolean
  severity: Severity
  tooltip: string
}

interface Props {
  signals: PathologySignals | null | undefined
  isRunning: boolean
}

export function PathologyPanel({ signals, isRunning }: Props) {
  if (!signals) return null

  const minsSinceCommit = signals.minutesSinceLastCommit ?? null
  const secsSinceActivity = signals.secondsSincePaneActivity ?? null

  const badges: Badge[] = [
    {
      label: 'Building',
      active: signals.building === true,
      severity: 'info',
      tooltip: 'Last build command exited 0 within the last 5 minutes.',
    },
    {
      label: 'Activity',
      active: secsSinceActivity != null && secsSinceActivity < 60,
      severity: 'info',
      tooltip: secsSinceActivity != null
        ? `Pane last updated ${secsSinceActivity}s ago.`
        : 'No pane activity signal available.',
    },
    {
      label: 'Stale commit',
      active: minsSinceCommit != null && minsSinceCommit >= 30 && minsSinceCommit < 50,
      severity: 'warn',
      tooltip: '>30 min since the last commit. Agent may be in a long sub-step (build, tests).',
    },
    {
      label: 'Doom risk',
      active: minsSinceCommit != null && minsSinceCommit >= 50,
      severity: 'block',
      tooltip: '>50 min without a commit. Investigate — agent may be looping or stuck.',
    },
    {
      label: 'Compaction',
      active: signals.compactionDetected === true,
      severity: 'block',
      tooltip: 'Pane shows a "Conversation compacted" marker — agent lost short-term context and is re-orienting.',
    },
    {
      label: 'Format-POST retry',
      active: signals.formatPostRetried === true,
      severity: 'warn',
      tooltip: 'Overseer nudged an agent that finished its turn but forgot to POST feedback.',
    },
  ]

  // Always show critical badges; collapse inactive info badges when not running
  const visible = badges.filter(b => b.active || (b.severity !== 'info' || isRunning))

  function colorFor(b: Badge): { bg: string; fg: string; border: string } {
    if (!b.active) return { bg: 'transparent', fg: 'var(--text-dim)', border: 'var(--border)' }
    if (b.severity === 'block') return { bg: 'var(--red)', fg: 'var(--bg)', border: 'var(--red)' }
    if (b.severity === 'warn') return { bg: 'var(--orange)', fg: 'var(--bg)', border: 'var(--orange)' }
    return { bg: 'var(--green)', fg: 'var(--bg)', border: 'var(--green)' }
  }

  // Sort: active blocks first, active warns next, info, then inactive
  const sortKey = (b: Badge) => {
    if (b.active && b.severity === 'block') return 0
    if (b.active && b.severity === 'warn') return 1
    if (b.active) return 2
    return 3
  }
  const sorted = [...visible].sort((a, b) => sortKey(a) - sortKey(b))

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em',
        color: 'var(--text-dim)', marginBottom: 8,
      }}>
        Pathology Panel
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {sorted.map(b => {
          const c = colorFor(b)
          return (
            <span key={b.label}
              title={b.tooltip}
              style={{
                fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                padding: '3px 8px', borderRadius: 10,
                background: c.bg, color: c.fg, border: `1px solid ${c.border}`,
                opacity: b.active ? 1 : 0.5,
                whiteSpace: 'nowrap',
                cursor: 'help',
              }}>
              {b.active ? '●' : '○'} {b.label}
            </span>
          )
        })}
      </div>
    </div>
  )
}
