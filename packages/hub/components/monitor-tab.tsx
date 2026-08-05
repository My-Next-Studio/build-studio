'use client'

import { useCallback, useEffect, useState } from 'react'

// The Monitor tab (Home): things that have rotted while nobody was looking.
//
// Distinct from the CI/CD tab by the question it answers. CI/CD is opened after
// a push to watch that push's outcome; Monitor collects conditions nobody
// triggered — a nightly gate that started failing, a dependency advisory filed
// against a repo — which can go red days after the last commit.
//
// Grouped by severity rather than by project because that is how a morning
// triage actually reads: worst first, wherever it happens to live.
//
// Every row is derived on each poll. There is no dismiss button by design — an
// alert is visible exactly as long as its condition holds, so fixing the thing
// is the only interaction, and nothing here can drift out of step with reality.

interface Alert {
  source: string
  kind: string
  project: string
  id: string
  severity: string
  title: string
  detail: string
  url: string | null
  since: string | null
  /** How much of you this row needs — see FIX_LABEL in monitor-alerts.js. */
  fix?: 'ready' | 'major' | 'blocked' | 'none' | 'inactive'
  prNumber?: number | null
  prUrl?: string | null
}

// A row that is one click apart from a row that is an hour of work must not
// look the same. `ready` is deliberately the quietest of the four: it is the
// bulk of the list and the least deserving of attention.
const FIX_BADGE: Record<string, { label: string; color: string }> = {
  ready: { label: 'merge', color: 'var(--green)' },
  major: { label: 'major — review', color: 'var(--orange)' },
  blocked: { label: 'pinned — decide', color: 'var(--orange)' },
  none: { label: 'no fix yet', color: 'var(--text-dim)' },
  inactive: { label: 'updates off', color: 'var(--text-dim)' },
}

interface ProjectState {
  name: string
  running: boolean
  configured: boolean
  warning?: string
}

const SEVERITY_ORDER = ['critical', 'high', 'moderate', 'low', 'info'] as const

const SEVERITY_STYLE: Record<string, { color: string; label: string }> = {
  critical: { color: 'var(--red)', label: 'Critical' },
  high: { color: 'var(--red)', label: 'High' },
  moderate: { color: 'var(--orange)', label: 'Moderate' },
  low: { color: 'var(--text-dim)', label: 'Low' },
  info: { color: 'var(--text-dim)', label: 'Info' },
}

/** "3 days ago" — alerts are about duration, and a raw timestamp buries that. */
function since(iso: string | null): string {
  if (!iso) return ''
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function MonitorTab() {
  const [alerts, setAlerts] = useState<Alert[]>([])
  const [projects, setProjects] = useState<ProjectState[]>([])
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [enabling, setEnabling] = useState<Record<string, 'busy' | string>>({})

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/monitor')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setAlerts(Array.isArray(data.alerts) ? data.alerts : [])
      setProjects(Array.isArray(data.projects) ? data.projects : [])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoaded(true)
    }
  }, [])

  useEffect(() => {
    poll()
    // 30s is generous: the project-servers serve these from cache and only talk
    // to GitHub on their own backoff, so the tab's cadence costs nothing.
    const interval = setInterval(poll, 30000)
    return () => clearInterval(interval)
  }, [poll])

  const enableAlerts = useCallback(async (project: string) => {
    setEnabling((s) => ({ ...s, [project]: 'busy' }))
    try {
      const res = await fetch('/api/monitor/enable-alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`)
      // The project-server refreshed its own cache before answering, so the row
      // is already gone server-side — re-poll rather than hiding it locally, so
      // what you see is the real state and not an optimistic guess.
      setEnabling((s) => { const n = { ...s }; delete n[project]; return n })
      await poll()
    } catch (e) {
      setEnabling((s) => ({ ...s, [project]: e instanceof Error ? e.message : String(e) }))
    }
  }, [poll])

  const actionable = alerts.filter((a) => a.severity !== 'info')
  const readyCount = alerts.filter((a) => a.fix === 'ready').length
  const needsYou = alerts.filter((a) => a.fix === 'major' || a.fix === 'blocked').length
  const notRunning = projects.filter((p) => !p.running)

  return (
    <div style={{
      padding: '20px 32px', overflow: 'auto', height: 'calc(100vh - 124px)',
      display: 'flex', flexDirection: 'column', gap: 20, fontFamily: 'var(--mono)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <div style={{
          fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.1em', color: 'var(--text-dim)',
        }}>
          Alerts needing attention
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {/* "nothing to handle" is a claim, and before the first poll returns
              we have not earned it — an empty list we have not fetched yet
              reads exactly like all-clear. Say we are still looking instead. */}
          {!loaded ? 'checking…'
            : actionable.length === 0 ? 'nothing to handle'
            : `${actionable.length} open`}
        </div>
        {/* Splitting the count is the difference between "21 problems" and
            "18 clicks and 3 decisions" — the same list, but only one of those
            is a list you open. */}
        {loaded && readyCount > 0 && (
          <div style={{ fontSize: 11, color: 'var(--green)' }}>
            {readyCount} ready to merge
          </div>
        )}
        {loaded && needsYou > 0 && (
          <div style={{ fontSize: 11, color: 'var(--orange)' }}>
            {needsYou} need{needsYou === 1 ? 's' : ''} a decision
          </div>
        )}
      </div>

      {error && (
        <div style={{
          fontSize: 11, color: 'var(--red)', border: '1px solid var(--border)',
          borderRadius: 6, padding: '8px 12px',
        }}>
          Could not read alerts: {error}
        </div>
      )}

      {loaded && actionable.length === 0 && !error && (
        <div style={{
          border: '1px solid var(--border)', borderRadius: 6, padding: '18px 16px',
          fontSize: 12, color: 'var(--muted)',
        }}>
          All clear — no failing scheduled jobs and no open advisories.
        </div>
      )}

      {SEVERITY_ORDER.map((sev) => {
        const group = alerts.filter((a) => a.severity === sev)
        if (group.length === 0) return null
        const style = SEVERITY_STYLE[sev]
        return (
          <div key={sev} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{
              fontSize: 10, fontWeight: 700, textTransform: 'uppercase',
              letterSpacing: '0.1em', color: style.color,
            }}>
              {style.label} · {group.length}
            </div>
            {group.map((a) => (
              <AlertRow
                key={`${a.project}:${a.id}`}
                alert={a}
                color={style.color}
                enableState={enabling[a.project]}
                onEnable={() => enableAlerts(a.project)}
              />
            ))}
          </div>
        )
      })}

      {notRunning.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>
          Not polled (server stopped): {notRunning.map((p) => p.name).join(', ')}
        </div>
      )}
    </div>
  )
}

