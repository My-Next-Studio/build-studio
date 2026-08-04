'use client'

import { useEffect, useState } from 'react'

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

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      try {
        const res = await fetch('/api/monitor')
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json()
        if (cancelled) return
        setAlerts(Array.isArray(data.alerts) ? data.alerts : [])
        setProjects(Array.isArray(data.projects) ? data.projects : [])
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoaded(true)
      }
    }
    poll()
    // 30s is generous: the project-servers serve these from cache and only talk
    // to GitHub on their own backoff, so the tab's cadence costs nothing.
    const interval = setInterval(poll, 30000)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  const actionable = alerts.filter((a) => a.severity !== 'info')
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
          {actionable.length === 0 ? 'nothing to handle' : `${actionable.length} open`}
        </div>
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
              <AlertRow key={`${a.project}:${a.id}`} alert={a} color={style.color} />
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

function AlertRow({ alert, color }: { alert: Alert; color: string }) {
  // "Not enabled" is information about a blind spot, not a fault — it gets the
  // muted treatment and an action that fixes the blind spot rather than a link
  // to a problem that does not exist.
  const isNotEnabled = alert.kind === 'not-enabled'
  const age = since(alert.since)
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 12,
      border: '1px solid var(--border)', borderLeft: `2px solid ${color}`,
      borderRadius: 6, padding: '10px 12px', background: 'var(--surface)',
    }}>
      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>{alert.project}</span>
          <span style={{ fontSize: 12, color: 'var(--text)', wordBreak: 'break-word' }}>{alert.title}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 3 }}>
          {alert.detail}
          {age ? `${alert.detail ? ' · ' : ''}${age}` : ''}
        </div>
      </div>
      {alert.url && (
        <a
          href={alert.url}
          target="_blank"
          rel="noreferrer"
          style={{
            flexShrink: 0, fontSize: 11, color: 'var(--text-dim)', textDecoration: 'none',
            border: '1px solid var(--border)', borderRadius: 4, padding: '3px 8px',
            fontFamily: 'var(--mono)',
          }}
        >
          {isNotEnabled ? 'enable ↗' : 'open ↗'}
        </a>
      )}
    </div>
  )
}
