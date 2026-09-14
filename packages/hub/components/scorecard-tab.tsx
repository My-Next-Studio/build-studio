'use client'

import { useCallback, useEffect, useState } from 'react'

// Cross-project agent scorecard.
//
// Grouped BY ROLE rather than by project, because the comparison is the whole
// point: the same role's rows side by side is what separates "this model is
// weak here" from "this project's command file is stale". A per-project listing
// would be the same data arranged so the question cannot be asked.
//
// Roles present in only one project are shown separately and last — real data,
// but nothing to compare them against yet.

interface Row {
  project: string
  role: string
  step: string
  agents: number
  errored: number
  runs: number
  tokens: { in: number; out: number; cacheRead: number; cacheCreate: number }
  costUSD: number
  pricedAgents: number
  unpricedAgents: number
  unmeasuredAgents: number
  findings: { blocking: number; medium: number; low: number }
  verdicts: number
  roundsToConverge: number | null
  medianDurationMs: number | null
  clis: string[]
  models: string[]
}

interface Payload {
  rows: Row[]
  comparableRoles: { role: string; projects: string[] }[]
  unreachable: string[]
  seededFromSnapshots: number
  usageTrustedFrom: string | null
  projects: number
}

const n = (v: number) => v.toLocaleString()
// Model ids share a prefix that carries no information in a column this narrow,
// and the part that distinguishes them is the tail. The full id stays in the
// title, so nothing is actually lost.
const shortModel = (m: string) => m.replace(/^claude-/, '')

