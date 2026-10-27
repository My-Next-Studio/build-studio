'use client'

import { useCallback, useEffect, useState } from 'react'
import { useProjectApi } from '@/lib/use-project-api'

/**
 * CI runtime per workflow on the default branch, and the drift notice.
 * Server side: project-server lib/ci-runtime.js; design in
 * docs/plans/test-suite-drift.md.
 */

interface GrownStep { step: string; beforeSeconds: number; nowSeconds: number; deltaSeconds: number }
interface RuntimeFlag {
  baselineSeconds: number
  latestSeconds: number
  overPct: number
  since: { id: number; createdAt: string; sha: string | null; title: string | null }
  grownSteps: GrownStep[]
}
interface RuntimeWorkflow {
  name: string
  state: 'no-data' | 'quiet' | 'ok' | 'over'
  runs: number
  medianSeconds: number | null
  latest: { id: number; createdAt: string; seconds: number; url: string | null } | null
  marker: { at: string; reason: string } | null
  flag: RuntimeFlag | null
}
/** The maintenance pass on record — project-server lib/ci-maintenance.js. */
interface MaintenancePass {
  state: 'running' | 'filed' | 'done' | 'error' | 'lost'
  workflow: string
  startedAt: string
  itemId?: string
  title?: string
  doneAt?: string
  error?: string
}
interface CiRuntime {
  configured: boolean
  workflows: RuntimeWorkflow[]
  budget?: { threshold: number }
  maintenance?: MaintenancePass | null
  error?: string | null
}

function fmtRunner(secs: number | null | undefined): string {
  if (secs == null) return '—'
  const s = Math.round(secs)
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  if (h) return `${h}h${String(m).padStart(2, '0')}`
  if (m) return `${m} min`
  return `${s}s`
}