function AlertRow({ alert, color, enableState, onEnable }: {
  alert: Alert; color: string
  enableState?: 'busy' | string
  onEnable?: () => void
}) {
  // "Not enabled" is information about a blind spot, not a fault — it gets the
  // muted treatment and an action that fixes the blind spot rather than a link
  // to a problem that does not exist.
  // Both "not enabled" and "enabled but nothing acts on it" are fixed by the
  // same button — it turns on both toggles, because enabling sight without
  // action is what let advisories accumulate in the first place.
  const isSetupRow = alert.kind === 'not-enabled' || alert.kind === 'autofix-disabled'
  const busy = enableState === 'busy'
  const enableError = enableState && enableState !== 'busy' ? enableState : null
  const age = since(alert.since)
  const badge = alert.fix ? FIX_BADGE[alert.fix] : null
  // When a fix PR is waiting, the useful destination is the PR, not the
  // advisory — the advisory describes the problem, the PR is the action.
  const href = alert.prUrl || alert.url
  const hrefLabel = alert.prUrl ? `PR #${alert.prNumber} ↗` : 'open ↗'
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      border: '1px solid var(--border)', borderLeft: `2px solid ${color}`,
      borderRadius: 6, padding: '10px 12px', background: 'var(--surface)',
    }}>
      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>{alert.project}</span>
          {badge && (
            <span style={{
              fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
              color: badge.color, border: `1px solid ${badge.color}`, borderRadius: 3,
              padding: '0 4px', whiteSpace: 'nowrap',
            }}>
              {badge.label}
            </span>
          )}
          <span style={{ fontSize: 12, color: 'var(--text)', wordBreak: 'break-word' }}>{alert.title}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
          {alert.detail}
          {age ? `${alert.detail ? ' · ' : ''}${age}` : ''}
        </div>
        {enableError && (
          <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 4 }}>
            Could not enable: {enableError}
          </div>
        )}
      </div>

      {/* Enabling happens server-side through the gh credential rather than by
          linking to GitHub's settings page — on a private repo that link 404s
          for any browser session that is not signed in, which is impossible to
          tell apart from a dead link. */}
      {isSetupRow ? (
        <button
          onClick={onEnable}
          disabled={busy}
          style={{
            flexShrink: 0, fontSize: 11, color: 'var(--text-dim)',
            border: '1px solid var(--border)', borderRadius: 4, padding: '3px 8px',
            fontFamily: 'var(--mono)', background: 'transparent',
            cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? 'enabling…' : 'enable'}
        </button>
      ) : href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          style={{
            flexShrink: 0, fontSize: 11, color: 'var(--text-dim)', textDecoration: 'none',
            border: '1px solid var(--border)', borderRadius: 4, padding: '3px 8px',
            fontFamily: 'var(--mono)', whiteSpace: 'nowrap',
          }}
        >
          {hrefLabel}
        </a>
      ) : null}
    </div>
  )
}