const dur = (ms: number | null) => {
  if (!ms && ms !== 0) return '—'
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${s}s`
}

const TH: React.CSSProperties = {
  textAlign: 'left', padding: '4px 8px', fontSize: 9, fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-dim)',
  borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap',
}
const TD: React.CSSProperties = {
  padding: '4px 8px', fontSize: 11, color: 'var(--text)', whiteSpace: 'nowrap',
  borderBottom: '1px solid rgba(120,120,140,0.12)',
}

function RoleTable({ role, rows }: { role: string; rows: Row[] }) {
  // Sorted by the term that dominates this workload — a measured run showed a
  // ~200:1 cache-read-to-output ratio, so ordering by anything else buries the
  // row worth looking at.
  const sorted = [...rows].sort((a, b) => b.tokens.cacheRead - a.tokens.cacheRead)
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 11, fontWeight: 700, color: 'var(--accent)',
        marginBottom: 6,
      }}>
        {role}
        <span style={{ color: 'var(--muted)', fontWeight: 400 }}>
          {' '}· {new Set(rows.map(r => r.project)).size} project(s)
        </span>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: 'var(--mono)' }}>
          <thead>
            <tr>
              <th style={TH}>project</th>
              <th style={TH}>step</th>
              <th style={{ ...TH, textAlign: 'right' }}>runs</th>
              <th style={{ ...TH, textAlign: 'right' }}>agents</th>
              <th style={{ ...TH, textAlign: 'right' }}>err</th>
              <th style={{ ...TH, textAlign: 'right' }}>rounds</th>
              <th style={{ ...TH, textAlign: 'right' }}>median</th>
              <th style={{ ...TH, textAlign: 'right' }}>cache read</th>
              <th style={{ ...TH, textAlign: 'right' }}>output</th>
              <th style={{ ...TH, textAlign: 'right' }}>cost</th>
              <th style={{ ...TH, textAlign: 'right' }}>blocking</th>
              <th style={TH}>model</th>
              <th style={TH}>cli</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => {
              // Coverage is shown next to cost, never folded into it. A row
              // whose agents were mostly unmeasured looks cheap otherwise, and
              // reads as a well-behaved role rather than an invisible one.
              const gaps = r.unpricedAgents + r.unmeasuredAgents
              return (
                <tr key={`${r.project}|${r.step}`}>
                  <td style={{ ...TD, color: 'var(--text-dim)' }}>{r.project}</td>
                  <td style={{ ...TD, color: 'var(--muted)' }}>{r.step}</td>
                  <td style={{ ...TD, textAlign: 'right' }}>{r.runs}</td>
                  <td style={{ ...TD, textAlign: 'right' }}>{r.agents}</td>
                  <td style={{ ...TD, textAlign: 'right', color: r.errored ? 'var(--red)' : 'var(--muted)' }}>{r.errored || '—'}</td>
                  {/*
                    Rounds to converge: the mean, across runs, of how many rounds
                    this role needed to settle. This is the quantity the whole
                    view exists to expose — a role needing 3.8 rounds in one
                    project and 1.5 in another is a configuration difference, and
                    the command file is where it lives.

                    Read it beside `runs`. A mean over three runs moves a long
                    way on one bad run.
                  */}
                  <td
                    style={{ ...TD, textAlign: 'right', color: (r.roundsToConverge ?? 0) >= 3 ? 'var(--orange)' : 'var(--text)' }}
                    title={r.roundsToConverge == null
                      ? 'No run recorded a round for this role.'
                      : `Mean rounds to settle, over ${r.runs} run(s).`
                        + ' For a step where several roles run together in the same round — a review round —'
                        + ' every role shares the round number, so the figure separates projects rather than roles.'}
                  >
                    {r.roundsToConverge == null ? '—' : r.roundsToConverge.toFixed(1)}
                  </td>
                  <td style={{ ...TD, textAlign: 'right', color: 'var(--text-dim)' }}>{dur(r.medianDurationMs)}</td>
                  <td style={{ ...TD, textAlign: 'right' }}>{r.tokens.cacheRead ? n(r.tokens.cacheRead) : '—'}</td>
                  <td style={{ ...TD, textAlign: 'right', color: 'var(--text-dim)' }}>{r.tokens.out ? n(r.tokens.out) : '—'}</td>
                  <td style={{ ...TD, textAlign: 'right' }}>
                    {r.pricedAgents ? `$${r.costUSD.toFixed(2)}` : <span style={{ color: 'var(--muted)' }}>—</span>}
                    {gaps > 0 && (
                      <span
                        style={{ color: 'var(--orange)', marginLeft: 4 }}
                        title={`${r.unpricedAgents} agent(s) measured but with no rate for their model; ${r.unmeasuredAgents} with no usage recorded (pre-fix runs, or a CLI without telemetry)`}
                      >
                        ({gaps} gap{gaps === 1 ? '' : 's'})
                      </span>
                    )}
                  </td>
                  <td style={{ ...TD, textAlign: 'right', color: r.findings.blocking ? 'var(--red)' : 'var(--muted)' }}>
                    {r.verdicts ? r.findings.blocking : '—'}
                  </td>
                  {/*
                    The model is the first thing that explains a cost difference
                    between two otherwise-matching rows, and it was the one field
                    collected but never shown. A row listing more than one model
                    is also the row whose averages span different models — worth
                    seeing before drawing a conclusion from them.
                  */}
                  <td
                    style={{ ...TD, color: r.models.length > 1 ? 'var(--text-dim)' : 'var(--muted)' }}
                    title={r.models.length > 1
                      ? `Mixed across this row's agents: ${r.models.join(', ')} — the averages here span different models.`
                      : r.models.join(', ') || undefined}
                  >
                    {r.models.length ? r.models.map(shortModel).join(', ') : '—'}
                  </td>
                  <td style={{ ...TD, color: 'var(--muted)' }}>{r.clis.join(', ') || '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function ScorecardTab() {
  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (seed = false) => {
    setLoading(true); setError(null)
    try {
      const res = await fetch(`/api/scorecard${seed ? '?seed=1' : ''}`)
      const body = await res.json()
      if (body.error) setError(String(body.error))
      else setData(body)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  if (loading && !data) return <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--text-dim)', padding: 16 }}>Loading…</div>
  if (error) return <div style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--red)', padding: 16 }}>{error}</div>
  if (!data) return null

  const comparable = new Set(data.comparableRoles.map(c => c.role))
  const rolesWithData = [...new Set(data.rows.map(r => r.role))]
  const compared = data.comparableRoles.map(c => c.role)
  const singles = rolesWithData.filter(r => !comparable.has(r)).sort()

  return (
    // Own scroll container, matching monitor-tab and model-tab. The app shell is
    // `h-screen … overflow-hidden` all the way down to <main>, so the page never
    // scrolls on its own — a tab that does not carry its own `overflow` is simply
    // clipped at the fold, and the rows below it cannot be reached at all. This
    // one had `padding` only, which is invisible until the table outgrows the
    // viewport, i.e. exactly when the data becomes worth reading.
    <div style={{ padding: '20px 32px', overflow: 'auto', height: 'calc(100vh - 124px)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
        <div style={{ fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.1em', color: 'var(--text-dim)' }}>
          Agent scorecard
        </div>
        <button onClick={() => void load()} className="wf-btn secondary" style={{ fontSize: 10, padding: '3px 8px' }}>Refresh</button>
        <button
          onClick={() => void load(true)}
          className="wf-btn secondary"
          style={{ fontSize: 10, padding: '3px 8px' }}
          title="Back-fill from surviving snapshots. Partial by nature: snapshots keep only the last ten files per project, so one multi-step run can have evicted every earlier one."
        >
          Seed from snapshots
        </button>
      </div>

      <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 14, maxWidth: 760 }}>
        One row per role, step and project, from each project&apos;s own record of completed runs.
        The point is the <span style={{ color: 'var(--text-dim)' }}>comparison across projects</span> —
        a role that needs more rounds or more cache reads in one project than another is a
        configuration difference, and the command file is where it lives.
        {data.usageTrustedFrom && (
          <> Usage recorded before {data.usageTrustedFrom.slice(0, 10)} is counted as unmeasured, not as zero — the
            attribution then was wrong by up to 4.3×.</>
        )}
      </div>

      {data.unreachable.length > 0 && (
        <div style={{
          marginBottom: 14, padding: '6px 10px', borderRadius: 4,
          background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.3)',
          fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--orange)',
        }}>
          {data.unreachable.length} project(s) unreachable — totals below exclude them: {data.unreachable.join(', ')}
        </div>
      )}

      {data.rows.length === 0 ? (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text-dim)', lineHeight: 1.7, maxWidth: 640 }}>
          Nothing recorded yet. Each project appends to its own log when a run completes, so this
          fills in from the next completed run onward rather than showing history.
          <br />
          <span style={{ color: 'var(--muted)' }}>
            Seed from snapshots back-fills whatever survives, but snapshots keep only the last ten
            files per project — one multi-step run can have evicted every earlier one.
          </span>
        </div>
      ) : (
        <>
          {compared.map((role) => (
            <RoleTable key={role} role={role} rows={data.rows.filter(r => r.role === role)} />
          ))}
          {singles.length > 0 && (
            <>
              <div style={{ fontFamily: 'var(--mono)', fontSize: 10, color: 'var(--muted)', margin: '18px 0 8px', paddingTop: 12, borderTop: '1px solid var(--border)' }}>
                Seen in one project only — real data, but nothing to compare against yet.
              </div>
              {singles.map((role) => (
                <RoleTable key={role} role={role} rows={data.rows.filter(r => r.role === role)} />
              ))}
            </>
          )}
        </>
      )}
    </div>
  )
}