function fmtDay(iso: string): string {
  const d = new Date(iso)
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** "gates › Run scripts/gates/lighthouse dist" → the step, which is what reads. */
function stepLabel(key: string): string {
  const i = key.indexOf(' › ')
  return i === -1 ? key : key.slice(i + 3)
}

function MaintenanceLine({ pass }: { pass: MaintenancePass }) {
  const color = pass.state === 'error' || pass.state === 'lost' ? 'var(--red)' : pass.state === 'done' ? 'var(--green)' : 'var(--text-dim)'
  let text: React.ReactNode
  if (pass.state === 'running') {
    text = <>Maintenance pass for {pass.workflow}: analysing the suite (started {fmtDay(pass.startedAt)}). Its proposals are filed as a backlog item when it finishes.</>
  } else if (pass.state === 'filed') {
    text = <>Maintenance pass filed as <b>{pass.itemId}</b>{pass.title ? ` — ${pass.title}` : ''}. Open it in the Backlog and click Draft to turn it into a PRD. The baseline restarts when it is implemented.</>
  } else if (pass.state === 'done') {
    text = <>{pass.itemId} was implemented: the CI runtime baseline restarted on {fmtDay(pass.doneAt || pass.startedAt)}. The next runs set the new size.</>
  } else {
    text = <>Maintenance pass for {pass.workflow} failed: {pass.error || 'unknown error'}. Start it again from the notice.</>
  }
  return (
    <div style={{
      fontFamily: 'var(--mono)', fontSize: 10, color, padding: '8px 12px',
      border: '1px solid var(--border)', borderRadius: 6, background: 'var(--surface)',
    }}>
      {text}
    </div>
  )
}

export function CiRuntimePanel() {
  const api = useProjectApi()
  const [data, setData] = useState<CiRuntime | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    api.get('/ci-runtime').then((d: CiRuntime) => setData(d)).catch(() => {})
  }, [api])

  useEffect(() => {
    load()
    const id = setInterval(load, 60000)
    return () => clearInterval(id)
  }, [load])

  const act = async (path: '/ci-runtime/accept' | '/ci-runtime/maintenance', workflow: string) => {
    setBusy(`${path}:${workflow}`)
    setError(null)
    try {
      const d = await api.post(path, { workflow })
      if (d && d.error) setError(d.error)
      else if (d) setData(d)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  if (!data || !data.configured || data.workflows.length === 0) return null
  const pct = Math.round((data.budget?.threshold ?? 0.1) * 100)
  const over = data.workflows.filter(w => w.flag)
  const pass = data.maintenance || null
  // One pass at a time: a running or filed one has to finish first.
  const passOpen = pass?.state === 'running' || pass?.state === 'filed'

  return (
    <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      {over.map(w => {
        const f = w.flag!
        return (
          <div key={w.name} style={{
            padding: '12px 16px', borderRadius: 8,
            background: 'var(--surface)', border: '1px solid var(--orange)',
            fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text)',
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <div>
              <span style={{ color: 'var(--orange)', fontWeight: 700 }}>{w.name}</span>
              {' '}CI is {f.overPct}% over its baseline ({fmtRunner(f.latestSeconds)} of runner time against {fmtRunner(f.baselineSeconds)}),
              since the push of {fmtDay(f.since.createdAt)}{f.since.title ? <span style={{ color: 'var(--muted)' }}> — {f.since.title}</span> : null}.
            </div>
            {f.grownSteps.length > 0 && (
              <div style={{ color: 'var(--text-dim)', fontSize: 10, display: 'flex', flexDirection: 'column', gap: 2 }}>
                {f.grownSteps.map(s => (
                  <span key={s.step}>
                    +{fmtRunner(s.deltaSeconds)} <span style={{ color: 'var(--muted)' }}>{stepLabel(s.step)}</span>
                    {' '}({fmtRunner(s.beforeSeconds)} → {fmtRunner(s.nowSeconds)})
                  </span>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {!passOpen && (
                <button
                  onClick={() => act('/ci-runtime/maintenance', w.name)}
                  disabled={busy !== null}
                  title="One agent analyses the suite and files its proposals as a backlog item. Draft it into a PRD, which then runs through the normal pipeline."
                  style={{
                    padding: '4px 12px', borderRadius: 4, border: 'none', background: 'var(--accent)', color: '#fff',
                    fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 600,
                    cursor: busy !== null ? 'default' : 'pointer',
                  }}
                >
                  {busy === `/ci-runtime/maintenance:${w.name}` ? 'Starting…' : 'Start a maintenance pass'}
                </button>
              )}
              <button
                onClick={() => act('/ci-runtime/accept', w.name)}
                disabled={busy !== null}
                title="The growth is intended: start a new baseline from this run."
                style={{
                  padding: '4px 12px', borderRadius: 4, border: '1px solid var(--border)', background: 'transparent',
                  color: 'var(--text-dim)', fontFamily: 'var(--mono)', fontSize: 10,
                  cursor: busy !== null ? 'default' : 'pointer',
                }}
              >
                {busy === `/ci-runtime/accept:${w.name}` ? 'Accepting…' : 'Accept the new size'}
              </button>
            </div>
          </div>
        )
      })}

      {/* A finished pass is news for a couple of weeks, then noise. */}
      {pass && (pass.state !== 'done' || Date.now() - Date.parse(pass.doneAt || '') < 14 * 86400000) && (
        <MaintenanceLine pass={pass} />
      )}

      {error && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--red)' }}>{error}</div>
      )}

      <div style={{
        background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden',
      }}>
        <div style={{
          padding: '8px 16px', fontFamily: 'var(--mono)', fontSize: 9, color: 'var(--muted)',
          borderBottom: '1px solid var(--border)', display: 'flex', gap: 10,
        }}>
          <span style={{ flex: 1 }}>Runner time, successful pushes to the default branch</span>
          <span style={{ width: 70, textAlign: 'right' }}>median</span>
          <span style={{ width: 70, textAlign: 'right' }}>latest</span>
          <span style={{ width: 90, textAlign: 'right' }}>budget +{pct}%</span>
        </div>
        {data.workflows.map((w, i) => (
          <div key={w.name} style={{
            padding: '6px 16px', display: 'flex', gap: 10, alignItems: 'baseline',
            borderTop: i > 0 ? '1px solid var(--border-subtle)' : undefined,
            fontFamily: 'var(--mono)', fontSize: 10,
          }}>
            <span style={{ flex: 1, color: 'var(--text-dim)' }}>
              {w.name}
              {w.marker && (
                <span style={{ color: 'var(--muted)', fontSize: 9 }}>
                  {' '}· baseline from {fmtDay(w.marker.at)} ({w.marker.reason})
                </span>
              )}
            </span>
            <span style={{ width: 70, textAlign: 'right', color: 'var(--muted)' }}>{fmtRunner(w.medianSeconds)}</span>
            <span style={{ width: 70, textAlign: 'right', color: 'var(--muted)' }}>{fmtRunner(w.latest?.seconds)}</span>
            <span style={{
              width: 90, textAlign: 'right',
              color: w.state === 'over' ? 'var(--orange)' : w.state === 'ok' ? 'var(--green)' : 'var(--muted)',
            }}>
              {w.state === 'over' ? `${w.flag?.overPct}% over` : w.state === 'ok' ? 'within' : `${w.runs} run${w.runs === 1 ? '' : 's'}, too few`}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
